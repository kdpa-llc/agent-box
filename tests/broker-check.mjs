// Checks the login broker (box-broker.mjs) with no box, phone or push service: stand-ins
// play the typing command (it records its arguments and how many bytes came on stdin),
// the box's browser (/json/list) and a push service (it decrypts what it gets). The
// broker runs on a free port with its own folder in /tmp, removed at the end.
// Run: node tests/broker-check.mjs
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createDecipheriv, createECDH, createHash, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pushAllowed } from '../box-broker-push.mjs';

const BROKER = fileURLToPath(new URL('../box-broker.mjs', import.meta.url));
const TMP = mkdtempSync('/tmp/abx.');
const DIR = join(TMP, 'b');
const APP = join(TMP, 'app');
const STANDIN = join(TMP, 'type');
const TYPED_LOG = join(TMP, 'typed.log');
const EXIT_FILE = join(TMP, 'type-exit');
const SOCK = join(DIR, 'agent.sock');

// The test's values. None may show up anywhere but the stand-in's stdin.
const tag = randomBytes(4).toString('hex');
const USER = `abx-user-${tag}@example.com`, PASS = `abx-Pass-${tag}-xyz!`, CODE = `c0de${tag}`, PASS2 = `abx-second-${tag}`;
const VALUES = [USER, PASS, CODE, PASS2];
const seen = [];   // every response body and every command output
const checks = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));

const freePort = async () => { const s = createServer().listen(0, '127.0.0.1'); await once(s, 'listening'); const { port } = s.address(); s.close(); return port; };

// --- stand-ins ---------------------------------------------------------------

writeFileSync(STANDIN, `#!${process.execPath}
const { appendFileSync, readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const args = process.argv.slice(2);
const chunks = [];
process.stdin.on('data', c => chunks.push(c));
process.stdin.on('end', () => {
  const input = Buffer.concat(chunks);
  appendFileSync(${JSON.stringify(TYPED_LOG)}, JSON.stringify({ args, bytes: input.length, sha: createHash('sha256').update(input).digest('hex') }) + '\\n');
  if (args[0] === 'exec') process.exit(0);
  let code = 0;
  try { code = Number(readFileSync(${JSON.stringify(EXIT_FILE)}, 'utf8')); } catch {}
  console.log(code === 0 ? 'box-type: typed it into stand-in' : 'box-type: no page has that field focused; nothing typed.');
  process.exit(code);
});
`, { mode: 0o755 });
const typed = () => existsSync(TYPED_LOG) ? readFileSync(TYPED_LOG, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const typings = () => typed().filter(t => t.args[0] === 'type-stdin');
const holds = () => typed().filter(t => t.args[0] === 'exec');
const typeExit = code => writeFileSync(EXIT_FILE, String(code));
const sha = text => createHash('sha256').update(text).digest('hex');
typeExit(0);

let pages = [];
let cdpDown = false;
const cdp = createServer((req, res) => {
  if (cdpDown) return req.socket.destroy();
  if (req.url !== '/json/list') return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(pages));
});
cdp.listen(0, '127.0.0.1'); await once(cdp, 'listening');

const pushes = [];
let pushWaiters = [];
const pushService = createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    pushes.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
    pushWaiters.forEach(w => w()); pushWaiters = [];
    res.writeHead(req.url.startsWith('/gone') ? 410 : req.url.startsWith('/fail') ? 500 : 201).end();
  });
});
pushService.listen(0, '127.0.0.1'); await once(pushService, 'listening');
const PUSH = `http://127.0.0.1:${pushService.address().port}`;
const nextPush = async (count, ms = 3000) => { const end = Date.now() + ms; while (pushes.length < count && Date.now() < end) await new Promise(r => { pushWaiters.push(r); setTimeout(r, 200); }); return pushes[count - 1]; };

mkdirSync(APP);
const FILES = { 'index.html': '<!doctype html><title>fixture</title>', 'app.css': 'body{}', 'app.js': 'console.log(1)', 'sw.js': '// sw',
  'manifest.webmanifest': '{"name":"Agent Box"}', 'icon-180.png': 'png180', 'icon-192.png': 'png192', 'icon-512.png': 'png512' };
for (const [name, content] of Object.entries(FILES)) writeFileSync(join(APP, name), content);
writeFileSync(join(APP, 'secret.txt'), 'not for phones');
writeFileSync(join(TMP, 'secret.txt'), 'not for phones either');

const PORT = await freePort();
const ORIGIN = `http://127.0.0.1:${PORT}`;
const ENV = { ...process.env, BOX_BROKER_DIR: DIR, BOX_BROKER_PORT: String(PORT), BOX_CDP_PORT: String(cdp.address().port),
  BOX_BROKER_TYPE_CMD: STANDIN, BOX_BROKER_BOX_CMD: STANDIN, BOX_BROKER_APP_DIR: APP, BOX_BROKER_PUSH_HOSTS: '127.0.0.1',
  BOX_BROKER_APP_URL: '', AGENT_BOX_AS: '' };

