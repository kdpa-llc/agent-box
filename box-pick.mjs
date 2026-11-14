#!/usr/bin/env node
// box-pick: ask a fast decision model which element on a page does what you want,
// and optionally click it. It runs on this machine and talks to the box's Chromium
// over its DevTools protocol (CDP).
//
//   box-pick "<what to do>" (--page <text> | --tab <id>) [--click] [--min <0-1>]
//            [--provider openrouter|jev|openai] [--model <id>] [--cdp <url>]
//   box-pick key <openrouter|jev|openai> --from-file <path>
//
// The page's visible buttons, links and fields go to the model as a numbered list:
// their kind, their label, and the heading or form they sit in. Never what is typed
// in a field. Emails and long runs of digits in labels are replaced first. The model
// answers with one number from that list, or "none", and a confidence. It never
// writes selectors or code. Page text is data, never instructions.
//
// Providers, all paid per call, for input tokens only:
// - openrouter: OpenRouter's decisions endpoint (POST /api/alpha/decisions), billed to
//   the OpenRouter account. Jev by default (~typesafe/jev-latest); --model
//   openai/gpt-6-luna-decisions runs OpenAI's model there instead. Jev's request shape.
// - jev: TypeSafe's own API (POST /v1/systemone), about $0.04 per million tokens.
// - openai: OpenAI's Decisions API on gpt-6-luna (POST /v1/decisions), $0.10 per million.
//
// Exit codes: 0 picked (and clicked with --click); 2 usage; 3 not sure, nothing
// clicked; 4 the page or tab was not found, or two pages match; 1 anything else.
import { readFileSync, writeFileSync, mkdirSync, statSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const KEYS_DIR = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'agent-box', 'keys');
const PROVIDERS = {
  openrouter: { env: 'OPENROUTER_API_KEY', url: process.env.BOX_PICK_OPENROUTER_URL || 'https://openrouter.ai/api/alpha/decisions', model: '~typesafe/jev-latest', shape: 'jev' },
  jev: { env: 'TYPESAFE_API_KEY', url: process.env.BOX_PICK_JEV_URL || 'https://api.typesafe.ai/v1/systemone', model: 'jev-latest', shape: 'jev' },
  openai: { env: 'OPENAI_API_KEY', url: process.env.BOX_PICK_OPENAI_URL || 'https://api.openai.com/v1/decisions', model: 'gpt-6-luna', shape: 'openai' },
};
const MOST = 200; // elements offered to the model; Jev and OpenAI both take up to 255 options

const say = (...a) => console.error('box-pick:', ...a);
const stop = (code, ...a) => { say(...a); process.exit(code); };

