'use strict';
// The Agent Box phone app. Its contract with the broker is docs/broker.md.
const main = document.querySelector('#main');
const nav = document.querySelector('nav');
const connection = document.querySelector('#connection');
let token = localStorage.getItem('agentbox.token');
let state = null;          // the last answer of /api/state
let generation = 0;        // one state loop at a time
let poll = null;           // that loop's request under way
let view = '';
let requestsView = null;   // kept while paired, so a half-typed card survives a look at Settings
let cards = new Map();
const completed = new Set();
let registration;
const kindNames = { credentials: 'Sign in', code: 'Code', handoff: 'Your turn' };
const endings = { done: 'used', unused: 'not used', denied: 'denied', expired: 'expired', cancelled: 'withdrawn' };

function el(tag, text, cls) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (cls) node.className = cls;
  return node;
}
function button(text, cls, action) {
  const node = el('button', text, cls); node.type = 'button';
  if (action) node.addEventListener('click', action);
  return node;
}
function input(parent, id, label, attrs = {}) {
  const caption = el('label', label); caption.htmlFor = id;
  const field = el('input'); field.id = id; field.name = id;
  for (const [key, value] of Object.entries(attrs)) field.setAttribute(key, value);
  parent.append(caption, field); return field;
}
function status(text, cls) { const node = el('p', text, cls); node.setAttribute('role', 'status'); return node; }
function notice(text = '') { connection.hidden = !text; connection.textContent = text; }
function clearValues(root) { root.querySelectorAll('input').forEach(field => { field.value = ''; }); }

function forget() {
  token = null; state = null; generation++; poll?.abort(); localStorage.removeItem('agentbox.token');
  clearValues(main); if (requestsView) clearValues(requestsView);
  requestsView = null; cards = new Map(); completed.clear(); view = ''; render(); notice();
}

async function api(path, body, signal) {
  const response = await fetch('/api/' + path, {
    method: body === undefined ? 'GET' : 'POST', cache: 'no-store', signal,
    headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  if (response.status === 401) { forget(); throw Object.assign(new Error(), { status: 401 }); }
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(), { status: response.status, code: data.error });
  return data;
}
function failure(error) {
  if (error.status === 409) return 'This request was already answered or withdrawn.';
  if (error.status === 404) return 'This request is gone. You can wait for a new one.';
  if (error.status === 422) return 'Check the fields and try again.';
  if (error.status) return 'That did not work. Try again.';
  return 'Your computer can’t be reached. Is it on, and is Tailscale connected? Try Send again.';
}

// --- pairing ---------------------------------------------------------------------

function appleTouch() {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
}
function browserTab() {
  return appleTouch() && !navigator.standalone && !matchMedia('(display-mode: standalone)').matches;
}
function pair() {
  main.replaceChildren(el('h1', 'Pair your phone'), el('p', 'Enter the code from your computer.', 'subtle'));
  if (browserTab()) main.append(el('p', permissionText(), 'banner'));
  const form = el('form', undefined, 'panel');
  const code = input(form, 'pair-code', 'Pairing code', { required: '', autocomplete: 'off', autocapitalize: 'characters', autocorrect: 'off', spellcheck: 'false' });
  // The computer prints the code as "ABCD 2345". Take it typed or pasted that way.
  code.addEventListener('input', () => { code.value = code.value.replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 8); });
  const name = input(form, 'phone-name', 'Phone name', { maxlength: '40', required: '', autocomplete: 'off' }); name.value = 'iPhone';
  const msg = status('', 'message error');
  const send = button('Pair', 'primary'); send.type = 'submit'; form.append(msg, send);
  form.addEventListener('submit', async event => {
    event.preventDefault(); send.disabled = true; msg.textContent = '';
    try {
      const result = await api('pair', { code: code.value, name: name.value });
      code.value = ''; token = result.token; localStorage.setItem('agentbox.token', token);
      view = ''; render(); start();
    } catch (error) {
      msg.textContent = error.code === 'bad_code' ? 'That code is wrong or expired. Check the code on your computer.' :
        error.code === 'too_many_tries' ? 'Too many tries. Make a new pairing code on your computer.' :
        error.status ? 'That did not work. Try again.' : 'Your computer can’t be reached. Is it on, and is Tailscale connected?';
    } finally { send.disabled = false; }
  });
  main.append(form, el('p', 'Your phone stays paired until you unpair it.', 'hint'));
}

// --- notifications ---------------------------------------------------------------

