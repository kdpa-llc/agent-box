#!/usr/bin/env node
// box-broker: the login broker. An agent that reaches a sign-in page runs
// `agent-box login <site>`; the user's phone gets a notification, the user fills the
// login in the phone app (app/), and the broker types it into the box. Values live in
// this process's memory only, are used once, and never reach the agent.
// The contract is docs/broker.md. Needs Node 20 or newer, and nothing else.
//
//   box-broker run                   the service: the phone app and /api/* on
//                                    127.0.0.1:$BOX_BROKER_PORT, the agent API on
//                                    $BOX_BROKER_DIR/agent.sock
//   box-broker login <site> [...]    what `agent-box login` runs
//   box-broker status | pair | unpair <id>|--all | test | start | stop | url | doctor | ping
//                                    what `agent-box broker`, `url` and `doctor` run
import { createServer, request as httpRequest } from 'node:http';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicKeyOf, pushAllowed, sendPush, subscriptionKeysOk, vapidKeys } from './box-broker-push.mjs';

if (Number(process.versions.node.split('.')[0]) < 20) {
  console.error('agent-box: the login broker needs Node 20 or newer');
  process.exit(8);
}

const env = process.env;
const HERE = dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const number = (text, fallback) => { const n = Number(text); return text !== undefined && text !== '' && Number.isFinite(n) && n >= 0 ? n : fallback; };

const DIR = resolve(env.BOX_BROKER_DIR || join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'agent-box', 'broker'));
const SOCK = join(DIR, 'agent.sock');
const STATE = join(DIR, 'state.json');
const PIDFILE = join(DIR, 'broker.pid');
const LOGFILE = join(DIR, 'broker.log');
const PORT = Math.trunc(number(env.BOX_BROKER_PORT, 6070));
const CDP = `http://127.0.0.1:${Math.trunc(number(env.BOX_CDP_PORT, 9222))}`;
// Times. The defaults are the contract's; tests shorten them.
const HOLD_MS = number(env.BOX_BROKER_HOLD_SECONDS, 300) * 1000;
const CODE_HOLD_MS = number(env.BOX_BROKER_CODE_HOLD_SECONDS, 120) * 1000;
const REQUEST_MS = number(env.BOX_BROKER_REQUEST_MINUTES, 30) * 60_000;
const PAIR_MS = number(env.BOX_BROKER_PAIR_MINUTES, 10) * 60_000;
const APP_DIR = resolve(env.BOX_BROKER_APP_DIR || join(HERE, 'app'));
const TYPE_CMD = env.BOX_BROKER_TYPE_CMD || join(HERE, 'agent-box');
const BOX_CMD = env.BOX_BROKER_BOX_CMD || join(HERE, 'agent-box');   // `agent-box exec`, for the hold
const PUSH_HOSTS = (env.BOX_BROKER_PUSH_HOSTS || '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
const VERSION = (() => { try { return JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).version; } catch { return '0.0.0'; } })();

const BODY_MAX = 16 * 1024;
const VALUE_MAX = 1024;
const HISTORY_MAX = 200;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const KINDS = ['credentials', 'code', 'handoff'];
const OPEN = ['pending', 'ready'];

