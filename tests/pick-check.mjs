// Checks `agent-box pick` against a running box, with no real API call: a stand-in for
// Jev and for OpenAI's Decisions API runs on this machine, and a synthetic page opens in
// a browser context of its own, which is closed at the end. Nothing else in the box is
// touched. Run: agent-box up && node tests/pick-check.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CDP = process.env.BOX_CDP || 'http://127.0.0.1:9222';
const PICK = fileURLToPath(new URL('../box-pick.mjs', import.meta.url));
const TYPED = ['someone@example.com', 'not-a-real-password-71'];
const seen = [];

// The stand-in picks the option whose label quotes the words in the goal. "unsure" gives
// a low confidence; a goal no label quotes gives "none".
const server = createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const data = JSON.parse(body);
    seen.push({ path: req.url, auth: req.headers.authorization, data });
    const jev = !Array.isArray(data.questions); // Jev's shape, also on OpenRouter
    const q = jev ? data.questions.target : data.questions[0];
    const state = jev ? data.state : JSON.parse(data.input);
    const options = jev ? Object.keys(q.criteria) : q.choices.map(c => c.value);
    const goal = state.task;
    const words = goal.replace(/unsure/, '').trim();
    const hit = state.elements.find(e => e.includes(`"${words}"`));
    const choice = hit ? hit.split(':')[0] : 'none';
    assert.ok(options.includes(choice));
    const confidence = goal.includes('unsure') ? 0.4 : 0.95;
    const probabilities = options.map(v => [v, v === choice ? confidence : (1 - confidence) / (options.length - 1)]);
    const answer = jev
      ? { model: 'jev-test', answers: { target: { type: 'choice', choice, confidence, probabilities: Object.fromEntries(probabilities) } } }
      : { model: 'gpt-6-luna', answers: [{ type: 'choice', name: 'target', choice, confidence, probabilities: probabilities.map(([value, probability]) => ({ value, probability })) }] };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer));
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const api = `http://127.0.0.1:${server.address().port}`;

// A browser connection of our own, for the synthetic page's context.
const version = await (await fetch(CDP + '/json/version')).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let next = 0; const waiting = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); const w = waiting.get(m.id); if (w) { waiting.delete(m.id); m.error ? w.reject(Error(m.error.message)) : w.resolve(m.result); } };
const call = (method, params = {}, sessionId) => { const id = ++next; ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  return new Promise((resolve, reject) => waiting.set(id, { resolve, reject })); };