function pushAvailable() { return 'Notification' in window && 'PushManager' in window && 'serviceWorker' in navigator && !browserTab(); }
function permissionText() {
  if (browserTab()) return 'For notifications, add Agent Box to your Home Screen: tap Share, then Add to Home Screen. Open it there to pair.';
  if ('Notification' in window && Notification.permission === 'denied') return 'Allow notifications in your iPhone’s Settings, Notifications, Agent Box.';
  if (!pushAvailable()) return 'Notifications aren’t available in this browser.';
  return 'Get a notification when an agent needs you.';
}
async function notifications(enable, message) {
  try {
    if (enable) {
      // Permission is asked for first, inside the tap, before anything else is awaited.
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') { message.textContent = permissionText(); return; }
      const reg = await registration;
      if (!reg) throw new Error('no service worker');
      const key = state.push.publicKey.replace(/-/g, '+').replace(/_/g, '/');
      const bytes = Uint8Array.from(atob(key), c => c.charCodeAt(0));
      let subscription = await reg.pushManager.getSubscription();
      // A subscription made for another broker's key can't receive this broker's pushes.
      const madeFor = new Uint8Array(subscription?.options?.applicationServerKey || []);
      if (subscription && !(madeFor.length === bytes.length && madeFor.every((byte, i) => byte === bytes[i]))) {
        await subscription.unsubscribe(); subscription = null;
      }
      subscription ||= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes });
      await api('push/subscribe', { subscription: subscription.toJSON() });
    } else {
      await api('push/unsubscribe', {});
      const reg = await registration;
      const subscription = await reg?.pushManager.getSubscription();
      if (subscription) await subscription.unsubscribe();
    }
    state.push.subscribed = enable; render();
  } catch (error) {
    if (error.status === 401) return;
    message.textContent = error.status ? 'Your computer didn’t accept that. Try again.' :
      error instanceof TypeError ? 'Your computer can’t be reached. Is it on, and is Tailscale connected?' :
      `Notifications couldn’t be turned ${enable ? 'on' : 'off'} on this phone${error.name && error.name !== 'Error' ? ` (${error.name})` : ''}.`;
  }
}
function pushPanel(settings = false) {
  const box = el('section', undefined, settings ? 'panel' : 'banner');
  if (settings) box.append(el('h2', 'Notifications'));
  const message = status(state.push.subscribed ? 'Notifications are on.' : permissionText());
  box.append(message);
  if (pushAvailable() && Notification.permission !== 'denied') {
    box.append(button(state.push.subscribed ? 'Turn off notifications' : 'Turn on notifications', 'quiet',
      () => notifications(!state.push.subscribed, message)));
  }
  if (settings && state.push.subscribed) box.append(button('Send a test', 'quiet', async () => {
    try { await api('push/test', {}); message.textContent = 'Test sent. Check your notifications.'; }
    catch (error) {
      if (error.status === 401) return;
      message.textContent = error.code === 'not_subscribed' ? 'Turn on notifications first.' :
        error.status === 502 ? 'The notification could not be sent. Try again.' :
        error.status ? 'That did not work. Try again.' : 'Your computer can’t be reached. Is it on, and is Tailscale connected?';
    }
  }));
  return box;
}

// --- request cards ---------------------------------------------------------------