const random = (n, alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789') => Array.from({ length: n }, () => alphabet[randomInt(alphabet.length)]).join('');
const sha256 = text => createHash('sha256').update(text).digest();
const sameText = (a, b) => timingSafeEqual(sha256(a), sha256(b));   // constant time, any lengths

// --- sites ---------------------------------------------------------------------

// A host name, lower case, with no leading "www.". The same rule as box-type: two sites
// are the same when equal, or one is a subdomain of the other.
const normHost = host => { const h = String(host || '').trim().toLowerCase().replace(/\.$/, ''); return h.startsWith('www.') ? h.slice(4) : h; };
const sameSite = (a, b) => { a = normHost(a); b = normHost(b); return !!a && !!b && (a === b || a.endsWith('.' + b) || b.endsWith('.' + a)); };
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOST_RE = new RegExp(`^(?=.{1,253}$)${LABEL}(?:\\.${LABEL})+$`);
const validSite = site => site === 'localhost' || HOST_RE.test(site);
const hostOf = url => { try { return new URL(url).hostname; } catch { return ''; } };
// What the agent typed, as a site: "https://www.GitHub.com/login" is github.com.
function siteFrom(input) {
  let text = String(input || '').trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = hostOf(text);
  return normHost(text.split(/[/?#]/)[0].replace(/:\d+$/, ''));
}

// ================================================================================
// The service
// ================================================================================

let state;               // what state.json holds: push keys, phones, history
let rev = 1;             // grows with every change the app should see
let pairing = null;      // { code, expiresAt, tries }; memory only
const requests = [];     // memory only, values included
const waiters = new Set();
const log = (...a) => console.error(new Date().toISOString(), 'agent-box broker:', ...a);

function prepareDir() {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const info = statSync(DIR);
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    console.error(`agent-box: ${DIR} belongs to another user; set BOX_BROKER_DIR to a folder of your own`);
    process.exit(1);
  }
  if ((info.mode & 0o777) !== 0o700) chmodSync(DIR, 0o700);
}

// macOS allows 104 bytes for a socket path, including the closing zero byte.
function checkSocketPath() {
  if (Buffer.byteLength(SOCK) > 103) {
    console.error(`agent-box: the broker's folder path is too long for its socket (${Buffer.byteLength(SOCK)} bytes; at most 103 with "/agent.sock"). Set BOX_BROKER_DIR to a shorter folder.`);
    process.exit(1);
  }
}

function readState() {
  try { return JSON.parse(readFileSync(STATE, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Write a temp file next to it, then rename, so a crash never leaves half a file.
function writeState(data) {
  const tmp = `${STATE}.${process.pid}.tmp`;
  try { unlinkSync(tmp); } catch {}
  const fd = openSync(tmp, 'wx', 0o600);
  try { writeSync(fd, JSON.stringify(data, null, 1) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, STATE);
  chmodSync(STATE, 0o600);
}
const save = () => writeState(state);

function loadState() {
  let data = null;
  try { data = readState(); } catch {
    const aside = `${STATE}.bad-${Date.now()}`;
    renameSync(STATE, aside);
    log(`state.json could not be read; moved it to ${aside} and started fresh`);
  }
  state = { version: 1, vapid: data?.vapid?.d ? data.vapid : vapidKeys(), devices: Array.isArray(data?.devices) ? data.devices : [],
    history: Array.isArray(data?.history) ? data.history.slice(0, HISTORY_MAX) : [] };
  save();
}

function changed() {
  rev++;
  for (const w of [...waiters]) if (w.ready()) w.finish();
}

// Resolves when ready() holds, after ms, or when the asker hangs up. (The response's
// close event, not the request's: a request emits close once its body is read.)
function waitUntil(ready, ms, res) {
  if (ready() || ms <= 0) return Promise.resolve();
  return new Promise(done => {
    const w = { ready, finish: () => { clearTimeout(timer); waiters.delete(w); res.off('close', w.finish); done(); } };
    const timer = setTimeout(w.finish, ms);
    waiters.add(w);
    res.on('close', w.finish);
  });
}

// --- requests ----------------------------------------------------------------

const publicRequest = r => ({ id: r.id, kind: r.kind, site: r.site, page: r.page, agent: r.agent, note: r.note,
  viewerUrl: r.viewerUrl, status: r.status, createdAt: r.createdAt, expiresAt: r.expiresAt });

function dropValues(r) {
  for (const value of Object.values(r.values)) value.fill(0);
  r.values = {};
}

// Every status after ready is final.
function finish(r, status) {
  dropValues(r);
  r.status = status;
  r.endedAt = Date.now();
  state.history.unshift({ id: r.id, kind: r.kind, site: r.site, agent: r.agent, status, at: r.endedAt });
  state.history.length = Math.min(state.history.length, HISTORY_MAX);
  save();
  changed();
}

function sweep() {
  const now = Date.now();
  for (const r of requests) {
    if (r.status === 'pending' && now >= r.expiresAt) finish(r, 'expired');
    else if (r.status === 'ready' && !r.typing && now >= r.holdUntil) finish(r, 'unused');
  }
  // An ended request stays a while, so an agent that wasn't waiting still learns how it ended.
  for (let i = requests.length - 1; i >= 0; i--) {
    if (requests[i].endedAt && now - requests[i].endedAt > Math.max(REQUEST_MS, 60_000)) requests.splice(i, 1);
  }
}

// What the agent sees of a request. A final status, once seen, isn't handed out again.
function forAgent(r) {
  if (!OPEN.includes(r.status)) r.seen = true;
  return { request: publicRequest(r) };
}

class Refusal extends Error {
  constructor(status, code, detail, close = false) { super(detail); this.status = status; this.code = code; this.close = close; }
}
const refuse = (status, code, detail) => { throw new Refusal(status, code, detail); };

const text = (value, most, what) => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') refuse(422, 'invalid', `${what} must be text`);
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (clean.length > most) refuse(422, 'invalid', `${what} is longer than ${most} characters`);
  return clean || null;
};

function viewerUrlOk(value) {
  try {
    const u = new URL(value);
    return value.length <= 500 && (u.protocol === 'https:' || (u.protocol === 'http:' && u.hostname === '127.0.0.1'));
  } catch { return false; }
}

async function boxPages() {
  let list;
  try {
    const response = await fetch(`${CDP}/json/list`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw Error();
    list = await response.json();
    if (!Array.isArray(list)) throw Error();
  } catch { refuse(503, 'box_unreachable', `the box's browser doesn't answer on ${CDP}`); }
  return list.filter(t => t && t.type === 'page' && typeof t.url === 'string');
}

async function createRequest(body) {
  if (!KINDS.includes(body.kind)) refuse(422, 'invalid', 'kind must be credentials, code or handoff');
  const kind = body.kind;
  const site = typeof body.site === 'string' ? normHost(body.site) : '';
  if (!validSite(site)) refuse(422, 'invalid', 'site must be a host name such as github.com');
  const agent = text(body.agent, 60, 'agent');
  const note = text(body.note, 200, 'note');
  if (kind === 'handoff' && !note) refuse(422, 'invalid', 'a handoff needs a note that says what to do');
  let viewerUrl = null;
  if (kind === 'handoff' && body.viewerUrl) {
    if (typeof body.viewerUrl !== 'string' || !viewerUrlOk(body.viewerUrl)) refuse(422, 'invalid', 'viewerUrl must be an https:// address or http://127.0.0.1');
    viewerUrl = body.viewerUrl;
  }
  sweep();
  const mine = requests.filter(r => r.kind === kind && sameSite(r.site, site));
  const open = mine.find(r => OPEN.includes(r.status));
  if (open) return [200, open];
  const unseen = mine.filter(r => !r.seen && ['denied', 'expired', 'done'].includes(r.status)).at(-1);
  if (unseen) return [200, unseen];
  if (!state.devices.length) refuse(409, 'no_device', 'no phone is paired');
  const page = (await boxPages()).find(t => sameSite(hostOf(t.url), site));
  if (!page) refuse(422, 'no_page', `no page in the box is on ${site}`);
  const u = new URL(page.url);
  const now = Date.now();
  const r = { id: `r_${random(8)}`, kind, site, page: { title: String(page.title || '').slice(0, 200), url: (u.origin + u.pathname).slice(0, 500) },
    agent, note, viewerUrl, status: 'pending', createdAt: now, expiresAt: now + REQUEST_MS, values: {} };
  requests.push(r);
  changed();
  pushAll(notice(r), (r.expiresAt - now) / 1000).catch(() => {});
  return [201, r];
}

// --- typing -------------------------------------------------------------------

let typingQueue = Promise.resolve();   // one typing at a time, so a value can't be typed twice

function runTyping(args, value) {
  return new Promise(done => {
    let out = Buffer.alloc(0);
    const child = spawn(TYPE_CMD, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const keep = chunk => { if (out.length < 8192) out = Buffer.concat([out, chunk]); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.stdin.on('error', () => {});
    child.on('error', () => { clearTimeout(timer); done({ exit: 1, message: "agent-box broker: couldn't run the typing command" }); });
    child.on('close', code => {
      clearTimeout(timer);
      // Belt and braces: a typing command must never echo the value.
      const message = out.includes(value) ? 'agent-box broker: the typing command printed the value; its output was dropped' : out.toString('utf8').trim();
      out.fill(0);
      done({ exit: Number.isInteger(code) ? code : 1, message });
    });
    child.stdin.end(value);
  });
}

async function typeValue(body) {
  const field = body.field;
  if (!['username', 'password', 'code'].includes(field)) refuse(422, 'invalid', 'field must be username, password or code');
  const site = typeof body.site === 'string' ? normHost(body.site) : '';
  if (!validSite(site)) refuse(422, 'invalid', 'site must be a host name such as github.com');
  const page = text(body.page, 200, 'page');
  const kind = field === 'code' ? 'code' : 'credentials';
  const enter = field === 'username' ? false : body.enter !== false;
  const run = typingQueue.then(async () => {
    sweep();
    const held = requests.filter(r => r.kind === kind && r.status === 'ready' && sameSite(r.site, site));
    const r = held.find(x => x.site === site) || held.at(-1);
    const value = r?.values[field];
    if (!value || !value.length) {
      refuse(404, 'nothing_held', field === 'username' && r?.values.password ? 'the user sent no username, only a password'
        : `no ${field} is held for ${site}`);
    }
    const args = ['type-stdin', '--kind', field === 'code' ? 'totp' : field, '--url', r.site];
    if (enter) args.push('--enter');
    if (enter && field === 'password') args.push('--clear-after', '3');
    if (page) args.push('--page', page);
    if (body.keyboard === true) args.push('--keyboard');
    r.typing = true;
    let result;
    try { result = await runTyping(args, value); } finally { r.typing = false; }
    if (result.exit === 0 && field !== 'username') { finish(r, 'done'); r.seen = true; }
    return result;
  });
  typingQueue = run.catch(() => {});
  return run;
}

// --- push ---------------------------------------------------------------------

function notice(r) {
  const [title, body] = {
    credentials: ['Sign-in request', `${r.agent || 'An agent'} wants to sign in to ${r.site}`],
    code: ['Code needed', `${r.site} is asking for a code`],
    handoff: ['Your turn', `${r.site}: ${r.note}`],
  }[r.kind];
  return { title, body, tag: r.id, path: `/#/r/${r.id}` };
}

async function pushTo(device, { title, body, tag, path }, ttl) {
  const sub = device.push;
  if (!sub || !pushAllowed(sub.endpoint, PUSH_HOSTS)) return 0;
  const message = { web_push: 8030, notification: { title, body, tag, navigate: sub.origin + path } };
  let status = 0;
  try { status = await sendPush(sub, message, { jwk: state.vapid, ttl }); } catch {}
  if (status === 404 || status === 410) {
    if (device.push === sub) { device.push = null; save(); changed(); }
    log(`the push service no longer knows ${device.id}'s subscription; removed it`);
  } else if (status < 200 || status > 299) log(`push to ${device.id} failed (${status || 'no answer'})`);
  return status;
}

function pushAll(message, ttl) {
  return Promise.all(state.devices.filter(d => d.push).map(d => pushTo(d, message, ttl)));
}

const TEST_NOTICE = { title: 'Agent Box', body: 'Notifications work.', tag: 'test', path: '/' };

// --- HTTP ---------------------------------------------------------------------

const SAFE_HEADERS = { 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const CSP = "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

function reply(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { ...SAFE_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
const replyError = (res, status, error, detail) => reply(res, status, { error, detail });

// The body as JSON, capped before parsing. The raw bytes are zeroed once parsed.
function readJson(req) {
  return new Promise((done, failed) => {
    const tooBig = () => new Refusal(403, 'forbidden', 'the body is over 16 KB', true);
    if (Number(req.headers['content-length'] || 0) > BODY_MAX) return failed(tooBig());
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > BODY_MAX) { chunks.forEach(c => c.fill(0)); req.removeAllListeners('data'); req.resume(); failed(tooBig()); return; }
      chunks.push(chunk);
    });
    req.on('error', failed);
    req.on('end', () => {
      if (size > BODY_MAX) return;
      const raw = Buffer.concat(chunks);
      chunks.forEach(c => c.fill(0));
      try {
        const data = raw.length ? JSON.parse(raw.toString('utf8')) : {};
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error();
        done(data);
      } catch { failed(new Refusal(422, 'invalid', 'the body must be a JSON object')); } finally { raw.fill(0); }
    });
  });
}

function handler(route) {
  return async (req, res) => {
    try { await route(req, res); } catch (error) {
      if (error instanceof Refusal) {
        if (error.close) res.setHeader('Connection', 'close');
        replyError(res, error.status, error.code, error.message);
      } else {
        log(`error on ${req.method} ${req.url.split('?')[0]}: ${error.message}`);
        if (!res.headersSent) replyError(res, 500, 'internal', 'something went wrong in the broker');
      }
    }
  };
}

const query = req => new URL(req.url, 'http://broker').searchParams;
const seconds = (value, most) => Math.min(most, Math.max(0, Math.trunc(Number(value) || 0)));

// --- the agent API (Unix socket) ---------------------------------------------

const agentApi = handler(async (req, res) => {
  const path = req.url.split('?')[0];
  const post = req.method === 'POST';
  const body = post ? await readJson(req) : null;
  let m;
  if (post && path === '/agent/requests') {
    const [status, r] = await createRequest(body);
    return reply(res, status, forAgent(r));
  }
  if (req.method === 'GET' && path === '/agent/requests') {
    const site = normHost(query(req).get('site'));
    sweep();
    return reply(res, 200, { requests: requests.filter(r => OPEN.includes(r.status) && (!site || sameSite(r.site, site))).map(publicRequest) });
  }
  if (req.method === 'GET' && (m = path.match(/^\/agent\/requests\/(r_[a-z0-9]{8})$/))) {
    sweep();
    const r = requests.find(x => x.id === m[1]);
    if (!r) refuse(404, 'not_found', 'no such request');
    await waitUntil(() => r.status !== 'pending', seconds(query(req).get('wait'), 300) * 1000, res);
    return reply(res, 200, forAgent(r));
  }
  if (post && (m = path.match(/^\/agent\/requests\/(r_[a-z0-9]{8})\/cancel$/))) {
    sweep();
    const r = requests.find(x => x.id === m[1]);
    if (!r) refuse(404, 'not_found', 'no such request');
    if (OPEN.includes(r.status)) finish(r, 'cancelled');
    return reply(res, 200, forAgent(r));
  }
  if (post && path === '/agent/type') return reply(res, 200, await typeValue(body));
  if (req.method === 'GET' && path === '/agent/status') {
    sweep();
    return reply(res, 200, { version: VERSION, port: PORT, devices: state.devices.map(d => ({ id: d.id, name: d.name, push: !!d.push, lastSeenAt: d.lastSeenAt })),
      pending: requests.filter(r => r.status === 'pending').length });
  }
  if (post && path === '/agent/pair') {
    pairing = { code: random(8, CODE_ALPHABET), expiresAt: Date.now() + PAIR_MS, tries: 0 };
    return reply(res, 200, { code: pairing.code, expiresAt: pairing.expiresAt });
  }
  if (post && path === '/agent/unpair') {
    const before = state.devices.length;
    if (body.all === true) state.devices = [];
    else if (typeof body.deviceId === 'string') state.devices = state.devices.filter(d => d.id !== body.deviceId);
    else refuse(422, 'invalid', 'give deviceId, or all: true');
    const removed = before - state.devices.length;
    if (removed) { save(); changed(); }
    return reply(res, 200, { removed });
  }
  if (post && path === '/agent/push-test') {
    const results = await pushAll(TEST_NOTICE, 300);
    const sent = results.filter(s => s >= 200 && s <= 299).length;
    return reply(res, 200, { sent, failed: results.length - sent });
  }
  refuse(404, 'not_found', 'no such endpoint');
});

// --- the phone API and the app (TCP) -----------------------------------------

const APP_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.css', ['app.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/sw.js', ['sw.js', 'text/javascript; charset=utf-8']],
  ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json']],
  ['/icon-180.png', ['icon-180.png', 'image/png']],
  ['/icon-192.png', ['icon-192.png', 'image/png']],
  ['/icon-512.png', ['icon-512.png', 'image/png']],
]);

// Only the names above: nothing from the request reaches the file system.
async function serveFile(req, res, path) {
  const file = APP_FILES.get(path);
  if (!file) refuse(404, 'not_found', 'no such file');
  if (req.method !== 'GET' && req.method !== 'HEAD') refuse(405, 'not_allowed', 'use GET');
  let content;
  try { content = await readFile(join(APP_DIR, file[0])); } catch { refuse(404, 'not_found', 'no such file'); }
  const headers = { ...SAFE_HEADERS, 'Content-Type': file[1], 'Content-Length': content.length };
  if (file[1].startsWith('text/html')) headers['Content-Security-Policy'] = CSP;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : content);
}

function deviceFor(req) {
  const m = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(req.headers.authorization || '');
  if (!m) return null;
  const hash = sha256(m[1]);
  let found = null;
  for (const d of state.devices) if (timingSafeEqual(hash, Buffer.from(d.tokenHash, 'hex')) && !found) found = d;
  if (found) {
    const now = Date.now();
    const stale = !found.lastSeenAt || now - found.lastSeenAt > 60_000;
    found.lastSeenAt = now;
    if (stale) save();
  }
  return found;
}

// Same-origin POSTs only, as JSON.
function checkPost(req) {
  const type = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') refuse(403, 'forbidden', 'the body must be sent as application/json');
  const origin = req.headers.origin;
  if (origin !== undefined) {
    let host = null;
    try { host = new URL(origin).host.toLowerCase(); } catch {}
    if (!host || host !== String(req.headers.host || '').toLowerCase()) refuse(403, 'forbidden', 'this origin may not post here');
  }
}

function originOf(req) {
  const origin = req.headers.origin;
  if (origin && origin !== 'null') return new URL(origin).origin;
  const https = req.headers['x-forwarded-proto'] === 'https';
  return `${https ? 'https' : 'http'}://${req.headers.host || `127.0.0.1:${PORT}`}`;
}

function phoneState(device) {
  return { rev, version: VERSION, device: { id: device.id, name: device.name },
    push: { publicKey: publicKeyOf(state.vapid), subscribed: !!device.push },
    requests: requests.filter(r => r.status === 'pending').sort((a, b) => a.createdAt - b.createdAt).map(publicRequest),
    history: state.history.slice(0, 30) };
}

function answer(r, body) {
  const value = (v, what, empty) => {
    if (v === undefined && empty) v = '';
    if (typeof v !== 'string') refuse(422, 'invalid', `${what} must be text`);
    if (!v && !empty) refuse(422, 'invalid', `${what} must not be empty`);
    if (v.length > VALUE_MAX) refuse(422, 'invalid', `${what} is longer than ${VALUE_MAX} characters`);
    return Buffer.from(v, 'utf8');
  };
  if (r.kind === 'credentials') {
    const password = value(body.password, 'password', false);
    const username = value(body.username, 'username', true);
    r.values = { username, password };
    r.holdUntil = Date.now() + HOLD_MS;
    r.status = 'ready';
    changed();
  } else if (r.kind === 'code') {
    r.values = { code: value(body.code, 'code', false) };
    r.holdUntil = Date.now() + CODE_HOLD_MS;
    r.status = 'ready';
    changed();
  } else finish(r, 'done');
}

const phoneApi = handler(async (req, res) => {
  const path = req.url.split('?')[0];
  if (!path.startsWith('/api/')) return serveFile(req, res, path);
  const post = req.method === 'POST';
  if (post) checkPost(req);
  const body = post ? await readJson(req) : null;
  let m;
  if (post && path === '/api/pair') {
    const name = text(body.name, 40, 'name') || 'Phone';
    const now = Date.now();
    if (pairing && pairing.tries >= 5) refuse(429, 'too_many_tries', 'too many wrong codes; make a new one with agent-box broker pair');
    const given = typeof body.code === 'string' ? body.code.replace(/\s+/g, '').toUpperCase() : '';
    const live = pairing && now < pairing.expiresAt;
    if (!live || !sameText(given, pairing.code)) {
      if (live) pairing.tries++;
      refuse(403, 'bad_code', 'that code is wrong or has expired');
    }
    pairing = null;
    const token = randomBytes(32).toString('base64url');
    const device = { id: `d_${random(8)}`, name, tokenHash: sha256(token).toString('hex'), createdAt: now, lastSeenAt: now, push: null };
    state.devices.push(device);
    save();
    changed();
    return reply(res, 200, { deviceId: device.id, token });
  }
  const device = deviceFor(req);
  if (!device) refuse(401, 'unauthorized', 'pair this phone first');
  sweep();
  if (req.method === 'GET' && path === '/api/state') {
    const q = query(req);
    if (q.has('since')) {
      const since = Math.trunc(Number(q.get('since')) || 0);
      // A since above rev means the broker restarted: answer at once.
      await waitUntil(() => rev !== since, seconds(q.get('wait'), 25) * 1000, res);
    }
    return reply(res, 200, phoneState(device));
  }
  if (post && (m = path.match(/^\/api\/requests\/(r_[a-z0-9]{8})\/(answer|deny)$/))) {
    const r = requests.find(x => x.id === m[1]);
    if (!r) refuse(404, 'not_found', 'no such request');
    if (r.status !== 'pending') refuse(409, 'not_pending', `this request is ${r.status}`);
    if (m[2] === 'deny') finish(r, 'denied');
    else answer(r, body);
    return reply(res, 200, { ok: true });
  }
  if (post && path === '/api/push/subscribe') {
    const sub = body.subscription;
    if (!sub || typeof sub.endpoint !== 'string' || sub.endpoint.length > 2048 || !pushAllowed(sub.endpoint, PUSH_HOSTS)) {
      refuse(422, 'invalid', 'the subscription must be on a known push service');
    }
    if (!subscriptionKeysOk(sub.keys)) refuse(422, 'invalid', 'the subscription keys are not valid');
    device.push = { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, origin: originOf(req) };
    save();
    changed();
    return reply(res, 200, { ok: true });
  }
  if (post && path === '/api/push/unsubscribe') {
    if (device.push) { device.push = null; save(); changed(); }
    return reply(res, 200, { ok: true });
  }
  if (post && path === '/api/push/test') {
    if (!device.push) refuse(409, 'not_subscribed', 'notifications are off on this phone');
    const status = await pushTo(device, TEST_NOTICE, 300);
    if (status < 200 || status > 299) refuse(502, 'push_failed', `the push service answered ${status || 'nothing'}`);
    return reply(res, 200, { ok: true });
  }
  if (post && path === '/api/unpair') {
    state.devices = state.devices.filter(d => d !== device);
    save();
    changed();
    return reply(res, 200, { ok: true });
  }
  refuse(404, 'not_found', 'no such endpoint');
});

async function runService() {
  checkSocketPath();
  prepareDir();
  if (await agentCall('GET', '/agent/status').then(() => true, () => false)) {
    console.error(`agent-box: a broker already runs on ${SOCK}`);
    process.exit(1);
  }
  try { unlinkSync(SOCK); } catch {}
  loadState();
  const agentServer = createServer(agentApi);
  const phoneServer = createServer(phoneApi);
  for (const [server, where] of [[agentServer, SOCK], [phoneServer, `127.0.0.1:${PORT}`]]) {
    server.on('error', error => {
      console.error(`agent-box: the broker can't listen on ${where} (${error.code === 'EADDRINUSE' ? 'something else uses it' : error.message})`);
      process.exit(1);
    });
  }
  const umask = process.umask(0o177);   // the socket is created 600
  try { agentServer.listen(SOCK); } finally { process.umask(umask); }
  await new Promise(r => agentServer.once('listening', r));
  chmodSync(SOCK, 0o600);
  phoneServer.listen(PORT, '127.0.0.1');
  await new Promise(r => phoneServer.once('listening', r));
  const fd = openSync(PIDFILE, 'w', 0o600);
  writeSync(fd, `${process.pid}\n`);
  closeSync(fd);
  const ticker = setInterval(sweep, 250);
  const shutdown = () => {
    clearInterval(ticker);
    for (const r of requests) dropValues(r);
    for (const server of [agentServer, phoneServer]) { server.close(); server.closeAllConnections(); }
    try { unlinkSync(SOCK); } catch {}
    try { if (readFileSync(PIDFILE, 'utf8').trim() === String(process.pid)) unlinkSync(PIDFILE); } catch {}
    process.exit(0);
  };
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, shutdown);
  log(`${VERSION} on http://127.0.0.1:${PORT}/ (phone app) and ${SOCK} (agents); ${state.devices.length} phone(s) paired`);
}

// ================================================================================
// The client: what `agent-box login` and `agent-box broker` run
// ================================================================================

function agentCall(method, path, body) {
  return new Promise((done, failed) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = httpRequest({ socketPath: SOCK, method, path,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {} }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
        done({ status: res.statusCode, data: parsed });
      });
    });
    req.on('error', failed);
    req.end(data);
  });
}

const say = line => console.log(`agent-box: ${line}`);
const warn = line => console.error(`agent-box: ${line}`);
const stop = (code, line) => { (code === 0 ? say : warn)(line); process.exit(code); };
const running = () => agentCall('GET', '/agent/status').then(r => r.status === 200 ? r.data : null, () => null);
const pairedPhones = () => { try { return readState()?.devices?.length || 0; } catch { return 0; } };
const appUrl = () => env.BOX_BROKER_APP_URL || `http://127.0.0.1:${PORT}/`;
// Where the phone opens the app: the published address, or where it will be once published.
const phoneUrl = () => env.BOX_BROKER_APP_URL || (env.BOX_BROKER_TAILNET_HOST ? `https://${env.BOX_BROKER_TAILNET_HOST}:8444/` : "this machine's Tailscale address on port 8444");
const serveCommand = () => `${env.BOX_BROKER_TS || 'tailscale'} serve --bg --https=8444 http://127.0.0.1:${PORT}`;
const minutes = ms => { const m = Math.max(1, Math.round(ms / 60_000)); return `${m} minute${m === 1 ? '' : 's'}`; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Start the service in the background, as `agent-box login` does when a phone is paired.
async function startInBackground() {
  checkSocketPath();
  prepareDir();
  const out = openSync(LOGFILE, 'a', 0o600);
  spawn(process.execPath, [SELF, 'run'], { detached: true, stdio: ['ignore', out, out], env }).unref();
  closeSync(out);
  for (let i = 0; i < 50; i++) {
    await sleep(100);
    if (await running()) return true;
  }
  return false;
}

const NO_PHONE = 'no phone is paired with the login broker, so the user can\'t be asked this way. Use another way to sign in (see the agent-box skill).';

async function needBroker() {
  checkSocketPath();
  if (await running()) return;
  if (!pairedPhones()) stop(8, NO_PHONE);
  if (!await startInBackground()) stop(8, `the login broker didn't start (see ${LOGFILE}). Use another way to sign in.`);
}

// Keep the box awake until the request ends; never shorten a longer hold. Same file as `agent-box hold`.
function holdBox(until) {
  const script = 'u=$1; h=$(cat /tmp/box-hold-until 2>/dev/null || echo 0); case $h in ""|*[!0-9]*) h=0 ;; esac; ' +
    'if [ "$u" -gt "$h" ]; then echo "$u" > /tmp/box-hold-until; fi';
  spawnSync(BOX_CMD, ['exec', 'sh', '-c', script, 'sh', String(Math.ceil(until / 1000))], { stdio: 'ignore', timeout: 20_000 });
}

function parseLogin(argv) {
  const o = { site: null, mode: 'credentials', as: env.AGENT_BOX_AS || null, wait: 100, enter: true, page: null, keyboard: false, note: null };
  const modes = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], value = () => { const v = argv[++i]; if (v === undefined) stop(2, `${a} needs a value`); return v; };
    if (a === '--username') modes.push('username');
    else if (a === '--password') modes.push('password');
    else if (a === '--code') modes.push('code');
    else if (a === '--cancel') modes.push('cancel');
    else if (a === '--human') { modes.push('handoff'); o.note = value(); }
    else if (a === '--as') o.as = value();
    else if (a === '--wait') o.wait = value();
    else if (a === '--no-enter') o.enter = false;
    else if (a === '--page') o.page = value();
    else if (a === '--keyboard') o.keyboard = true;
    else if (a.startsWith('-')) stop(2, `unknown option ${a}`);
    else if (o.site === null) o.site = a;
    else stop(2, 'give one site, such as github.com');
  }
  if (modes.length > 1) stop(2, 'use one of --username, --password, --code, --human and --cancel');
  if (modes.length) o.mode = modes[0];
  if (!o.site) stop(2, LOGIN_USAGE);
  o.site = siteFrom(o.site);
  if (!validSite(o.site)) stop(2, `"${o.site}" isn't a site; give its host name, such as github.com`);
  if (!/^\d+$/.test(String(o.wait)) || Number(o.wait) > 300) stop(2, '--wait is a number of seconds from 0 to 300');
  o.wait = Number(o.wait);
  if (o.as) o.as = o.as.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 60) || null;
  if (o.note !== null && !o.note.trim()) stop(2, '--human needs what the user should do, in quotes');
  if (o.note && o.note.length > 200) stop(2, '--human takes at most 200 characters');
  return o;
}

