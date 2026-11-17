'use strict';
self.addEventListener('push', event => {
  const payload = event.data?.json();
  const notification = payload?.notification;
  if (!notification) return;
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
    for (const client of windows) {
      if (new URL(client.url).origin !== url.origin) continue;
      await client.navigate(url.href); await client.focus(); return;
    }
    await self.clients.openWindow(url.href);
  })());
});
