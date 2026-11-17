'use strict';
// Shows the broker's notifications and takes a tap on one to its request. It caches nothing.
// A new version takes over at once, and the page that registered it is controlled right away.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  // Every push must show a notification, or the phone may stop delivering them.
  let notification = null;
  try { notification = event.data?.json()?.notification; } catch {}
  if (!notification || typeof notification.title !== 'string') notification = { title: 'Agent Box', body: 'An agent needs you.', navigate: '/' };
  event.waitUntil(self.registration.showNotification(notification.title, {
    body: notification.body, tag: notification.tag, icon: '/icon-192.png',
    data: { navigate: notification.navigate }
  }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = new URL(event.notification.data?.navigate || '/', self.location.origin);
  if (url.origin !== self.location.origin) return;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = windows.find(window => new URL(window.url).origin === url.origin);
    if (!client) { await self.clients.openWindow(url.href); return; }
    // Focus first, while the tap still counts. Then tell the page where to go: navigate()
    // fails for a page this worker doesn't control.
    try { await client.focus(); } catch {}
    client.postMessage({ hash: url.hash || '#/' });
  })());
});