// --- talking to the broker ------------------------------------------------------

function agent(method, path, body) {
  return new Promise((done, failed) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = request({ socketPath: SOCK, method, path, headers: data ? { 'content-type': 'application/json' } : {} }, res => {
      let text = '';
      res.on('data', c => { text += c; });
      res.on('end', () => { seen.push(text); done({ status: res.statusCode, data: JSON.parse(text || '{}') }); });
    });
    req.on('error', failed);
    req.end(data);
  });
}

async function phone(method, path, { token, body, headers = {}, raw } = {}) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  if (body !== undefined && !('content-type' in h)) h['content-type'] = 'application/json';
  const response = await fetch(ORIGIN + path, { method, headers: h, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const text = await response.text();
  seen.push(text);
  let data = null;
  try { data = JSON.parse(text); } catch {}
  return { status: response.status, data, text, headers: response.headers };
}

// A path exactly as written, which fetch would tidy up.
function rawGet(path) {
  return new Promise(done => {
    request({ host: '127.0.0.1', port: PORT, path, method: 'GET' }, res => {
      let text = '';
      res.on('data', c => { text += c; });
      res.on('end', () => { seen.push(text); done({ status: res.statusCode, text }); });
    }).end();
  });
}

let output = '';
async function startBroker(extra = {}) {
  const child = spawn(process.execPath, [BROKER, 'run'], { env: { ...ENV, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', c => { output += c; });
  child.stderr.on('data', c => { output += c; });
  for (let i = 0; i < 50; i++) {
    await sleep(100);
    if (await agent('GET', '/agent/status').then(r => r.status === 200, () => false)) return child;
  }
  throw Error(`the broker didn't start:\n${output}`);
}
async function stopBroker(child) { child.kill('SIGTERM'); await once(child, 'exit'); }

function client(args, extra = {}) {
  return new Promise(done => {
    const child = spawn(process.execPath, [BROKER, ...args], { env: { ...ENV, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', c => { out += c; });
    child.stderr.on('data', c => { out += c; });
    child.on('close', code => { seen.push(out); done({ code, out }); });
  });
}

const githubPage = { type: 'page', id: 'A', title: 'Sign in to GitHub', url: 'https://github.com/login?return_to=%2Fsecret#top' };
const ask = (kind, site, extra = {}) => agent('POST', '/agent/requests', { kind, site, ...extra });
const answer = (token, id, body) => phone('POST', `/api/requests/${id}/answer`, { token, body });
const typeIt = (site, field, extra = {}) => agent('POST', '/agent/type', { site, field, ...extra });
const getRequest = (id, wait = 0) => agent('GET', `/agent/requests/${id}?wait=${wait}`);

// The phone's push keys, as a browser makes them.
function pushKeys() {
  const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
  return { ecdh, auth: randomBytes(16) };
}
function subscription(keys, endpoint) {
  return { endpoint, expirationTime: null, keys: { p256dh: keys.ecdh.getPublicKey().toString('base64url'), auth: keys.auth.toString('base64url') } };
}
// RFC 8291 on the receiving side.
function decrypt(body, keys) {
  const salt = body.subarray(0, 16), idlen = body[20], asPublic = body.subarray(21, 21 + idlen), sealed = body.subarray(21 + idlen);
  assert.equal(body.readUInt32BE(16), 4096);
  const hkdf = (ikm, saltIn, info, n) => Buffer.from(hkdfSync('sha256', ikm, saltIn, Buffer.from(info), n));
  const shared = keys.ecdh.computeSecret(asPublic);
  const ikm = hkdf(shared, keys.auth, Buffer.concat([Buffer.from('WebPush: info\0'), keys.ecdh.getPublicKey(), asPublic]), 32);
  const decipher = createDecipheriv('aes-128-gcm', hkdf(ikm, salt, 'Content-Encoding: aes128gcm\0', 16), hkdf(ikm, salt, 'Content-Encoding: nonce\0', 12));
  decipher.setAuthTag(sealed.subarray(-16));
  const plain = Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()]);
  assert.equal(plain.at(-1), 2, 'the payload ends with the last-record delimiter');
  return JSON.parse(plain.subarray(0, -1).toString('utf8'));
}
// VAPID (RFC 8292): a JWT signed with the key the app got from /api/state.
function checkVapid(header, publicKey, audience) {
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  assert.ok(m, `Authorization: ${header}`);
  assert.equal(m[2], publicKey);
  const [head, claims, signature] = m[1].split('.');
  const raw = Buffer.from(publicKey, 'base64url');
  const key = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') } });
  assert.ok(verify('sha256', Buffer.from(`${head}.${claims}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')), 'VAPID signature');
  assert.deepEqual(JSON.parse(Buffer.from(head, 'base64url')), { typ: 'JWT', alg: 'ES256' });
  const c = JSON.parse(Buffer.from(claims, 'base64url'));
  assert.equal(c.aud, audience);
  assert.equal(c.sub, 'https://github.com/kdpa-llc/agent-box');
  assert.ok(c.exp > Date.now() / 1000 && c.exp <= Date.now() / 1000 + 24 * 3600);
}

let broker;
try {
  // --- start, files and folders -------------------------------------------------
  let r = await client(['run'], { BOX_BROKER_DIR: '/tmp/' + 'x'.repeat(100) });
  assert.equal(r.code, 1);
  assert.match(r.out, /too long/);
  assert.equal(existsSync('/tmp/' + 'x'.repeat(100)), false);
  checks.push('A socket path over 103 bytes stops the broker with a clear message, before it makes a folder');

  broker = await startBroker();
  assert.equal(statSync(DIR).mode & 0o777, 0o700);
  assert.equal(statSync(join(DIR, 'state.json')).mode & 0o777, 0o600);
  assert.equal(statSync(SOCK).mode & 0o777, 0o600);
  r = await client(['run']);
  assert.equal(r.code, 1);
  assert.match(r.out, /already runs/);
  checks.push('Folder 700, state file and socket 600; a second broker refuses to start');

  // --- static files -----------------------------------------------------------------
  let p = await phone('GET', '/');
  assert.equal(p.status, 200);
  assert.equal(p.text, FILES['index.html']);
  assert.equal(p.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(p.headers.get('content-security-policy'), "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  for (const [name, value] of [['cache-control', 'no-cache'], ['x-content-type-options', 'nosniff'], ['referrer-policy', 'no-referrer']]) assert.equal(p.headers.get(name), value);
  for (const name of Object.keys(FILES)) {
    p = await phone('GET', `/${name}`);
    assert.equal(p.status, 200, name);
    assert.equal(p.text, FILES[name]);
    assert.equal(p.headers.get('cache-control'), 'no-cache');
    assert.equal(p.headers.get('content-security-policy'), name.endsWith('.html') ? "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" : null);
  }
  assert.equal((await phone('GET', '/app.js')).headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal((await phone('GET', '/manifest.webmanifest')).headers.get('content-type'), 'application/manifest+json');
  assert.equal((await phone('GET', '/?from=home')).text, FILES['index.html']);
  for (const path of ['/secret.txt', '/../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt', '//secret.txt', '/app.js/../secret.txt',
    '/b/state.json', '/../b/state.json', '/%2e%2e/b/state.json', '/state.json', '/index.html/', '/INDEX.HTML']) {
    const got = await rawGet(path);
    assert.equal(got.status, 404, path);
    assert.ok(!got.text.includes('not for phones') && !got.text.includes('vapid'), path);
  }
  p = await phone('POST', '/index.html', { body: {} });
  assert.equal(p.status, 405);
  checks.push('The app files are served with the contract headers, CSP on HTML only; any other path is 404');

  // --- pairing -----------------------------------------------------------------------
  assert.equal((await phone('GET', '/api/state')).status, 401);
  p = await phone('POST', '/api/pair', { body: { code: 'ABCDEFGH', name: 'iPhone' } });
  assert.deepEqual([p.status, p.data.error], [403, 'bad_code']);
  let a = await agent('POST', '/agent/pair');
  assert.match(a.data.code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
  assert.ok(Math.abs(a.data.expiresAt - Date.now() - 600_000) < 5000);
  let code = a.data.code;
  p = await phone('POST', '/api/pair', { body: { code: code.split('').reverse().join(''), name: 'iPhone' } });
  assert.deepEqual([p.status, p.data.error], [403, 'bad_code']);
  p = await phone('POST', '/api/pair', { body: { code, name: 'x'.repeat(41) } });
  assert.deepEqual([p.status, p.data.error], [422, 'invalid']);
  p = await phone('POST', '/api/pair', { body: { code: ` ${code.slice(0, 4).toLowerCase()} ${code.slice(4)} `, name: 'iPhone' } });
  assert.equal(p.status, 200);
  assert.match(p.data.deviceId, /^d_[a-z0-9]{8}$/);
  assert.match(p.data.token, /^[A-Za-z0-9_-]{43}$/);
  const PHONE = p.data.token, PHONE_ID = p.data.deviceId;
  p = await phone('POST', '/api/pair', { body: { code, name: 'Again' } });
  assert.deepEqual([p.status, p.data.error], [403, 'bad_code']);
  checks.push('Pairing: a good code works once, case and spaces aside; a wrong code, a used code and a long name are refused');

  code = (await agent('POST', '/agent/pair')).data.code;
  for (let i = 0; i < 5; i++) assert.equal((await phone('POST', '/api/pair', { body: { code: 'WRONG' + i, name: 'x' } })).status, 403);
  p = await phone('POST', '/api/pair', { body: { code, name: 'Spare' } });
  assert.deepEqual([p.status, p.data.error], [429, 'too_many_tries']);
  code = (await agent('POST', '/agent/pair')).data.code;
  p = await phone('POST', '/api/pair', { body: { code, name: 'Spare' } });
  assert.equal(p.status, 200);
  const SPARE = p.data.token;
  checks.push('Five wrong tries stop the code (429, even for the right one) until a new code is made');

  const stateText = readFileSync(join(DIR, 'state.json'), 'utf8');
  assert.ok(!stateText.includes(PHONE) && !stateText.includes(code));
  assert.ok(stateText.includes(createHash('sha256').update(PHONE).digest('hex')));
  checks.push('state.json keeps the SHA-256 of each token, never the token or a code');

  // --- the phone API's checks -----------------------------------------------------
  assert.equal((await phone('GET', '/api/state', { token: 'A'.repeat(43) })).status, 401);
  assert.equal((await phone('GET', '/api/state', { headers: { authorization: `Basic ${PHONE}` } })).status, 401);
  p = await phone('POST', '/api/push/unsubscribe', { token: PHONE, raw: '{}', headers: { 'content-type': 'text/plain' } });
  assert.deepEqual([p.status, p.data.error], [403, 'forbidden']);
  p = await phone('POST', '/api/push/unsubscribe', { token: PHONE, body: {}, headers: { origin: 'https://evil.example' } });
  assert.deepEqual([p.status, p.data.error], [403, 'forbidden']);
  p = await phone('POST', '/api/push/unsubscribe', { token: PHONE, body: {}, headers: { origin: 'null' } });
  assert.equal(p.status, 403);
  p = await phone('POST', '/api/push/unsubscribe', { token: PHONE, body: { pad: 'x'.repeat(17 * 1024) } });
  assert.deepEqual([p.status, p.data.error], [403, 'forbidden']);
  p = await phone('POST', '/api/push/unsubscribe', { token: PHONE, body: {}, headers: { origin: ORIGIN } });
  assert.equal(p.status, 200);
  p = await phone('POST', '/api/push/unsubscribe', { token: 'nope', body: {} });
  assert.equal(p.status, 401);
  assert.equal(p.headers.get('x-content-type-options'), 'nosniff');
  checks.push('The phone API needs the bearer token, JSON, at most 16 KB, and an Origin equal to the Host when there is one');

  p = await phone('GET', '/api/state', { token: PHONE });
  assert.equal(p.status, 200);
  assert.deepEqual(Object.keys(p.data).sort(), ['device', 'history', 'push', 'requests', 'rev', 'version']);
  assert.deepEqual(p.data.device, { id: PHONE_ID, name: 'iPhone' });
  assert.equal(p.data.push.subscribed, false);
  const PUBLIC_KEY = p.data.push.publicKey;
  assert.equal(Buffer.from(PUBLIC_KEY, 'base64url').length, 65);
  assert.equal(p.data.version, JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version);

  // --- push subscriptions -----------------------------------------------------------
  assert.ok(pushAllowed('https://web.push.apple.com/abc') && pushAllowed('https://fcm.googleapis.com/fcm/send/x'));
  assert.ok(pushAllowed('https://updates.push.services.mozilla.com/wpush/v2/x') && pushAllowed('https://wns2-par02p.notify.windows.com/w/?token=x'));
  assert.ok(!pushAllowed('http://web.push.apple.com/abc') && !pushAllowed('https://push.apple.com.evil.example/x') && !pushAllowed('https://evil.example/fcm.googleapis.com'));
  assert.ok(!pushAllowed('https://user:pw@web.push.apple.com/x') && !pushAllowed('http://127.0.0.1:9/x') && pushAllowed('http://127.0.0.1:9/x', ['127.0.0.1']));
  const keys = pushKeys(), spareKeys = pushKeys();
  for (const bad of [subscription(keys, 'https://evil.example/push'), subscription(keys, 'http://localhost/push'), { ...subscription(keys, `${PUSH}/a`), keys: { p256dh: 'AAAA', auth: 'BBBB' } }]) {
    p = await phone('POST', '/api/push/subscribe', { token: PHONE, body: { subscription: bad } });
    assert.deepEqual([p.status, p.data.error], [422, 'invalid']);
  }
  p = await phone('POST', '/api/push/subscribe', { token: PHONE, body: { subscription: subscription(keys, `${PUSH}/phone`) }, headers: { origin: ORIGIN } });
  assert.equal(p.status, 200);
  p = await phone('POST', '/api/push/subscribe', { token: SPARE, body: { subscription: subscription(spareKeys, `${PUSH}/gone`) }, headers: { origin: ORIGIN } });
  assert.equal(p.status, 200);
  assert.equal((await phone('GET', '/api/state', { token: PHONE })).data.push.subscribed, true);
  checks.push('Push subscriptions only on known push services (plus BOX_BROKER_PUSH_HOSTS), with valid keys');

  p = await phone('POST', '/api/push/test', { token: PHONE, body: {}, headers: { origin: ORIGIN } });
  assert.equal(p.status, 200);
  let push = await nextPush(1);
  assert.equal(push.path, '/phone');
  checkVapid(push.headers.authorization, PUBLIC_KEY, PUSH);
  assert.deepEqual(decrypt(push.body, keys), { web_push: 8030, notification: { title: 'Agent Box', body: 'Notifications work.', tag: 'test', navigate: `${ORIGIN}/` } });
  assert.equal(push.headers['content-encoding'], 'aes128gcm');
  assert.equal(push.headers.urgency, 'high');
  checks.push('A test push decrypts with the phone\'s keys and carries a VAPID signature from the key in /api/state');

  // --- requests: refusals -------------------------------------------------------------
  pages = [];
  a = await ask('credentials', 'github.com');
  assert.deepEqual([a.status, a.data.error], [422, 'no_page']);
  cdpDown = true;
  a = await ask('credentials', 'github.com');
  assert.deepEqual([a.status, a.data.error], [503, 'box_unreachable']);
  cdpDown = false;
  pages = [{ type: 'page', id: 'X', title: 'Other', url: 'https://example.org/' }, { type: 'service_worker', url: 'https://github.com/sw.js' }];
  assert.equal((await ask('credentials', 'github.com')).data.error, 'no_page');
  for (const body of [{ kind: 'password', site: 'github.com' }, { kind: 'credentials', site: 'https://github.com/login' }, { kind: 'credentials', site: 'com' },
    { kind: 'handoff', site: 'github.com' }, { kind: 'handoff', site: 'github.com', note: 'x'.repeat(201) },
    { kind: 'handoff', site: 'github.com', note: 'Solve it', viewerUrl: 'http://example.com/' }, { kind: 'credentials', site: 'github.com', agent: 'x'.repeat(61) }]) {
    a = await agent('POST', '/agent/requests', body);
    assert.deepEqual([a.status, a.data.error], [422, 'invalid'], JSON.stringify(body));
  }
  checks.push('no_page (only real pages count), box_unreachable and invalid requests fail before anyone is notified');
  assert.equal(pushes.length, 1);

  // --- credentials ----------------------------------------------------------------------
  pages = [githubPage, { type: 'page', id: 'B', title: 'Other', url: 'https://example.org/' }];
  const before = (await phone('GET', '/api/state', { token: PHONE })).data.rev;
  const phoneWait = phone('GET', `/api/state?since=${before}&wait=10`, { token: PHONE });
  a = await ask('credentials', 'www.GitHub.com', { agent: 'Tester' });
  assert.equal(a.status, 201);
  let req = a.data.request;
  assert.match(req.id, /^r_[a-z0-9]{8}$/);
  assert.deepEqual({ ...req, id: 0, createdAt: 0, expiresAt: 0 }, { id: 0, kind: 'credentials', site: 'github.com', page: { title: 'Sign in to GitHub', url: 'https://github.com/login' },
    agent: 'Tester', note: null, viewerUrl: null, status: 'pending', createdAt: 0, expiresAt: 0 });
  assert.equal(req.expiresAt - req.createdAt, 30 * 60_000);
  p = await phoneWait;
  assert.ok(p.data.rev > before);
  assert.deepEqual(p.data.requests.map(x => x.id), [req.id]);
  checks.push('A new request (201) shows the page the broker saw, without its query; the phone\'s long-poll returns at once');

  push = await nextPush(3);
  const sent = pushes.slice(1, 3);
  const mine = sent.find(x => x.path === '/phone');
  checkVapid(mine.headers.authorization, PUBLIC_KEY, PUSH);
  assert.ok(Math.abs(Number(mine.headers.ttl) - 1800) <= 2);
  assert.deepEqual(decrypt(mine.body, keys), { web_push: 8030, notification: { title: 'Sign-in request', body: 'Tester wants to sign in to github.com', tag: req.id, navigate: `${ORIGIN}/#/r/${req.id}` } });
  assert.ok(sent.some(x => x.path === '/gone'));
  await sleep(200);
  const status = (await agent('GET', '/agent/status')).data;
  assert.deepEqual(status.devices.map(d => d.push), [true, false]);
  assert.equal(status.pending, 1);
  assert.equal(status.port, PORT);
  checks.push('Each phone with notifications gets an encrypted push with the contract\'s payload; a 410 removes that subscription');

  a = await ask('credentials', 'github.com');
  assert.deepEqual([a.status, a.data.request.id], [200, req.id]);
  assert.equal(pushes.length, 3);
  assert.deepEqual((await agent('GET', '/agent/requests?site=github.com')).data.requests.map(x => x.id), [req.id]);
  checks.push('Asking again while it is pending returns the same request (200) and notifies nobody');

  p = await answer(PHONE, req.id, { username: USER, password: '' });
  assert.deepEqual([p.status, p.data.error], [422, 'invalid']);
  p = await answer(PHONE, req.id, { username: USER, password: 'x'.repeat(1025) });
  assert.deepEqual([p.status, p.data.error], [422, 'invalid']);
  assert.equal((await answer(PHONE, 'r_00000000', { username: USER, password: PASS })).status, 404);
  const agentWait = getRequest(req.id, 10);
  const started = Date.now();
  await sleep(300);
  p = await answer(PHONE, req.id, { username: USER, password: PASS });
  assert.deepEqual([p.status, p.data], [200, { ok: true }]);
  a = await agentWait;
  assert.equal(a.data.request.status, 'ready');
  assert.ok(Date.now() - started < 3000);
  p = await answer(PHONE, req.id, { username: USER, password: PASS });
  assert.deepEqual([p.status, p.data.error], [409, 'not_pending']);
  a = await ask('credentials', 'github.com');
  assert.deepEqual([a.status, a.data.request.id, a.data.request.status], [200, req.id, 'ready']);
  assert.deepEqual((await phone('GET', '/api/state', { token: PHONE })).data.requests, []);
  checks.push('The answer wakes the agent\'s long-poll; asking again while it is ready returns it as it is');

  let t = await typeIt('github.com', 'username', { enter: true });
  assert.deepEqual(t.data, { exit: 0, message: 'box-type: typed it into stand-in' });
  let last = typings().at(-1);
  assert.deepEqual(last.args, ['type-stdin', '--kind', 'username', '--url', 'github.com']);
  assert.deepEqual([last.bytes, last.sha], [Buffer.byteLength(USER), sha(USER)]);
  typeExit(3);
  t = await typeIt('github.com', 'password', { page: 'GitHub' });
  assert.equal(t.data.exit, 3);
  typeExit(0);
  t = await typeIt('gist.github.com', 'password', { page: 'GitHub', keyboard: true });
  assert.equal(t.data.exit, 0);
  last = typings().at(-1);
  assert.deepEqual(last.args, ['type-stdin', '--kind', 'password', '--url', 'github.com', '--enter', '--clear-after', '3', '--page', 'GitHub', '--keyboard']);
  assert.deepEqual([last.bytes, last.sha], [Buffer.byteLength(PASS), sha(PASS)]);
  assert.equal((await getRequest(req.id)).data.request.status, 'done');
  for (const field of ['username', 'password']) {
    t = await typeIt('github.com', field);
    assert.deepEqual([t.status, t.data.error], [404, 'nothing_held'], field);
  }
  const first = (await phone('GET', '/api/state', { token: PHONE })).data.history[0];
  assert.deepEqual(first, { id: req.id, kind: 'credentials', site: 'github.com', agent: 'Tester', status: 'done', at: first.at });
  checks.push('Username, then a password that fails (exit 3, kept) and one that lands: --enter --clear-after 3; then nothing is held');

  // An empty username, and a password with no Enter.
  a = await ask('credentials', 'github.com');
  assert.equal(a.status, 201);
  req = a.data.request;
  await answer(PHONE, req.id, { username: '', password: PASS2 });
  t = await typeIt('github.com', 'username');
  assert.deepEqual([t.status, t.data.error], [404, 'nothing_held']);
  assert.match(t.data.detail, /no username/);
  t = await typeIt('github.com', 'password', { enter: false });
  assert.equal(t.data.exit, 0);
  assert.deepEqual(typings().at(-1).args, ['type-stdin', '--kind', 'password', '--url', 'github.com']);
  assert.equal(typings().at(-1).sha, sha(PASS2));
  checks.push('An empty username is not typed (404 with a plain reason); a password with enter: false has no Enter and no clean-up');

  // Deny, cancel, and an end the agent didn't see.
  a = await ask('credentials', 'github.com');
  req = a.data.request;
  assert.equal((await phone('POST', `/api/requests/${req.id}/deny`, { token: PHONE, body: {} })).status, 200);
  a = await ask('credentials', 'github.com');
  assert.deepEqual([a.status, a.data.request.id, a.data.request.status], [200, req.id, 'denied']);
  a = await ask('credentials', 'github.com');
  assert.equal(a.status, 201);
  req = a.data.request;
  a = await agent('POST', `/agent/requests/${req.id}/cancel`);
  assert.equal(a.data.request.status, 'cancelled');
  assert.equal((await phone('POST', `/api/requests/${req.id}/deny`, { token: PHONE, body: {} })).status, 409);
  a = await ask('credentials', 'github.com');
  req = a.data.request;
  await answer(PHONE, req.id, { username: USER, password: PASS });
  a = await agent('POST', `/agent/requests/${req.id}/cancel`);
  assert.equal(a.data.request.status, 'cancelled');
  assert.equal((await typeIt('github.com', 'password')).status, 404);
  assert.equal((await getRequest('r_zzzzzzzz')).status, 404);
  checks.push('Deny ends it (the next ask returns the denial once, then asks anew); cancel ends a pending or a ready one and drops its values');

  // --- code -------------------------------------------------------------------------------
  let count = pushes.length;
  a = await ask('code', 'github.com');
  req = a.data.request;
  assert.equal(decrypt((await nextPush(count + 1)).body, keys).notification.body, 'github.com is asking for a code');
  assert.deepEqual([(await answer(PHONE, req.id, { code: '' })).status], [422]);
  await answer(PHONE, req.id, { code: CODE });
  typeExit(5);
  assert.equal((await typeIt('github.com', 'code')).data.exit, 5);
  typeExit(0);
  assert.equal((await typeIt('github.com', 'code')).data.exit, 0);
  last = typings().at(-1);
  assert.deepEqual(last.args, ['type-stdin', '--kind', 'totp', '--url', 'github.com', '--enter']);
  assert.equal(last.sha, sha(CODE));
  assert.equal((await typeIt('github.com', 'code')).status, 404);
  assert.equal((await getRequest(req.id)).data.request.status, 'done');
  checks.push('A code is typed as totp with Enter; a failed typing (exit 5) keeps it, a typed one is gone');

  // --- handoff ----------------------------------------------------------------------------
  count = pushes.length;
  a = await ask('handoff', 'github.com', { note: 'Solve the puzzle', viewerUrl: 'https://mac.example.ts.net:8443/' });
  req = a.data.request;
  assert.deepEqual([a.status, req.note, req.viewerUrl], [201, 'Solve the puzzle', 'https://mac.example.ts.net:8443/']);
  push = await nextPush(count + 1);
  assert.equal(decrypt(push.body, keys).notification.title, 'Your turn');
  assert.equal(decrypt(push.body, keys).notification.body, 'github.com: Solve the puzzle');
  await answer(PHONE, req.id, {});
  a = await ask('handoff', 'github.com', { note: 'Solve the puzzle' });
  assert.deepEqual([a.status, a.data.request.id, a.data.request.status], [200, req.id, 'done']);
  a = await ask('handoff', 'github.com', { note: 'Again', viewerUrl: 'http://127.0.0.1:6080/' });
  assert.equal(a.status, 201);
  req = a.data.request;
  const waitDeny = getRequest(req.id, 10);
  await phone('POST', `/api/requests/${req.id}/deny`, { token: PHONE, body: {} });
  assert.equal((await waitDeny).data.request.status, 'denied');
  a = await ask('handoff', 'github.com', { note: 'Third' });
  assert.equal(a.status, 201);
  await agent('POST', `/agent/requests/${a.data.request.id}/cancel`);
  checks.push('A handoff ends done (Done) or denied (Can\'t); an agent that missed the Done still gets it once');

  // --- the client, as agent-box login runs it ---------------------------------------
  pages = [githubPage];
  r = await client(['login', 'https://www.github.com/login', '--wait', '1', '--as', 'Client test']);
  assert.equal(r.code, 75, r.out);
  assert.match(r.out, /Run the same command again/);
  const open = (await agent('GET', '/agent/requests?site=github.com')).data.requests[0];
  assert.equal(open.agent, 'Client test');
  const hold = holds().at(-1);
  assert.deepEqual(hold.args.slice(0, 3), ['exec', 'sh', '-c']);
  assert.equal(Number(hold.args.at(-1)), Math.ceil(open.expiresAt / 1000));
  checks.push('login waits, exits 75 while the user hasn\'t answered, and holds the box until the request expires');

  await answer(PHONE, open.id, { username: USER, password: PASS });
  r = await client(['login', 'github.com']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /agent-box login github\.com --username/);
  r = await client(['login', 'github.com', '--password', '--no-enter']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /submit the form before any snapshot/);
  r = await client(['login', 'github.com', '--password']);
  assert.equal(r.code, 7, r.out);
  r = await client(['login', 'github.com', '--username']);
  assert.equal(r.code, 7, r.out);
  r = await client(['login', 'nowhere.example']);
  assert.equal(r.code, 5, r.out);
  r = await client(['login', 'github.com', '--username', '--password']);
  assert.equal(r.code, 2);
  r = await client(['login', 'github.com', '--wait', '301']);
  assert.equal(r.code, 2);

  r = await client(['login', 'github.com', '--human', 'Solve the puzzle', '--wait', '1']);
  assert.equal(r.code, 75, r.out);
  let id = (await agent('GET', '/agent/requests?site=github.com')).data.requests[0].id;
  await phone('POST', `/api/requests/${id}/deny`, { token: PHONE, body: {} });
  r = await client(['login', 'github.com', '--human', 'Solve the puzzle']);
  assert.equal(r.code, 6, r.out);

  r = await client(['login', 'github.com', '--code', '--wait', '0']);
  assert.equal(r.code, 75);
  id = (await agent('GET', '/agent/requests?site=github.com')).data.requests[0].id;
  await answer(PHONE, id, { code: CODE });
  typeExit(3);
  r = await client(['login', 'github.com', '--code']);
  assert.equal(r.code, 3, r.out);
  assert.match(r.out, /still held/);
  typeExit(0);
  r = await client(['login', 'github.com', '--code']);
  assert.equal(r.code, 0, r.out);
  r = await client(['login', 'github.com', '--wait', '0']);
  assert.equal(r.code, 75);
  r = await client(['login', 'github.com', '--cancel']);
  assert.equal(r.code, 0);
  assert.match(r.out, /cancelled 1 request/);
  checks.push('login exit codes: 0 ready or typed, 2 usage, 3 kept for a retry, 5 no page, 6 denied, 7 nothing held, 75 still waiting');

  p = await phone('POST', '/api/unpair', { token: SPARE, body: {} });
  assert.equal(p.status, 200);
  assert.equal((await phone('GET', '/api/state', { token: SPARE })).status, 401);
  assert.deepEqual((await agent('POST', '/agent/unpair', { all: true })).data, { removed: 1 });
  a = await ask('credentials', 'github.com');
  assert.deepEqual([a.status, a.data.error], [409, 'no_device']);
  r = await client(['login', 'github.com']);
  assert.equal(r.code, 8, r.out);
  assert.match(r.out, /no phone is paired/);
  await stopBroker(broker);
  broker = null;
  assert.equal(existsSync(SOCK), false);
  r = await client(['login', 'github.com']);
  assert.equal(r.code, 8, r.out);
  checks.push('No phone paired: 409 no_device, and login exits 8, with the broker on or off');

  // --- short times ------------------------------------------------------------------------
  broker = await startBroker({ BOX_BROKER_HOLD_SECONDS: '1', BOX_BROKER_CODE_HOLD_SECONDS: '1', BOX_BROKER_REQUEST_MINUTES: '0.02', BOX_BROKER_PAIR_MINUTES: '0.02' });
  code = (await agent('POST', '/agent/pair')).data.code;
  p = await phone('POST', '/api/pair', { body: { code, name: 'iPhone' } });
  const SHORT = p.data.token;
  p = await phone('GET', '/api/state?since=99999&wait=10', { token: SHORT });
  assert.ok(p.data.rev < 99999);
  code = (await agent('POST', '/agent/pair')).data.code;
  await sleep(1500);
  p = await phone('POST', '/api/pair', { body: { code, name: 'Late' } });
  assert.deepEqual([p.status, p.data.error], [403, 'bad_code']);
  checks.push('An expired pairing code is refused; a long-poll from before a restart (since > rev) returns at once');

  req = (await ask('credentials', 'github.com')).data.request;
  assert.equal(req.expiresAt - req.createdAt, 1200);
  assert.equal((await getRequest(req.id, 5)).data.request.status, 'expired');
  assert.equal((await answer(SHORT, req.id, { username: USER, password: PASS })).status, 409);
  req = (await ask('credentials', 'github.com')).data.request;
  await answer(SHORT, req.id, { username: USER, password: PASS });
  await sleep(1500);
  assert.equal((await typeIt('github.com', 'password')).status, 404);
  assert.equal((await getRequest(req.id)).data.request.status, 'unused');
  req = (await ask('code', 'github.com')).data.request;
  await answer(SHORT, req.id, { code: CODE });
  await sleep(1500);
  assert.equal((await typeIt('github.com', 'code')).status, 404);
  assert.equal((await getRequest(req.id)).data.request.status, 'unused');
  const history = (await phone('GET', '/api/state', { token: SHORT })).data.history;
  assert.deepEqual(history.slice(0, 3).map(h => h.status), ['unused', 'unused', 'expired']);
  checks.push('Requests expire; held values are dropped when their hold runs out (status unused)');
  await stopBroker(broker);
  broker = null;

  // --- login starts the broker when a phone is paired -------------------------------------
  r = await client(['login', 'github.com', '--wait', '0']);
  assert.equal(r.code, 75, r.out);
  assert.ok(existsSync(join(DIR, 'broker.pid')));
  r = await client(['stop']);
  assert.equal(r.code, 0, r.out);
  assert.equal(existsSync(SOCK), false);
  checks.push('login starts the broker in the background when a phone is paired; broker stop stops it');

  // --- nothing leaked ---------------------------------------------------------------------
  const places = { 'state.json': readFileSync(join(DIR, 'state.json'), 'utf8'), 'broker output': output,
    'background log': existsSync(join(DIR, 'broker.log')) ? readFileSync(join(DIR, 'broker.log'), 'utf8') : '',
    'responses and command output': seen.join('\n'), 'stand-in log': readFileSync(TYPED_LOG, 'utf8'),
    'push payloads': pushes.map(x => x.body.toString('latin1')).join('') };
  for (const [where, content] of Object.entries(places)) for (const value of VALUES) assert.ok(!content.includes(value), `a value showed up in ${where}`);
  assert.equal(statSync(join(DIR, 'state.json')).mode & 0o777, 0o600);
  checks.push('No value appears in state.json, the broker\'s output, any response, command output or push');

  console.log(JSON.stringify({ checks }, null, 1));
  console.log(`PASS: ${checks.length} broker checks`);
} finally {
  if (broker) await stopBroker(broker).catch(() => {});
  cdp.close(); pushService.close();
  rmSync(TMP, { recursive: true, force: true });
}