const LOGIN_USAGE = `usage: agent-box login <site> [--as <label>] [--wait <seconds>]
       agent-box login <site> --username [--page <text>]
       agent-box login <site> --password [--no-enter] [--page <text>] [--keyboard]
       agent-box login <site> --code [--no-enter] [--as <label>] [--wait <seconds>] [--page <text>]
       agent-box login <site> --human "<what to do>" [--as <label>] [--wait <seconds>]
       agent-box login <site> --cancel`;

// Ask for something and wait for the answer. Returns the request once it isn't pending.
async function ask(o, kind) {
  const { status, data } = await agentCall('POST', '/agent/requests', { kind, site: o.site, agent: o.as,
    ...(kind === 'handoff' ? { note: o.note, viewerUrl: env.BOX_BROKER_VIEWER_URL || null } : {}) });
  if (status >= 400) {
    if (data.error === 'no_device') stop(8, NO_PHONE);
    if (data.error === 'no_page') stop(5, `no page in the box is on ${o.site}. Open the sign-in page first, then run this again.`);
    if (data.error === 'box_unreachable') stop(5, `the box's browser doesn't answer. Run agent-box up, open the sign-in page, then run this again.`);
    stop(data.error === 'invalid' ? 2 : 1, data.detail || `the broker answered ${status}`);
  }
  let r = data.request;
  if (OPEN.includes(r.status)) holdBox(Math.max(r.expiresAt, Date.now()));
  if (status === 201) warn(`asked the user on their phone; waiting up to ${o.wait} s for the answer.`);
  if (r.status === 'pending' && o.wait > 0) {
    const got = await agentCall('GET', `/agent/requests/${r.id}?wait=${o.wait}`);
    if (got.status === 200) r = got.data.request;
  }
  return r;
}