function keyFor(name) {
  const p = PROVIDERS[name];
  if (process.env[p.env]) return process.env[p.env].trim();
  const file = join(KEYS_DIR, name);
  try {
    if ((statSync(file).mode & 0o077) !== 0) stop(1, `${file} can be read by others; run: chmod 600 ${file}`);
    return readFileSync(file, 'utf8').trim();
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// --- the page ---------------------------------------------------------------

// Runs in the page. Lists what a person could click or type into, in reading order,
// keeps the elements for a later click, and returns descriptions only.
const SNAPSHOT = `(() => {
  const scrub = s => String(s || '').replace(/\\s+/g, ' ').trim()
    .replace(/[^\\s@<>]+@[^\\s@<>]+\\.[a-z]{2,}/gi, '<email>').replace(/\\d[\\d\\s-]{5,}\\d/g, '<digits>').slice(0, 80);
  const shown = el => { const r = el.getBoundingClientRect(); return r.width > 2 && r.height > 2 && el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }); };
  const SEL = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [contenteditable=true], ' +
    '[role=button], [role=link], [role=checkbox], [role=radio], [role=switch], [role=tab], [role=menuitem], [role=option], [role=combobox], [role=textbox]';
  const kind = el => {
    const role = el.getAttribute('role');
    if (role) return role;
    if (el.tagName === 'A') return 'link';
    if (el.tagName === 'INPUT') return ['submit', 'button', 'reset', 'image'].includes(el.type) ? 'button' : el.type + ' field';
    if (el.tagName === 'SELECT') return 'dropdown';
    if (el.tagName === 'TEXTAREA' || el.isContentEditable) return 'text area';
    return el.tagName.toLowerCase();
  };
  const textOf = el => {
    const by = el.getAttribute('aria-labelledby');
    const named = by ? by.split(/\\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ') : '';
    const typed = ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable;
    const buttonValue = el.tagName === 'INPUT' && ['submit', 'button', 'reset'].includes(el.type) ? el.value : '';
    return el.getAttribute('aria-label') || named || [...(el.labels || [])].map(l => l.textContent).join(' ') ||
      (typed ? '' : el.innerText || el.textContent) || buttonValue || el.getAttribute('placeholder') ||
      el.getAttribute('title') || el.querySelector?.('img[alt]')?.alt || el.getAttribute('name') || '';
  };
  const where = el => {
    const legend = el.closest('fieldset')?.querySelector('legend')?.textContent;
    if (legend) return legend;
    // The nearest box around it that says where it is: a navigation bar, a footer, or
    // the first box with a heading of its own, looking a few levels up.
    for (let box = el.parentElement, up = 0; box && box !== document.documentElement && up < 8; box = box.parentElement, up++) {
      if (box.matches('nav, [role=navigation]')) return 'navigation';
      if (box.matches('footer, [role=contentinfo]')) return 'footer';
      const h = box.querySelector('h1, h2, h3, h4, legend, [role=heading]');
      if (h && h !== el && !el.contains(h)) return h.textContent;
      if (box.matches('header, [role=banner]')) return 'header';
    }
    return '';
  };
  const els = [...new Set(document.querySelectorAll(SEL))].filter(el => !el.disabled && shown(el));
  const inView = el => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; };
  const ordered = [...els.filter(inView), ...els.filter(el => !inView(el))].slice(0, ${MOST});
  window[Symbol.for('agent-box.pick')] = ordered;
  return {
    title: scrub(document.title), where: location.origin + location.pathname.slice(0, 60),
    headings: [...document.querySelectorAll('h1, h2, h3')].filter(shown).slice(0, 8).map(h => scrub(h.textContent)).filter(Boolean),
    elements: ordered.map(el => ({ kind: kind(el), label: scrub(textOf(el)), in: scrub(where(el)).slice(0, 40),
      ...(el.type === 'checkbox' || el.type === 'radio' ? { checked: el.checked } : {}), ...(inView(el) ? {} : { offscreen: true }) })),
  };
})()`;

// Runs in the page before a click: the element is still there and nothing covers it.
const PLACE = n => `(() => {
  const el = (window[Symbol.for('agent-box.pick')] || [])[${n}];
  if (!el || !el.isConnected) return { error: 'gone' };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
  const top = document.elementFromPoint(x, y);
  if (!top || !(top === el || el.contains(top) || top.contains(el))) return { error: 'covered' };
  return { x, y };
})()`;

class Page {
  constructor(url) { this.ws = new WebSocket(url); this.next = 0; this.waiting = new Map();
    this.ready = new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = () => reject(Error('cannot connect to the page')); });
    this.ws.onmessage = event => { const m = JSON.parse(event.data); const w = this.waiting.get(m.id); if (!w) return;
      this.waiting.delete(m.id); m.error ? w.reject(Error(m.error.message)) : w.resolve(m.result); }; }
  call(method, params = {}) { const id = ++this.next; this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.waiting.set(id, { resolve, reject })); }
  async run(expression) { const r = await this.call('Runtime.evaluate', { expression, returnByValue: true });
    if (r.exceptionDetails) throw Error('the page script failed'); return r.result.value; }
  close() { this.ws.close(); }
}

async function findPage(cdp, { tab, page }) {
  let list;
  try { list = await (await fetch(cdp + '/json/list', { signal: AbortSignal.timeout(3000) })).json(); }
  catch { stop(4, `can't reach the browser at ${cdp}; run: agent-box up`); }
  const pages = list.filter(t => t.type === 'page');
  const found = tab ? pages.filter(t => t.id === tab) : pages.filter(t => t.url.includes(page) || (t.title || '').includes(page));
  if (found.length === 1) return found[0];
  if (!found.length) stop(4, `no page matches ${tab ? `tab ${tab}` : `"${page}"`}`);
  stop(4, `${found.length} pages match "${page}"; use a longer part of the address, or --tab <id>:\n` +
    found.map(t => `  ${t.id}  ${t.url.slice(0, 80)}`).join('\n'));
}

// --- the question -----------------------------------------------------------

