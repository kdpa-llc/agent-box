// Phone app checks against a disposable stand-in, using only Node and a fresh Chrome.
// Run: node tests/app-check.mjs (Node 22+). CHROME_BIN can select the browser.
// APP_CHECK_SHOTS=1 also saves the four captures in docs/app/.
// The last part serves the app from the real broker (box-broker.mjs), with stand-ins for the
// box and the typing command, to check that the two agree on the contract.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import { mkdtemp, rm, mkdir, writeFile, access } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const candidates = process.env.CHROME_BIN ? [process.env.CHROME_BIN] :
  ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'google-chrome', 'chromium'];
let chrome;
for (const candidate of candidates) {
  if (candidate.includes('/')) { try { await access(candidate); chrome = candidate; break; } catch {} }
  else if (spawnSync('which', [candidate]).status === 0) { chrome = candidate; break; }
}
if (!chrome) { console.log('SKIP app-check: no Chrome or Chromium found. Set CHROME_BIN to run it.'); process.exit(0); }
if (!globalThis.WebSocket) throw Error('app-check needs Node 22 or newer with built-in WebSocket.');
const scratch = await mkdtemp(join(tmpdir(), 'agent-box-app-check-'));
const children = []; let ws; let next = 0; const waiting = new Map(); const errors = [], violations = [];
const checks = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, describe, timeout = 7000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { const value = await read(); if (value) return value; await pause(40); }
  throw Error('Timed out: ' + describe);
}
function launch(command, args, pattern, stream) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child);
  let diagnostic = ''; child.stderr.on('data', bytes => { diagnostic += bytes; });
  let output = ''; child[stream].on('data', bytes => { output += bytes; });
  return until(() => {
    if (child.exitCode !== null) throw Error(`${command} exited: ${output} ${diagnostic}`);
    return output.match(pattern)?.[1];
  }, 'start ' + command);
}
const call = (method, params = {}, sessionId) => {
  const id = ++next;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiting.delete(id); reject(Error('CDP timeout: ' + method)); }, 15000);
    waiting.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
};
try {
  const origin = await launch(process.execPath, [join(root, 'tests/app-stub.mjs')], /Agent Box stub: (http:\/\/[^\s]+)/, 'stdout');
  const debug = await launch(chrome, ['--headless=new', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    '--user-data-dir=' + join(scratch, 'profile'), '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    ...(process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : []), 'about:blank'], /DevTools listening on (ws:\/\/[^\s]+)/, 'stderr');
  ws = new WebSocket(debug); await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = event => {
    const message = JSON.parse(event.data); const pending = waiting.get(message.id);
    if (pending) { waiting.delete(message.id); message.error ? pending.reject(Error(message.error.message)) : pending.resolve(message.result); }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') errors.push('console.error');
    if (message.method === 'Log.entryAdded' && message.params.entry.source === 'security') violations.push(message.params.entry.text);
  };
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
  const cdp = (method, params = {}) => call(method, params, sessionId);
  for (const domain of ['Page', 'Runtime', 'Log', 'Network']) await cdp(domain + '.enable');
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `window.__csp=[];document.addEventListener('securitypolicyviolation',e=>window.__csp.push(e.violatedDirective));` });
  const evaluate = async expression => {
    const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.text + ' in ' + expression);
    return result.result.value;
  };
  const text = () => evaluate('document.body?.innerText || ""');
  const has = value => until(async () => (await text()).includes(value), value);
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const fill = (selector, value) => evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});n.value=${JSON.stringify(value)};n.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const control = async (name, body = {}) => (await fetch(origin + '/_test/' + name, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  const dimensions = async (width = 390, scheme = 'light') => {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 3, mobile: true });
    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
  };
  const capture = async (name, selector) => {
    await pause(100); await evaluate(selector ? `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'start'})` : 'window.scrollTo(0,0)');
    const { data } = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    if (process.env.APP_CHECK_SHOTS) await writeFile(join(root, 'docs/app', name), Buffer.from(data, 'base64'));
  };
  await mkdir(join(root, 'docs/app'), { recursive: true });
  await dimensions(); await cdp('Page.navigate', { url: origin }); await has('Pair your phone');
  const headers = await fetch(origin); assert.equal(headers.headers.get('cache-control'), 'no-cache');
  assert.equal(headers.headers.get('content-security-policy'), "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  await capture('pair-light.png');
  await fill('#pair-code', 'WRONG123'); await click('button[type=submit]'); await has('That code is wrong or expired');
  for (let i = 0; i < 5; i++) {
    await until(() => evaluate('!document.querySelector("button[type=submit]").disabled'), 'pair button');
    await click('button[type=submit]'); await pause(90);
  }
  await has('Too many tries'); await control('pair-reset'); await fill('#pair-code', 'abcd2345');
  await click('button[type=submit]'); await has('github.com');
  assert.ok(await evaluate('localStorage.getItem("agentbox.token")'));
  checks.push('Pairing: wrong code, too many tries, valid code and stored token');
  const ids = await evaluate('[...document.querySelectorAll("article")].map(n=>n.id)'); assert.equal(ids.length, 3);
  const [credentials, code, handoff] = ids;
  assert.deepEqual(await evaluate(`(()=>{const f=document.querySelector('#${credentials} form');return [...f.querySelectorAll('input')].map(n=>[n.autocomplete,n.getAttribute('autocapitalize'),n.getAttribute('autocorrect'),n.spellcheck,n.getAttribute('enterkeyhint')]);})()`),
    [['username', 'none', 'off', false, 'send'], ['current-password', null, null, false, 'send']]);
  assert.deepEqual(await evaluate(`(()=>{const n=document.querySelector('#${code}-code');return [n.autocomplete,n.inputMode];})()`), ['one-time-code', 'numeric']);
  await click(`#${code} .reveal`); assert.equal(await evaluate(`document.querySelector('#${code}-code').inputMode`), 'text');
  assert.equal(await evaluate(`document.querySelector('#${handoff} .live').target`), '_blank');
  for (const id of ids) assert.ok(await evaluate(`document.querySelector('#${id} .expiry').textContent.startsWith('Expires in')`));
  assert.ok(await evaluate(`document.querySelector('#${credentials} .primary').disabled`));
  await capture('requests-light.png');
  checks.push('All card kinds, form attributes, letters option, live link and expiry countdown');
  const values = ['phone-test-user-938', 'phone-test-password-752', 'phone-test-code-643'];
  await fill(`#${credentials}-username`, values[0]); await fill(`#${credentials}-password`, values[1]);
  await click(`#${credentials} .reveal`); assert.equal(await evaluate(`document.querySelector('#${credentials}-password').type`), 'text');
  await click(`#${credentials} .primary`);
  await until(async () => evaluate(`!document.querySelector('#${credentials}-password') || document.querySelector('#${credentials}-password').value === ''`), 'fields cleared');
  await until(async () => !(await evaluate(`!!document.getElementById('${credentials}')`)), 'card leaves');
  const seen = await control('seen'); assert.deepEqual(seen[0], { id: credentials, action: 'answer', body: { username: values[0], password: values[1] } });
  await dimensions(390, 'dark'); await capture('requests-dark.png', '#' + code);
  await fill(`#${code}-code`, values[2]); await click(`#${code} .primary`);
  await until(async () => (await control('seen')).length === 2, 'code sent');
  assert.deepEqual((await control('seen'))[1].body, { code: values[2] });
  await click(`#${handoff} .primary`); await until(async () => (await control('seen')).length === 3, 'handoff done');
  assert.deepEqual((await control('seen'))[2].body, {});
  const footprint = await evaluate('JSON.stringify([Object.entries(localStorage),Object.entries(sessionStorage),location.href,history.state])');
  for (const value of values) assert.equal(footprint.includes(value), false);
  checks.push('Each Send body is exact; fields clear; typed values never reach storage or the address');
  const arrived = (await control('add', { kind: 'credentials' })).request;
  await until(() => evaluate(`!!document.getElementById('${arrived.id}')`), 'long-poll arrival');
  await click(`#${arrived.id} .deny`); await until(async () => (await control('seen')).length === 4, 'deny sent');
  assert.deepEqual((await control('seen'))[3], { id: arrived.id, action: 'deny', body: {} });
  await has('Nothing waiting.');
  const expiring = (await control('add', { kind: 'code' })).request;
  await until(() => evaluate(`!!document.getElementById('${expiring.id}')`), 'expiry card');
  await control('expire', { id: expiring.id });
  await until(() => evaluate(`!document.getElementById('${expiring.id}')`), 'expired card leaves');
  checks.push('Long-poll adds a card without reloading; Deny posts an empty body; empty and expired states');
  for (const [status, expected] of [[409, 'already answered or withdrawn'], [404, 'This request is gone'], ['network', 'Your computer can’t be reached']]) {
    const r = (await control('add', { kind: 'code' })).request;
    await until(() => evaluate(`!!document.getElementById('${r.id}')`), 'error card');
    await fill(`#${r.id}-code`, values[2]);
    if (status === 'network') await cdp('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    else await control('fault', { id: r.id, status });
    await click(`#${r.id} .primary`); await has(expected);
    if (status === 'network') {
      await cdp('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      assert.equal(await evaluate(`document.getElementById('${r.id}-code').value`), values[2]);
      await click(`#${r.id} .primary`); await until(async () => (await control('seen')).some(s => s.id === r.id), 'network retry');
    }
  }
  checks.push('409 and 404 explain what happened; network failure keeps the form for retry');
  const focus = (await control('add', { kind: 'handoff' })).request;
  await until(() => evaluate(`!!document.getElementById('${focus.id}')`), 'focus card');
  await evaluate(`location.hash='#/r/${focus.id}'`);
  await until(() => evaluate(`document.activeElement.id === '${focus.id}'`), 'notification hash focuses card');
  await cdp('Page.reload'); await has(focus.site);
  await until(() => evaluate(`document.activeElement.id === '${focus.id}'`), 'cold notification link');
  checks.push('Notification links focus their card in an open app and after reload');
  for (const width of [320, 390]) for (const scheme of ['light', 'dark']) {
    await dimensions(width, scheme);
    for (const route of ['#/', '#/settings']) {
      await evaluate(`location.hash=${JSON.stringify(route)}`); await has(route.includes('settings') ? 'Unpair this phone' : 'Recent');
      assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth'), `${width} ${scheme} ${route} overflow`);
      assert.deepEqual(await evaluate('window.__csp'), []);
    }
  }
  await dimensions(390, 'dark'); await capture('settings-dark.png');
  await control('401'); await has('Pair your phone'); assert.equal(await evaluate('localStorage.getItem("agentbox.token")'), null);
  for (const width of [320, 390]) for (const scheme of ['light', 'dark']) {
    await dimensions(width, scheme); assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth'));
  }
  assert.deepEqual(await evaluate('window.__csp'), []); assert.deepEqual(errors, []); assert.deepEqual(violations, []);
  checks.push('401 forgets the token; every view fits 320/390 in light/dark; no JS or CSP errors');
  // The same app, served by the real broker: pair, answer a request, and have it typed.
  {
    const dir = await mkdtemp('/tmp/abx.');   // short, because the broker's socket path has a length limit
    try {
      const user = 'app-check@example.com', pass = 'app-check-Pass-9!';
      const sha = value => createHash('sha256').update(value).digest('hex');
      const standin = join(dir, 'type'), typedLog = join(dir, 'typed.log');
      await writeFile(standin, `#!${process.execPath}
const chunks = []; process.stdin.on('data', c => chunks.push(c));
process.stdin.on('end', () => {
  const sha = require('node:crypto').createHash('sha256').update(Buffer.concat(chunks)).digest('hex');
  require('node:fs').appendFileSync(${JSON.stringify(typedLog)}, JSON.stringify({ args: process.argv.slice(2), sha }) + '\\n');
  console.log('box-type: typed it into the stand-in');
});
`, { mode: 0o755 });
      const box = createServer((req, res) => res.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify([{ type: 'page', title: 'Sign in to Example', url: 'https://example.com/login?next=1' }])));
      box.listen(0, '127.0.0.1'); await once(box, 'listening');
      const probe = createServer().listen(0, '127.0.0.1'); await once(probe, 'listening');
      const port = probe.address().port; probe.close(); await once(probe, 'close');
      const sock = join(dir, 'b', 'agent.sock');
      children.push(spawn(process.execPath, [join(root, 'box-broker.mjs'), 'run'], { stdio: 'ignore', env: { ...process.env,
        BOX_BROKER_DIR: join(dir, 'b'), BOX_BROKER_PORT: String(port), BOX_CDP_PORT: String(box.address().port),
        BOX_BROKER_TYPE_CMD: standin, BOX_BROKER_APP_DIR: '', BOX_BROKER_APP_URL: '', AGENT_BOX_AS: '' } }));
      const agent = (method, path, body) => new Promise((resolve, reject) => {
        const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
        const req = request({ socketPath: sock, method, path, headers: data ? { 'content-type': 'application/json' } : {} }, res => {
          let answer = ''; res.on('data', c => { answer += c; });
          res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(answer || '{}') }));
        });
        req.on('error', reject); req.end(data);
      });
      await until(async () => { try { return (await agent('GET', '/agent/status')).status === 200; } catch { return false; } }, 'the broker to start');
      const { code } = (await agent('POST', '/agent/pair')).data;
      await dimensions(); await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/` }); await has('Pair your phone');
      await fill('#pair-code', code); await click('button[type=submit]'); await has('Nothing waiting');
      const made = await agent('POST', '/agent/requests', { kind: 'credentials', site: 'example.com', agent: 'app-check' });
      assert.equal(made.status, 201);
      const { id } = made.data.request;
      await until(() => evaluate(`!!document.getElementById('${id}')`), 'the card from the real broker');
      const shown = await text();
      assert.ok(shown.includes('Sign in to Example') && shown.includes('https://example.com/login') && !shown.includes('next=1'));
      await fill(`#${id}-username`, user); await fill(`#${id}-password`, pass);
      await click(`#${id} button[type=submit]`); await has('Sent.');
      assert.equal((await agent('GET', `/agent/requests/${id}?wait=5`)).data.request.status, 'ready');
      for (const field of ['username', 'password']) assert.equal((await agent('POST', '/agent/type', { site: 'example.com', field })).data.exit, 0);
      const typed = (await readFile(typedLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      assert.deepEqual(typed.map(entry => entry.sha), [sha(user), sha(pass)]);
      assert.ok(typed[1].args.includes('--clear-after'));
      await has(' · used · ');
      assert.equal((await agent('POST', '/agent/type', { site: 'example.com', field: 'password' })).status, 404);
      assert.deepEqual(await evaluate('window.__csp'), []); assert.deepEqual(errors, []); assert.deepEqual(violations, []);
      box.close();
      checks.push('With the real broker: the app pairs, shows the page the broker saw, and its answer is typed once');
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
  const listeners = {}; const shown = []; const navigation = [];
  const worker = { location: { origin }, registration: { showNotification: async (...args) => shown.push(args) },
    addEventListener: (name, listener) => { listeners[name] = listener; },
    clients: { matchAll: async () => [{ url: origin, navigate: async url => navigation.push(url), focus: async () => navigation.push('focused') }],
      openWindow: async url => navigation.push(url) } };
  runInNewContext(await readFile(join(root, 'app/sw.js'), 'utf8'), { self: worker, URL });
  const notification = { title: 'Code needed', body: 'example.com is asking for a code', tag: 'r_test0001', navigate: origin + '/#/r/r_test0001' };
  let task;
  listeners.push({ data: { json: () => ({ web_push: 8030, notification }) }, waitUntil: promise => { task = promise; } }); await task;
  assert.equal(shown[0][0], notification.title); assert.equal(shown[0][1].body, notification.body);
  assert.equal(shown[0][1].tag, notification.tag); assert.equal(shown[0][1].data.navigate, notification.navigate);
  listeners.notificationclick({ notification: { data: { navigate: notification.navigate }, close() {} }, waitUntil: promise => { task = promise; } }); await task;
  assert.deepEqual(navigation, [notification.navigate, 'focused']);
  worker.clients.matchAll = async () => []; navigation.length = 0;
  listeners.notificationclick({ notification: { data: { navigate: notification.navigate }, close() {} }, waitUntil: promise => { task = promise; } }); await task;
  assert.deepEqual(navigation, [notification.navigate]);
  checks.push('Service worker reads the declarative payload and focuses or opens the notification link');
  for (const check of checks) console.log('PASS ' + check);
  if (process.env.APP_CHECK_SHOTS) console.log('PASS four captures saved in docs/app/ (390 × 844, scale 3)');
  console.log('app-check: all checks passed');
} finally {
  ws?.close();
  await Promise.all(children.map(child => new Promise(resolve => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve); child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000); timer.unref();
  })));
  // Only this run’s own temporary profile is removed.
  await rm(scratch, { recursive: true, force: true });
}