// Every way a request can end, as the agent hears it. Returns only for ready and done.
function ended(o, r) {
  const what = { credentials: 'sign-in', code: 'code', handoff: 'step' }[r.kind];
  if (r.status === 'pending') {
    stop(75, `the user hasn't answered yet; the request stays open ${minutes(r.expiresAt - Date.now())} more. Run the same command again to keep waiting.`);
  }
  if (r.status === 'denied') {
    stop(6, `the user ${r.kind === 'handoff' ? "tapped Can't" : 'denied'} the ${what} for ${o.site}. Don't ask again; tell the user and ask how to go on.`);
  }
  if (r.status === 'expired') stop(7, `nobody answered, so the ${what} request for ${o.site} expired. Run the same command to ask again, or sign in another way.`);
  if (r.status === 'cancelled') stop(7, `the ${what} request for ${o.site} was cancelled.`);
  if (r.status === 'unused') stop(7, `the ${what} for ${o.site} wasn't used in time and was dropped. Run the same command to ask again.`);
}

async function type(o, field) {
  const { status, data } = await agentCall('POST', '/agent/type', { site: o.site, field, enter: o.enter,
    ...(o.page ? { page: o.page } : {}), ...(o.keyboard ? { keyboard: true } : {}) });
  if (status === 404 && data.error === 'nothing_held') {
    if (/no username/.test(data.detail || '')) stop(7, `the user sent no username for ${o.site}, only a password. Click the password field, then run: agent-box login ${o.site} --password`);
    if (field === 'code') stop(7, `no code is held for ${o.site}. Run: agent-box login ${o.site} --code`);
    stop(7, `no login is held for ${o.site}: it was used, or it ran out. To ask again, run: agent-box login ${o.site}`);
  }
  if (status >= 400) stop(data.error === 'invalid' ? 2 : 1, data.detail || `the broker answered ${status}`);
  if (data.message) (data.exit === 0 ? console.log : console.error)(data.message);
  if (data.exit === 0) {
    if (field === 'password' && !o.enter) say('submit the form before any snapshot (snapshots show password fields).');
    if (field === 'username') say(`next, click the password field and run: agent-box login ${o.site} --password`);
  } else if ([3, 4, 5].includes(data.exit)) {
    warn(`the ${field} is still held${field === 'code' ? ' for 2 minutes' : ''}; fix that and run the same command again.`);
  }
  process.exit(data.exit);
}