const { browserContextId } = await call('Target.createBrowserContext', { disposeOnDetach: true });
const checks = [];
try {
  const html = `<title>pick-check</title><h1>Sign in to Example</h1>
    <form onsubmit="return false"><input type="email" aria-label="Email" value="${TYPED[0]}">
      <input type="password" aria-label="Password" value="${TYPED[1]}">
      <button type="button" aria-label="Show password" onclick="window.clicked='eye'">o</button>
      <button onclick="window.clicked='signin'">Sign in</button></form>
    <p><a href="#help" onclick="window.clicked='help'">Write to help@example.org</a></p>
    <div id="cover" style="display:none;position:fixed;inset:0;background:#fff"></div>
    <button id="later" onclick="window.clicked='later'">Remind me later</button>`;
  const { targetId } = await call('Target.createTarget', { url: 'data:text/html,' + encodeURIComponent(html), browserContextId, background: true });
  const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
  const inPage = async expression => (await call('Runtime.evaluate', { expression, returnByValue: true }, sessionId)).result.value;
  await new Promise(r => setTimeout(r, 500));

  const pick = (args, env = {}) => new Promise(resolve => execFile(process.execPath, [PICK, ...args],
    { env: { ...process.env, BOX_PICK_CDP: CDP, BOX_PICK_JEV_URL: `${api}/v1/systemone`, BOX_PICK_OPENAI_URL: `${api}/v1/decisions`, BOX_PICK_OPENROUTER_URL: `${api}/api/alpha/decisions`, OPENROUTER_API_KEY: '',
      TYPESAFE_API_KEY: '', OPENAI_API_KEY: '', XDG_CONFIG_HOME: '/nonexistent', ...env } },
    (error, stdout, stderr) => resolve({ code: error ? error.code : 0, out: stdout ? JSON.parse(stdout) : null, err: stderr })));
  const jev = { TYPESAFE_API_KEY: 'test-jev-key' }, openai = { OPENAI_API_KEY: 'test-openai-key' };

  let r = await pick(['Sign in', '--tab', targetId, '--click'], jev);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual([r.out.provider, r.out.is, r.out.clicked], ['jev', 'button "Sign in" (in: Sign in to Example)', true]);
  assert.equal(await inPage('window.clicked'), 'signin');
  checks.push('Jev: the "Sign in" button is picked and clicked, not the "Show password" eye beside it');

  const sent = JSON.stringify(seen);
  for (const value of TYPED) assert.equal(sent.includes(value), false, 'a typed value reached the API');
  assert.equal(sent.includes('help@example.org'), false);
  assert.ok(sent.includes('<email>'));
  assert.equal(seen[0].auth, 'Bearer test-jev-key');
  assert.equal(seen[0].data.model, 'jev-latest');
  checks.push('What goes to the model holds no typed value, and emails in labels are replaced');

  await inPage('window.clicked = null');
  r = await pick(['Remind me later', '--tab', targetId, '--click', '--provider', 'openai'], openai);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual([r.out.model, r.out.clicked], ['gpt-6-luna', true]);
  assert.equal(await inPage('window.clicked'), 'later');
  assert.equal(seen.at(-1).data.questions[0].choices.at(-1).value, 'none');
  assert.equal(JSON.parse(seen.at(-1).data.input).task, 'Remind me later');
  checks.push('OpenAI Decisions on gpt-6-luna: same question shape, the element is clicked');

  await inPage('window.clicked = null');
  const openrouter = { OPENROUTER_API_KEY: 'test-openrouter-key' };
  r = await pick(['Sign in', '--tab', targetId, '--click'], openrouter);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual([r.out.provider, seen.at(-1).path, seen.at(-1).auth, seen.at(-1).data.model], ['openrouter', '/api/alpha/decisions', 'Bearer test-openrouter-key', '~typesafe/jev-latest']);
  assert.equal(await inPage('window.clicked'), 'signin');
  r = await pick(['Sign in', '--tab', targetId, '--model', 'openai/gpt-6-luna-decisions'], openrouter);
  assert.deepEqual([r.code, seen.at(-1).data.model, typeof seen.at(-1).data.questions.target], [0, 'openai/gpt-6-luna-decisions', 'object']);
  checks.push('OpenRouter: Jev by default, on its decisions endpoint with the OpenRouter key; --model picks another decision model there');

  await inPage('window.clicked = null');
  r = await pick(['Sign in unsure', '--tab', targetId, '--click'], jev);
  assert.equal(r.code, 3);
  assert.equal(r.out.clicked, false);
  assert.equal(await inPage('window.clicked'), null);
  r = await pick(['Delete my account', '--tab', targetId, '--click'], jev);
  assert.deepEqual([r.code, r.out.element, r.out.clicked], [3, 'none', false]);
  checks.push('Low confidence, or no element for it: exit 3 and nothing is clicked');

  await inPage("document.getElementById('cover').style.display = 'block'");
  r = await pick(['Sign in', '--tab', targetId, '--click'], jev);
  assert.deepEqual([r.code, r.out.clicked, r.out.why], [3, false, 'something covers the element']);
  assert.equal(await inPage('window.clicked'), null);
  checks.push('An element something else covers is not clicked');

  r = await pick(['Sign in', '--tab', targetId]);
  assert.equal(r.code, 1);
  assert.match(r.err, /no key/);
  r = await pick(['Sign in', '--tab', 'F'.repeat(32)], jev);
  assert.equal(r.code, 4);
  checks.push('No key: it stops before reading the page. An unknown tab: exit 4');

  const before = seen.length;
  r = await pick(['Sign in', '--tab', targetId, '--dry-run']);
  assert.equal(r.code, 0, r.err);
  assert.equal(seen.length, before);
  assert.equal(r.out.body.state.task, 'Sign in');
  for (const value of TYPED) assert.equal(JSON.stringify(r.out).includes(value), false);
  checks.push('--dry-run prints what would be sent, needs no key, and sends nothing');

  console.log(JSON.stringify({ checks }, null, 1));
} finally {
  await call('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
  ws.close(); server.close();
}