const NONE = 'none';
const line = e => `${e.kind}${e.label ? ` "${e.label}"` : ''}${e.in ? ` (in: ${e.in})` : ''}${'checked' in e ? (e.checked ? ' [checked]' : ' [not checked]') : ''}${e.offscreen ? ' [below the fold]' : ''}`;

// The task and the numbered outline go in the state; the options are just the numbers
// and "none". Of four ways tried on 18 labelled cases on three pages (13 Nov 2026, Jev
// 1.14 through OpenRouter), this one was right 17 times, every right answer at 0.84
// confidence or more and the one miss at 0.66: hence --min 0.8. With the goal in the
// question and the labels as option descriptions, right answers went as low as 0.46;
// with the labels as option names, Jev said "none" to nearly everything.
function question(goal, snap) {
  const instructions = 'Which element should be clicked to do the task? Answer none if no element does it.';
  const state = { task: goal, page: { title: snap.title, address: snap.where, headings: snap.headings },
    elements: snap.elements.map((e, i) => `e${i + 1}: ${line(e)}`) };
  const options = [...snap.elements.map((e, i) => `e${i + 1}`), NONE];
  return { instructions, state, options };
}
function requestBody(provider, model, q) {
  return PROVIDERS[provider].shape === 'jev'
    ? { model, state: q.state, questions: { target: { type: 'choice', instructions: q.instructions, criteria: Object.fromEntries(q.options.map(o => [o, null])) } } }
    : { model, input: JSON.stringify(q.state), questions: [{ type: 'choice', name: 'target', instructions: q.instructions, choices: q.options.map(value => ({ value })) }] };
}

async function ask(provider, key, q, model) {
  const p = PROVIDERS[provider];
  model ||= p.model;
  const jevShape = p.shape === 'jev';
  const body = requestBody(provider, model, q);
  const started = Date.now();
  let response;
  for (let attempt = 0; ; attempt++) {
    response = await fetch(p.url, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) }).catch(() => null);
    if (!response) stop(1, `${provider} did not answer`);
    if (![429, 529, 503].includes(response.status) || attempt === 2) break;
    await new Promise(r => setTimeout(r, 500 * 2 ** attempt));
  }
  if (!response.ok) {
    // The provider's own words, for a wrong model id or a refused request. Cut short.
    const said = await response.json().then(d => d?.error?.message ?? (typeof d?.detail === 'string' ? d.detail : JSON.stringify(d?.detail ?? d?.error ?? '')), () => '');
    stop(1, `${provider} answered ${response.status}${response.status === 401 ? ': the key was refused' : ''}${said ? `: ${String(said).slice(0, 200)}` : ''}`);
  }
  const data = await response.json();
  const answer = jevShape ? data.answers?.target : data.answers?.find(a => a.name === 'target');
  if (!answer?.choice) stop(1, `${provider} gave no answer`);
  const probabilities = jevShape ? Object.entries(answer.probabilities ?? {})
    : (answer.probabilities ?? []).map(p => [p.value, p.probability]);
  return { choice: String(answer.choice), confidence: Number(answer.confidence ?? 0), probabilities, model: data.model ?? model, ms: Date.now() - started };
}

// --- the command --------------------------------------------------------------

function parse(argv) {
  const o = { goal: null, page: null, tab: null, click: false, min: 0.8, provider: process.env.BOX_PICK_PROVIDER || null, cdp: process.env.BOX_PICK_CDP || 'http://127.0.0.1:9222', model: process.env.BOX_PICK_MODEL || null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], value = () => argv[++i] ?? stop(2, `${a} needs a value`);
    if (a === '--page') o.page = value();
    else if (a === '--tab') o.tab = value();
    else if (a === '--click') o.click = true;
    else if (a === '--dry-run') o.dry = true;
    else if (a === '--min') o.min = Number(value());
    else if (a === '--provider') o.provider = value();
    else if (a === '--model') o.model = value();
    else if (a === '--cdp') o.cdp = value();
    else if (a.startsWith('-')) stop(2, `unknown option ${a}`);
    else if (o.goal === null) o.goal = a;
    else stop(2, 'put what to do in one quoted argument');
  }
  return o;
}

const USAGE = `usage: agent-box pick "<what to do>" (--page <part of the address or title> | --tab <id>) [--click] [--min 0.8] [--provider openrouter|jev|openai] [--model <id>] [--dry-run]
       agent-box pick key <openrouter|jev|openai> --from-file <path>`;