async function login(argv) {
  const o = parseLogin(argv);
  if (o.mode === 'cancel') {
    checkSocketPath();
    if (!await running()) stop(0, `nothing to cancel for ${o.site}.`);
    const open = (await agentCall('GET', `/agent/requests?site=${encodeURIComponent(o.site)}`)).data.requests || [];
    for (const r of open) await agentCall('POST', `/agent/requests/${r.id}/cancel`);
    stop(0, open.length ? `cancelled ${open.length} request${open.length === 1 ? '' : 's'} for ${o.site}; nothing is held for it now.` : `nothing to cancel for ${o.site}.`);
  }
  await needBroker();
  if (o.mode === 'username' || o.mode === 'password') return type(o, o.mode);
  const kind = o.mode;
  const r = await ask(o, kind);
  ended(o, r);
  if (kind === 'code') return type(o, 'code');
  if (kind === 'handoff') stop(0, `the user tapped Done for ${o.site}. Carry on.`);
  say(`the user sent the login for ${o.site}; it's held until used, for ${minutes(HOLD_MS)} at most.`);
  say(`Click the username field and run: agent-box login ${o.site} --username, then click the password field and run: agent-box login ${o.site} --password`);
}

// --- for the user ---------------------------------------------------------------

function pairingSteps(published) {
  return [
    'No phone is paired yet. To pair one:',
    ...(published ? [] : [`  - Publish the app to your own devices (once): ${serveCommand()}`]),
    `  - On your iPhone, open ${phoneUrl()} in Safari, tap Share, then Add to Home Screen, and open Agent Box from the Home Screen.`,
    '  - Run agent-box broker pair, and type the code it prints into the app.',
    "  - In the app's settings, turn on notifications.",
  ];
}

