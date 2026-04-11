self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

function normalizeNotificationPayload(data) {
  const payload = data && typeof data === 'object' ? data : {};
  const title = typeof payload.title === 'string' && payload.title
    ? payload.title
    : (typeof payload.assistantName === 'string' && payload.assistantName ? payload.assistantName : 'New message');
  const body = typeof payload.body === 'string' && payload.body ? payload.body : 'Operator sent a new message';
  const url = typeof payload.url === 'string' && payload.url ? payload.url : '/';

  return {
    title,
    options: {
      body,
      icon: payload.icon || '/icon-192-v3.png',
      badge: payload.badge || '/icon-192-v3.png',
      tag: payload.tag || 'root-operator-assistant-reply',
      data: {
        url,
      },
      renotify: true,
    },
  };
}

self.addEventListener('push', (event) => {
  let payload = {};

  if (event.data) {
    try {
      payload = event.data.json();
    } catch {
      payload = { body: event.data.text() };
    }
  }

  const notification = normalizeNotificationPayload(payload);
  event.waitUntil(self.registration.showNotification(notification.title, notification.options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const destination = new URL(event.notification.data?.url || '/', self.location.origin).toString();

  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true,
    });

    for (const client of clients) {
      if (!('focus' in client)) {
        continue;
      }

      await client.focus();
      if ('navigate' in client) {
        await client.navigate(destination);
      }
      return;
    }

    if (self.clients.openWindow) {
      await self.clients.openWindow(destination);
    }
  })());
});
