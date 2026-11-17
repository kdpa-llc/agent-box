// A disposable phone broker. No box, push service or saved values.
// Run: node tests/app-stub.mjs [port] (default: a free port).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomBytes, createECDH } from 'node:crypto';

export function makeStub() {
  const token = randomBytes(32).toString('base64url');
  const key = createECDH('prime256v1'); key.generateKeys();
  const code = 'ABCD2345'; let tries = 0, paired = false, pairUsed = false, deviceName = 'iPhone', subscribed = false, unauthorized = false;
  let rev = 1, sequence = 0; const waiters = new Set(), faults = new Map(), seen = [];
  let requests = [], history = [];
  function add(kind = 'credentials', extra = {}) {
    const id = 'r_' + String(++sequence).padStart(8, '0');
    const request = { id, kind, site: kind === 'credentials' ? 'github.com' : kind === 'code' ? 'example.com' : 'accounts.example.org',
      page: { title: kind === 'credentials' ? 'Sign in to GitHub' : 'Verify your account', url: kind === 'credentials' ? 'https://github.com/login' : 'https://example.com/verify' },
      agent: 'Claude: publish the package', note: kind === 'handoff' ? 'Finish the security check.' : null,
      viewerUrl: kind === 'handoff' ? 'https://example.org/live' : null,
      status: 'pending', createdAt: Date.now(), expiresAt: Date.now() + 1800000, ...extra };
    requests.push(request); change(); return request;
  }
  function change() { rev++; for (const wake of waiters) wake(); }
  function snapshot() { return { rev, version: '1.5.0', device: { id: 'd_test', name: deviceName },
    push: { publicKey: key.getPublicKey().toString('base64url'), subscribed }, requests, history: history.slice(0, 30) }; }
  function finish(request, status) {
    requests = requests.filter(r => r !== request);
    history.unshift({ id: request.id, kind: request.kind, site: request.site, agent: request.agent, status, at: Date.now() }); change();
  }
  add('credentials'); add('code'); add('handoff');
  history = ['done', 'unused', 'denied', 'expired', 'cancelled'].map((status, i) => ({
    id: 'r_old0000' + i, site: 'example.net', kind: ['credentials', 'code', 'handoff'][i % 3], agent: null, status, at: Date.now() - (i + 1) * 3600000
  }));
  const files = { 'index.html': 'text/html; charset=utf-8', 'app.css': 'text/css; charset=utf-8',
    'app.js': 'text/javascript; charset=utf-8', 'sw.js': 'text/javascript; charset=utf-8',
    'manifest.webmanifest': 'application/manifest+json', 'icon-180.png': 'image/png', 'icon-192.png': 'image/png', 'icon-512.png': 'image/png' };
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-cache'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    const error = (status, error, detail = 'The request could not be completed.') => send(status, { error, detail });
    try {
      const url = new URL(req.url, 'http://' + req.headers.host); let body = {};
      if (req.method === 'POST') {
        if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return error(403, 'forbidden');
        if (req.headers['content-type'] !== 'application/json') return error(422, 'invalid');
        let raw = ''; for await (const bytes of req) { raw += bytes; if (Buffer.byteLength(raw) > 16384) return error(422, 'invalid'); }
        try { body = JSON.parse(raw); } catch { return error(422, 'invalid'); }
      }
      // Test controls are available only on this loopback stand-in.
      if (url.pathname.startsWith('/_test/')) {
        const command = url.pathname.slice(7);
        if (command === 'reset') { requests = []; faults.clear(); unauthorized = false; change(); }
        else if (command === 'pair-reset') { tries = 0; pairUsed = false; }
        else if (command === 'add') return send(200, { request: add(body.kind, body.extra) });
        else if (command === 'expire') { const r = requests.find(r => r.id === body.id); if (r) finish(r, 'expired'); }
        else if (command === 'fault') faults.set(body.id, body.status);
        else if (command === '401') { unauthorized = true; change(); }
        else if (command === 'seen') return send(200, seen);
        else return error(404, 'not_found');
        return send(200, { ok: true });
      }
      if (url.pathname === '/api/pair' && req.method === 'POST') {
        if (tries >= 5) return error(429, 'too_many_tries');
        if (pairUsed || String(body.code).replace(/\s/g, '').toUpperCase() !== code) { tries++; return error(403, 'bad_code'); }
        if (typeof body.name !== 'string' || body.name.length > 40) return error(422, 'invalid');
        paired = true; pairUsed = true; deviceName = body.name; return send(200, { deviceId: 'd_test', token });
      }
      if (url.pathname.startsWith('/api/')) {
        if (!paired || unauthorized || req.headers.authorization !== 'Bearer ' + token) return error(401, 'unauthorized');
        if (url.pathname === '/api/state' && req.method === 'GET') {
          if (Number(url.searchParams.get('since')) >= rev) await new Promise(resolve => {
            let timer; const wake = () => { clearTimeout(timer); waiters.delete(wake); resolve(); };
            waiters.add(wake); timer = setTimeout(wake, Math.min(25, Number(url.searchParams.get('wait')) || 0) * 1000);
            res.on('close', wake);
          });
          return unauthorized ? error(401, 'unauthorized') : send(200, snapshot());
        }
        const match = url.pathname.match(/^\/api\/requests\/([^/]+)\/(answer|deny)$/);
        if (match && req.method === 'POST') {
          const [, id, action] = match; const fault = faults.get(id); faults.delete(id);
          if (fault === 'network') { req.socket.destroy(); return; }
          if (fault) return error(fault, fault === 409 ? 'not_pending' : 'not_found');
          const request = requests.find(r => r.id === id);
          if (!request) return error(404, 'not_found');
          const expected = action === 'deny' || request.kind === 'handoff' ? [] : request.kind === 'code' ? ['code'] : ['password', 'username'];
          if (JSON.stringify(Object.keys(body).sort()) !== JSON.stringify(expected) || expected.some(k => typeof body[k] !== 'string' || body[k].length > 1024) ||
            (action === 'answer' && request.kind !== 'handoff' && !(body.password || body.code))) return error(422, 'invalid');
          seen.push({ id, action, body }); finish(request, action === 'deny' ? 'denied' : 'done'); return send(200, { ok: true });
        }
        if (req.method === 'POST' && url.pathname === '/api/unpair') { paired = false; return send(200, { ok: true }); }
        if (req.method === 'POST' && ['/api/push/subscribe', '/api/push/unsubscribe', '/api/push/test'].includes(url.pathname)) {
          if (url.pathname.endsWith('/subscribe')) {
            let endpoint; try { endpoint = new URL(body.subscription?.endpoint); } catch { return error(422, 'invalid'); }
            const host = endpoint.hostname;
            const known = host === 'fcm.googleapis.com' || ['.push.apple.com', '.push.services.mozilla.com', '.notify.windows.com'].some(suffix => host.endsWith(suffix));
            if (endpoint.protocol !== 'https:' || !known) return error(422, 'invalid');
            subscribed = true;
          }
          if (url.pathname.endsWith('/unsubscribe')) subscribed = false;
          change(); return send(200, { ok: true });
        }
        return error(404, 'not_found');
      }
      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (req.method !== 'GET' || !Object.hasOwn(files, name)) return error(404, 'not_found');
      if (name === 'index.html') res.setHeader('Content-Security-Policy', "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
      const bytes = await readFile(new URL('../app/' + name, import.meta.url));
      res.writeHead(200, { 'Content-Type': files[name] }); res.end(bytes);
    } catch { if (!res.headersSent) error(422, 'invalid'); else res.end(); }
  });
  return { server, code };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { server, code } = makeStub();
  server.listen(Number(process.argv[2] || 0), '127.0.0.1', () => {
    console.log(`Agent Box stub: http://127.0.0.1:${server.address().port}`);
    console.log(`Pairing code: ${code}`);
  });
  const close = () => { server.closeAllConnections(); server.close(() => process.exit(0)); };
  process.on('SIGTERM', close); process.on('SIGINT', close);
}