const [first, ...rest] = process.argv.slice(2);
if (!first || first === '--help' || first === '-h') { console.log(USAGE); process.exit(first ? 0 : 2); }

if (first === 'key') {
  const [name, flag, path] = rest;
  if (!PROVIDERS[name] || flag !== '--from-file' || !path) stop(2, USAGE);
  const key = readFileSync(path, 'utf8').trim();
  if (!key || /\s/.test(key)) stop(1, 'that file does not hold a key');
  mkdirSync(KEYS_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(join(KEYS_DIR, name), key + '\n', { mode: 0o600 });
  chmodSync(join(KEYS_DIR, name), 0o600);
  console.log(`box-pick: saved the ${name} key in ${join(KEYS_DIR, name)}`);
  process.exit(0);
}

const o = parse([first, ...rest]);
if (!o.goal?.trim() || (!o.page && !o.tab) || (o.page && o.tab)) stop(2, USAGE);
if (!(o.min >= 0 && o.min <= 1)) stop(2, '--min is a number from 0 to 1');
if (typeof WebSocket !== 'function') stop(1, 'needs Node 22 or newer');
const provider = o.provider ?? Object.keys(PROVIDERS).find(name => keyFor(name)) ?? (o.dry ? 'openrouter' : null);
if (!provider) stop(1, `no key. Save one first: agent-box pick key openrouter --from-file <path> (or jev, openai), or set ${Object.values(PROVIDERS).map(p => p.env).join(', ')}`);
if (!PROVIDERS[provider]) stop(2, '--provider is openrouter, jev or openai');
const key = o.dry ? null : keyFor(provider);
if (!key && !o.dry) stop(1, `no ${provider} key: agent-box pick key ${provider} --from-file <path>, or set ${PROVIDERS[provider].env}`);

const target = await findPage(o.cdp, o);
const page = new Page(target.webSocketDebuggerUrl);
try {
  await page.ready;
  const snap = await page.run(SNAPSHOT);
  if (!snap.elements.length) stop(3, 'the page shows nothing to click');
  const q = question(o.goal, snap);
  // --dry-run: what would be sent, and where. Nothing is sent and no key is needed.
  if (o.dry) { console.log(JSON.stringify({ url: PROVIDERS[provider].url, body: requestBody(provider, o.model || PROVIDERS[provider].model, q) }, null, 1)); process.exit(0); }
  const a = await ask(provider, key, q, o.model);
  const offered = new Map(q.options.map((name, i) => [name, i < snap.elements.length ? i : null]));
  if (!offered.has(a.choice)) stop(1, `${provider} answered with an element that was not offered`);
  const n = offered.get(a.choice);
  if (n !== null && !(Number.isInteger(n) && n >= 0 && n < snap.elements.length)) stop(1, `${provider} answered with an element that was not offered`);
  const label = id => offered.get(id) == null ? 'none' : line(snap.elements[offered.get(id)]);
  const number = id => offered.get(id) == null ? 'none' : `e${offered.get(id) + 1}`;
  const others = a.probabilities.filter(([id]) => id !== a.choice).sort((x, y) => y[1] - x[1]).slice(0, 3)
    .map(([id, p]) => ({ element: number(id), probability: Math.round(p * 100) / 100, is: label(id) }));
  const report = { page: snap.where, provider, model: a.model, ms: a.ms, element: n === null ? 'none' : `e${n + 1}`,
    is: n === null ? 'none of them' : line(snap.elements[n]), confidence: Math.round(a.confidence * 100) / 100, alternatives: others };
  const sure = n !== null && a.confidence >= o.min;
  if (o.click && sure) {
    const at = await page.run(PLACE(n));
    if (at.error) { report.clicked = false; report.why = at.error === 'gone' ? 'the element left the page' : 'something covers the element'; console.log(JSON.stringify(report, null, 1)); process.exit(3); }
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await page.call('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
    }
    report.clicked = true;
  } else if (o.click) report.clicked = false;
  if (!sure) report.note = n === null ? 'The model found no element for this.' : `Confidence is below ${o.min}; nothing was clicked. Check the alternatives, or look at the page yourself.`;
  console.log(JSON.stringify(report, null, 1));
  process.exit(sure ? 0 : 3);
} finally { page.close(); }
