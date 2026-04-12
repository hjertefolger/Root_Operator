self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Badge counter — persisted across push events
let unreadCount = 0;

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

async function hasFocusedClient() {
  const windowClients = await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: false,
  });

  // Use focused (not visibilityState) — iOS PWAs can report 'visible'
  // even after swipe-up to home screen
  return windowClients.some((client) => client.focused);
}

async function updateBadge(count) {
  if ('setAppBadge' in self.navigator) {
    try {
      if (count > 0) {
        await self.navigator.setAppBadge(count);
      } else {
        await self.navigator.clearAppBadge();
      }
    } catch {
      // Badge API not available in this context
    }
  }
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

  event.waitUntil((async () => {
    const clientVisible = await hasFocusedClient();

    // If the user is already reading the chat, skip everything
    if (clientVisible) {
      return;
    }

    // Only count as unread when the app is not visible
    unreadCount += 1;
    await updateBadge(unreadCount);

    const notification = normalizeNotificationPayload(payload);
    await self.registration.showNotification(notification.title, notification.options);
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  // Clear badge on notification tap
  unreadCount = 0;
  updateBadge(0);

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

// Listen for badge clear messages from the client
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'clear_badge') {
    unreadCount = 0;
    updateBadge(0);
  }
});