function card(request) {
  const node = el('article', undefined, 'card'); node.id = request.id; node.tabIndex = -1;
  node.append(el('div', kindNames[request.kind], 'kind'), el('h2', request.site));
  if (request.page?.title) node.append(el('div', request.page.title));
  if (request.page?.url) node.append(el('p', request.page.url, 'address'));
  const meta = el('p', undefined, 'meta');
  if (request.agent) meta.append(el('span', request.agent, 'agent'));
  const expiry = el('span', '', 'expiry'); expiry.dataset.expires = request.expiresAt; meta.append(expiry); node.append(meta);
  const form = el('form'); const fields = {};
  if (request.kind === 'credentials') {
    fields.username = input(form, request.id + '-username', 'Username', { autocomplete: 'username', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', maxlength: '1024', enterkeyhint: 'next' });
    fields.password = input(form, request.id + '-password', 'Password', { type: 'password', autocomplete: 'current-password', spellcheck: 'false', maxlength: '1024', enterkeyhint: 'send' });
    const reveal = button('Show password', 'quiet reveal', () => {
      const show = fields.password.type === 'password'; fields.password.type = show ? 'text' : 'password';
      reveal.textContent = show ? 'Hide password' : 'Show password'; reveal.setAttribute('aria-pressed', String(show));
    });
    reveal.setAttribute('aria-pressed', 'false');
    form.append(reveal, el('p', 'Tap a field, then the key above the keyboard, and search your password manager for this site.', 'hint'));
  } else if (request.kind === 'code') {
    fields.code = input(form, request.id + '-code', 'Code', { autocomplete: 'one-time-code', inputmode: 'numeric', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', maxlength: '1024', enterkeyhint: 'send' });
    const letters = button('Use letters', 'quiet reveal', () => {
      const numeric = fields.code.inputMode === 'numeric'; fields.code.inputMode = numeric ? 'text' : 'numeric';
      letters.textContent = numeric ? 'Use numbers' : 'Use letters'; fields.code.focus();
    });
    const heading = el('div', undefined, 'field-heading');
    const label = form.querySelector('label'); form.insertBefore(heading, label); heading.append(label, letters);
  } else {
    form.append(el('p', request.note));
    let url = null;
    try { url = new URL(request.viewerUrl); } catch {}
    if (url && (url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === '127.0.0.1'))) {
      const link = el('a', 'Open live view', 'live'); link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; form.append(link);
      // The live view is on the computer this app comes from. Say so when a link points elsewhere.
      if (url.hostname !== location.hostname) form.append(el('p', 'This link opens ' + url.host, 'address'));
    }
  }
  if (request.kind !== 'handoff') form.append(el('p', 'Used once. Not saved.', 'hint'));
  const msg = status('', 'message error');
  const send = button(request.kind === 'handoff' ? 'Done' : 'Send', 'primary'); send.type = 'submit';
  const deny = button(request.kind === 'handoff' ? 'Can’t' : 'Deny', 'quiet deny', () => submit(true));
  const required = fields.password || fields.code;
  const update = () => { if (!node.dataset.busy && !node.dataset.answered) send.disabled = !!required && !required.value; };
  // A password manager's fill may not announce itself, so the tick in countdown() checks too.
  node.update = update;
  for (const type of ['input', 'change', 'focusout']) form.addEventListener(type, update);
  update();
  async function submit(denied) {
    send.disabled = true; deny.disabled = true; msg.textContent = ''; node.dataset.busy = 'true';
    try {
      await api('requests/' + encodeURIComponent(request.id) + (denied ? '/deny' : '/answer'),
        denied ? {} : Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.value])));
      completed.add(request.id); node.dataset.answered = 'true';
      clearValues(form);
      form.replaceChildren(el('p', denied ? 'Denied.' : 'Sent. You can go back to what you were doing.'));
      setTimeout(() => leave(request.id, node), 650);
    } catch (error) {
      delete node.dataset.busy;
      if (error.status === 401) return;
      msg.textContent = failure(error);
      if (error.status === 404 || error.status === 409) {
        Object.values(fields).forEach(field => { field.value = ''; field.disabled = true; });
      } else { update(); deny.disabled = false; }
    }
  }
  form.addEventListener('submit', event => {
    event.preventDefault();
    // Return on the username goes to the password, not to a Send with no password.
    if (fields.password && !fields.password.value) { fields.password.focus(); return; }
    if (!send.disabled) submit(false);
  });
  form.append(msg, send, deny); node.append(form); return node;
}
function leave(id, node) {
  node.classList.add('leaving');
  setTimeout(() => { node.remove(); if (cards.get(id) === node) cards.delete(id); if (requestsView && state) updateRequests(); }, 180);
}
// A request that ended elsewhere: say why before the card goes, so it doesn't just vanish.
function retire(id, node) {
  if (node.dataset.gone) return;
  node.dataset.gone = 'true';
  clearValues(node);
  const ended = state.history.find(entry => entry.id === id)?.status;
  const why = ended === 'expired' ? 'This request expired.' : ended === 'cancelled' ? 'The agent withdrew this request.' :
    ended === 'denied' ? 'This request was denied on another phone.' : 'This request was answered on another phone.';
  node.querySelector('form').replaceChildren(el('p', why));
  setTimeout(() => leave(id, node), 2500);
}
function countdown() {
  document.querySelectorAll('[data-expires]').forEach(node => {
    const seconds = Math.max(0, Math.ceil((Number(node.dataset.expires) - Date.now()) / 1000));
    node.textContent = seconds ? `Expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : 'Expired';
  });
  for (const node of cards.values()) node.update?.();
}
// A notification's link, #/r/<id>, brings its card into view once. The address then goes back
// to the list, so a later update doesn't pull the focus out of the card he is typing in.
function focusRequest() {
  if (!location.hash.startsWith('#/r/') || !state || view !== 'requests') return;
  const node = document.getElementById(location.hash.slice(4));
  history.replaceState(null, '', '#/');
  if (node) { node.focus({ preventScroll: true }); node.scrollIntoView({ block: 'start' }); }
}

// --- views -----------------------------------------------------------------------

function buildRequests() {
  requestsView = el('div');
  const list = el('section'); list.id = 'cards'; list.setAttribute('aria-label', 'Pending requests');
  const banner = el('div'); banner.id = 'push-banner';
  const history = el('section'); history.id = 'history';
  requestsView.append(el('h1', 'Requests', 'sr-only'), list, banner, history);
  cards = new Map();
}
// Brings the cards and the history up to the state. A card that is still pending is never
// rebuilt, so what is typed in it stays.
function updateRequests() {
  const banner = requestsView.querySelector('#push-banner'); banner.replaceChildren();
  if (!state.push.subscribed) banner.append(pushPanel());
  const list = requestsView.querySelector('#cards');
  for (const [id, node] of cards) {
    if (!state.requests.some(request => request.id === id) && !node.dataset.busy && !node.dataset.answered) retire(id, node);
  }
  list.querySelector('.empty')?.remove();
  for (const request of state.requests) {
    if (cards.has(request.id) || completed.has(request.id)) continue;
    const node = card(request); cards.set(request.id, node); list.append(node);
  }
  if (!cards.size) list.append(el('p', 'Nothing waiting. We’ll let you know when you’re needed.', 'empty subtle'));
  const history = requestsView.querySelector('#history'); history.replaceChildren(el('h3', 'Recent'));
  if (!state.history.length) history.append(el('p', 'No requests yet.', 'subtle'));
  for (const entry of state.history) {
    const ending = entry.kind === 'handoff' && entry.status === 'done' ? 'done' : endings[entry.status] || entry.status;
    const when = new Date(entry.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const row = el('p', undefined, 'history');
    row.append(el('strong', entry.site), document.createTextNode(` · ${kindNames[entry.kind]} · ${ending} · ${when}`));
    history.append(row);
  }
}
function settings() {
  const page = el('div'); page.append(el('h1', 'Settings'), pushPanel(true));
  const info = el('section', undefined, 'panel'); info.append(el('h3', state.device.name), el('p', 'Version ' + state.version, 'subtle'));
  const message = status('', 'message error');
  // Unpairing can only be undone with a new code from the computer, so it takes two taps.
  let armedUntil = 0;
  const unpair = button('Unpair this phone', 'quiet danger', async () => {
    if (Date.now() > armedUntil) {
      armedUntil = Date.now() + 4000; unpair.textContent = 'Tap again to unpair';
      setTimeout(() => { unpair.textContent = 'Unpair this phone'; }, 4000); return;
    }
    try { await api('unpair', {}); forget(); } catch (error) { if (error.status !== 401) message.textContent = failure(error); }
  });
  info.append(unpair, message); page.append(info); return page;
}
function render() {
  const next = !token ? 'pair' : location.hash === '#/settings' ? 'settings' : 'requests';
  nav.hidden = next === 'pair';
  nav.querySelectorAll('a').forEach(link => {
    if ((link.id === 'settings-link') === (next === 'settings')) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  if (next === 'pair') { if (view !== next) pair(); view = next; return; }
  if (!state) { main.replaceChildren(status('Connecting to your computer…')); view = ''; return; }
  if (!requestsView) buildRequests();
  updateRequests();   // also behind Settings, so the cards follow the state
  // Settings holds nothing typed, so it is rebuilt; the requests view is the same node each time.
  if (next === 'settings') { main.replaceChildren(settings()); view = next; return; }
  if (view !== next) main.replaceChildren(requestsView);
  view = next;
  countdown(); focusRequest();
}

// --- following the broker ----------------------------------------------------------

async function start() {
  const run = ++generation;
  poll?.abort();
  let first = true, failures = 0;
  while (token && run === generation) {
    const controller = poll = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 35000);
    try {
      const result = await api(first || !state ? 'state' : `state?since=${state.rev}&wait=25`, undefined, controller.signal);
      if (run !== generation) return;
      const changed = first || !state || state.rev !== result.rev;
      state = result; first = false; failures = 0; notice(); if (changed) render();
    } catch (error) {
      if (run !== generation || error.status === 401) return;
      // One failure is often the phone waking up. Say so only when it repeats.
      if (++failures > 1) notice('Your computer can’t be reached. Is it on, and is Tailscale connected? Retrying…');
      await new Promise(resolve => setTimeout(resolve, failures > 1 ? 3000 : 400)); first = true;
    } finally { clearTimeout(timeout); }
  }
}
function pause() { generation++; poll?.abort(); }

if ('serviceWorker' in navigator) {
  registration = navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready).catch(() => null);
  // A tapped notification, when the app was already open: the service worker says where to go.
  navigator.serviceWorker.addEventListener('message', event => {
    const hash = event.data?.hash;
    if (typeof hash !== 'string' || !hash.startsWith('#/')) return;
    if (location.hash === hash) render(); else location.hash = hash;
  });
}
window.addEventListener('hashchange', render);
window.addEventListener('pageshow', () => { if (token && !document.hidden) start(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); else if (token) start(); });
setInterval(countdown, 1000);
render();