async function status() {
  checkSocketPath();
  const s = await running();
  const published = !!env.BOX_BROKER_APP_URL;
  if (!s) {
    const n = pairedPhones();
    console.log(`agent-box broker: off${n ? ` (${n} phone${n === 1 ? '' : 's'} paired; agent-box login starts it when an agent asks)` : ''}. Start it with: agent-box broker on`);
    return;
  }
  console.log(`agent-box broker: on, version ${s.version}`);
  console.log(`  phone app: ${appUrl()}${published ? ' (Tailscale)' : ' (this machine only)'}`);
  if (!s.devices.length) { for (const line of pairingSteps(published)) console.log(`  ${line}`); return; }
  if (!published) console.log(`  To reach it from your phone, run once: ${serveCommand()}`);
  for (const d of s.devices) {
    const seen = d.lastSeenAt ? `, last seen ${minutes(Date.now() - d.lastSeenAt)} ago` : '';
    console.log(`  phone: ${d.name} (${d.id}), notifications ${d.push ? 'on' : 'off'}${seen}`);
  }
  if (s.pending) console.log(`  ${s.pending} request${s.pending === 1 ? '' : 's'} waiting for an answer`);
}

async function pair() {
  checkSocketPath();
  if (!await running()) stop(8, 'the broker is off. Start it with: agent-box broker on');
  const { data } = await agentCall('POST', '/agent/pair');
  console.log(`Pairing code: ${data.code.slice(0, 4)} ${data.code.slice(4)} (for one phone, valid ${minutes(data.expiresAt - Date.now())})`);
  console.log(`On the phone, open the Agent Box app (${phoneUrl()}) and type the code.`);
  if (!env.BOX_BROKER_APP_URL) console.log(`The app isn't published to your devices yet. Run once: ${serveCommand()}`);
}

