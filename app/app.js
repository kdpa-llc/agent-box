'use strict';
const main = document.querySelector('#main');
const connection = document.querySelector('#connection');
let token = localStorage.getItem('agentbox.token');
let state = null;
let generation = 0;
let view = '';
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
function notice(text = '') { connection.hidden = !text; connection.textContent = text; }
function forget() {
  token = null; state = null; generation++; localStorage.removeItem('agentbox.token');
  main.querySelectorAll('input').forEach(field => { field.value = ''; });
  completed.clear(); view = ''; render(); notice();
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
  if (error.status === 502) return 'The notification could not be sent. Try again.';
  if (error.status) return 'That did not work. Try again.';
  return 'Your computer can’t be reached. Is it on, and is Tailscale connected? Try Send again.';
}
function phoneTab() {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) &&
    !navigator.standalone && !matchMedia('(display-mode: standalone)').matches;
}
function pushAvailable() { return 'Notification' in window && 'PushManager' in window && 'serviceWorker' in navigator && !phoneTab(); }
function permissionText() {
  if (phoneTab()) return 'For notifications, add Agent Box to your Home Screen: tap Share, then Add to Home Screen. Open it there to pair.';
  if ('Notification' in window && Notification.permission === 'denied') return 'Allow notifications in your iPhone’s Settings, Notifications, Agent Box.';
  if (!pushAvailable()) return 'Notifications aren’t available in this browser.';
  return 'Get a notification when an agent needs you.';
}
function pair() {
  main.replaceChildren(el('h1', 'Pair your phone'), el('p', 'Enter the code from your computer.', 'subtle'));
  if (phoneTab()) main.append(el('p', permissionText(), 'banner'));
  const form = el('form', undefined, 'panel');
  const code = input(form, 'pair-code', 'Pairing code', { maxlength: '8', minlength: '8', required: '', autocomplete: 'off', autocapitalize: 'characters', autocorrect: 'off', spellcheck: 'false' });
  code.addEventListener('input', () => { code.value = code.value.toUpperCase(); });
  const name = input(form, 'phone-name', 'Phone name', { maxlength: '40', required: '', autocomplete: 'off' }); name.value = 'iPhone';
  const msg = el('p', '', 'message error'); msg.setAttribute('role', 'status');
  const send = button('Pair', 'primary'); send.type = 'submit'; form.append(msg, send);
  form.addEventListener('submit', async event => {
    event.preventDefault(); send.disabled = true; msg.textContent = '';
    try {
      const result = await api('pair', { code: code.value, name: name.value });
      code.value = ''; token = result.token; localStorage.setItem('agentbox.token', token);
      view = ''; render(); start();
    } catch (error) {
      msg.textContent = error.code === 'bad_code' ? 'That code is wrong or expired. Check the code on your computer.' :
        error.code === 'too_many_tries' ? 'Too many tries. Make a new pairing code on your computer.' : failure(error);
    } finally { send.disabled = false; }
  });
  main.append(form, el('p', 'Your phone stays paired until you unpair it.', 'hint'));
}
async function notifications(enable, message) {
  try {
    if (enable) {
      // Permission is requested directly inside the user's click, before any await.
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') { message.textContent = permissionText(); return; }
      const reg = await registration;
      if (!reg) throw new Error();
      const key = state.push.publicKey.replace(/-/g, '+').replace(/_/g, '/');
      const bytes = Uint8Array.from(atob(key), c => c.charCodeAt(0));
      const subscription = await reg.pushManager.getSubscription() || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes });
      await api('push/subscribe', { subscription: subscription.toJSON() });
    } else {
      await api('push/unsubscribe', {});
      const reg = await registration;
      const subscription = await reg?.pushManager.getSubscription();
      if (subscription) await subscription.unsubscribe();
    }
    state.push.subscribed = enable; view = ''; render();
  } catch (error) { message.textContent = failure(error); }
}
function pushPanel(settings = false) {
  const box = el('section', undefined, settings ? 'panel' : 'banner');
  if (settings) box.append(el('h2', 'Notifications'));
  const message = el('p', state.push.subscribed ? 'Notifications are on.' : permissionText()); message.setAttribute('role', 'status');
  box.append(message);
  if (pushAvailable() && Notification.permission !== 'denied') {
    const toggle = button(state.push.subscribed ? 'Turn off notifications' : 'Turn on notifications', 'quiet');
    toggle.setAttribute('role', 'switch'); toggle.setAttribute('aria-checked', String(state.push.subscribed));
    toggle.addEventListener('click', () => notifications(!state.push.subscribed, message)); box.append(toggle);
  }
  if (settings) box.append(button('Send a test', 'quiet', async () => {
    try { await api('push/test', {}); message.textContent = 'Test sent. Check your notifications.'; }
    catch (error) { message.textContent = failure(error); }
  }));
  return box;
}
function card(request) {
  const node = el('article', undefined, 'card'); node.id = request.id; node.tabIndex = -1;
  node.append(el('div', kindNames[request.kind], 'kind'), el('h2', request.site), el('div', request.page.title),
    el('p', request.page.url, 'address'));
  if (request.agent) node.append(el('p', request.agent, 'agent'));
  const expiry = el('p', '', 'expiry'); expiry.dataset.expires = request.expiresAt; node.append(expiry);
  const form = el('form'); const fields = {};
  if (request.kind === 'credentials') {
    fields.username = input(form, request.id + '-username', 'Username', { autocomplete: 'username', autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', maxlength: '1024', enterkeyhint: 'send' });
    fields.password = input(form, request.id + '-password', 'Password', { type: 'password', autocomplete: 'current-password', spellcheck: 'false', maxlength: '1024', enterkeyhint: 'send' });
    const reveal = button('Show password', 'quiet reveal', () => {
      const show = fields.password.type === 'password'; fields.password.type = show ? 'text' : 'password';
      reveal.textContent = show ? 'Hide password' : 'Show password'; reveal.setAttribute('aria-pressed', String(show));
    }); reveal.setAttribute('aria-pressed', 'false'); form.append(reveal, el('p', 'Tap a field, then the key above the keyboard to fill from your password manager.', 'hint'));
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
    if (request.viewerUrl) {
      const url = new URL(request.viewerUrl);
      if (url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === '127.0.0.1')) {
        const link = el('a', 'Open live view', 'live'); link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; form.append(link);
      }
    }
  }
  if (request.kind !== 'handoff') form.append(el('p', 'Used once. Not saved.', 'hint'));
  const msg = el('p', '', 'message error'); msg.setAttribute('role', 'status');
  const send = button(request.kind === 'handoff' ? 'Done' : 'Send', 'primary'); send.type = 'submit';
  const deny = button(request.kind === 'handoff' ? 'Can’t' : 'Deny', 'quiet deny', () => submit(true));
  const required = fields.password || fields.code;
  const update = () => { send.disabled = !!required && !required.value; };
  form.addEventListener('input', update); form.addEventListener('change', update); update();
  async function submit(denied) {
    send.disabled = true; deny.disabled = true; msg.textContent = ''; node.dataset.busy = 'true';
    try {
      await api('requests/' + encodeURIComponent(request.id) + (denied ? '/deny' : '/answer'),
        denied ? {} : Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, field.value])));
      completed.add(request.id); node.dataset.answered = 'true';
      Object.values(fields).forEach(field => { field.value = ''; });
      form.replaceChildren(el('p', denied ? 'Denied.' : 'Sent. You can go back to what you were doing.'));
      setTimeout(() => { node.classList.add('leaving'); setTimeout(() => { node.remove(); cards.delete(request.id); if (view === 'requests') render(); }, 180); }, 650);
    } catch (error) {
      delete node.dataset.busy;
      if (error.status === 401) return;
      msg.textContent = failure(error);
      if (error.status === 404 || error.status === 409) {
        Object.values(fields).forEach(field => { field.value = ''; field.disabled = true; });
      } else { update(); deny.disabled = false; }
    }
  }
  form.addEventListener('submit', event => { event.preventDefault(); if (!send.disabled) submit(false); });
  form.append(msg, send, deny); node.append(form); return node;
}
function countdown() {
  document.querySelectorAll('[data-expires]').forEach(node => {
    const seconds = Math.max(0, Math.ceil((Number(node.dataset.expires) - Date.now()) / 1000));
    node.textContent = seconds ? `Expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : 'Expired. Waiting for your computer to update.';
  });
}
function focusRequest() {
  if (!location.hash.startsWith('#/r/')) return;
  const node = document.getElementById(location.hash.slice(4));
  if (node && document.activeElement !== node && !node.contains(document.activeElement)) { node.focus({ preventScroll: true }); node.scrollIntoView({ block: 'start' }); }
}
function render() {
  const next = !token ? 'pair' : location.hash === '#/settings' ? 'settings' : 'requests';
  document.querySelectorAll('nav a').forEach(link => {
    if ((link.id === 'settings-link') === (next === 'settings')) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  if (next === 'pair') { if (view !== next) pair(); view = next; return; }
  if (!state) { main.replaceChildren(el('p', 'Connecting to your computer…')); return; }
  if (next === 'settings') {
    main.replaceChildren(el('h1', 'Settings'), pushPanel(true));
    const info = el('section', undefined, 'panel'); info.append(el('h3', state.device.name), el('p', 'Version ' + state.version, 'subtle'));
    const message = el('p', '', 'message error'); message.setAttribute('role', 'status');
    info.append(button('Unpair this phone', 'quiet', async () => { try { await api('unpair', {}); forget(); } catch (error) { message.textContent = failure(error); } }), message);
    main.append(info); view = next; return;
  }
  if (view !== next) {
    main.replaceChildren(el('h1', 'Requests'));
    const banner = el('div'); banner.id = 'push-banner';
    const list = el('section'); list.id = 'cards'; list.setAttribute('aria-label', 'Pending requests');
    const history = el('section'); history.id = 'history'; main.append(list, banner, history); cards = new Map();
  }
  view = next;
  const banner = document.querySelector('#push-banner'); banner.replaceChildren();
  if (!state.push.subscribed) banner.append(pushPanel());
  const list = document.querySelector('#cards');
  for (const [id, node] of cards) if (!state.requests.some(request => request.id === id) && !node.dataset.busy && !node.dataset.answered) {
    node.querySelectorAll('input').forEach(field => { field.value = ''; }); node.remove(); cards.delete(id);
  }
  list.querySelector('.empty')?.remove();
  for (const request of state.requests) if (!cards.has(request.id) && !completed.has(request.id)) { const node = card(request); cards.set(request.id, node); list.append(node); }
  if (!cards.size) list.append(el('p', 'Nothing waiting. We’ll let you know when you’re needed.', 'empty subtle'));
  const history = document.querySelector('#history'); history.replaceChildren(el('h3', 'Recent'));
  if (!state.history.length) history.append(el('p', 'No requests yet.', 'subtle'));
  for (const entry of state.history) {
    const row = el('p', undefined, 'history'); row.append(el('strong', entry.site), document.createTextNode(` · ${kindNames[entry.kind]} · ${endings[entry.status] || entry.status} · ${new Date(entry.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`)); history.append(row);
  }
  countdown(); focusRequest();
}
async function start() {
  const run = ++generation;
  let first = true;
  while (token && run === generation) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 35000);
    try {
      const result = await api(first || !state ? 'state' : `state?since=${state.rev}&wait=25`, undefined, controller.signal);
      if (run !== generation) return;
      const changed = first || !state || state.rev !== result.rev;
      state = result; first = false; notice(); if (changed) render();
    } catch (error) {
      if (run !== generation || error.status === 401) return;
      notice('Your computer can’t be reached. Is it on, and is Tailscale connected? Retrying…');
      await new Promise(resolve => setTimeout(resolve, 3000)); first = true;
    } finally { clearTimeout(timeout); }
  }
}
if ('serviceWorker' in navigator) registration = navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready).catch(() => null);
window.addEventListener('hashchange', () => { render(); focusRequest(); });
window.addEventListener('pageshow', () => { if (token) start(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && token) start(); });
setInterval(countdown, 1000);
render();