async function unpair(argv) {
  const all = argv[0] === '--all';
  const id = all ? null : argv[0];
  if (!all && !/^d_[a-z0-9]+$/.test(id || '')) stop(2, 'usage: agent-box broker unpair <device id>|--all (ids from agent-box broker status)');
  checkSocketPath();
  let removed;
  if (await running()) removed = (await agentCall('POST', '/agent/unpair', all ? { all: true } : { deviceId: id })).data.removed;
  else {
    let data = null;
    try { data = readState(); } catch { stop(1, `can't read ${STATE}`); }
    if (!data?.devices?.length) stop(0, 'no phone is paired.');
    const before = data.devices.length;
    data.devices = all ? [] : data.devices.filter(d => d.id !== id);
    removed = before - data.devices.length;
    if (removed) { prepareDir(); writeState(data); }
  }
  stop(0, removed ? `unpaired ${removed} phone${removed === 1 ? '' : 's'}.` : 'no such phone; see agent-box broker status.');
}

async function pushTest() {
  checkSocketPath();
  if (!await running()) stop(8, 'the broker is off. Start it with: agent-box broker on');
  const { data } = await agentCall('POST', '/agent/push-test');
  if (!data.sent && !data.failed) stop(1, "no phone has notifications on. Turn them on in the app's settings.");
  stop(data.failed ? 1 : 0, `sent ${data.sent} test notification${data.sent === 1 ? '' : 's'}${data.failed ? `; ${data.failed} failed (see the broker's log)` : ''}.`);
}

// Stop a broker started in the background (by login, or broker on on Linux).
async function stopService() {
  let pid;
  try { pid = Number(readFileSync(PIDFILE, 'utf8').trim()); } catch {}
  const ours = pid > 1 && spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).stdout?.includes('box-broker.mjs');
  if (!ours) { if (await running()) stop(1, 'a broker runs, but not one this command started; stop it with agent-box broker off'); stop(0, 'the broker is not running.'); }
  process.kill(pid, 'SIGTERM');
  for (let i = 0; i < 50 && await running(); i++) await sleep(100);
  stop(0, 'broker stopped.');
}

async function doctor() {
  const s = Buffer.byteLength(SOCK) > 103 ? null : await running();
  if (!s) {
    const n = pairedPhones();
    console.log(n ? `login broker is off; agent-box login starts it (${n} phone${n === 1 ? '' : 's'} paired)`
      : 'login broker is off (optional: sign-ins from your phone; see the README)');
    return;
  }
  const push = s.devices.filter(d => d.push).length;
  console.log(s.devices.length ? `login broker is on, ${s.devices.length} phone${s.devices.length === 1 ? '' : 's'} paired, ${push} with notifications`
    : 'login broker is on, no phone paired yet (agent-box broker pair)');
  if (env.BOX_BROKER_APP_URL) console.log(`login broker's phone app published at ${env.BOX_BROKER_APP_URL}`);
  else console.log(`login broker's phone app isn't published; to reach it from your phone: ${serveCommand()}`);
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case 'run': await runService(); break;
  case 'login': await login(rest); break;
  case 'status': await status(); break;
  case 'pair': await pair(); break;
  case 'unpair': await unpair(rest); break;
  case 'test': await pushTest(); break;
  case 'stop': await stopService(); break;
  case 'start': {
    checkSocketPath();
    if (await running()) stop(0, 'the broker is already running.');
    if (!await startInBackground()) stop(1, `the broker didn't start; see ${LOGFILE}`);
    stop(0, 'the broker runs in the background until this machine restarts; run agent-box broker on again after a restart.');
  }
  case 'ping': checkSocketPath(); process.exit(await running() ? 0 : 1); break;
  case 'url': { checkSocketPath(); if (!await running()) process.exit(1); console.log(`sign-in app: ${appUrl()}`); break; }
  case 'doctor': await doctor(); break;
  default:
    console.error('usage: box-broker run | login <site> [...] | status | pair | unpair <id>|--all | test | start | stop');
    process.exit(2);
}
