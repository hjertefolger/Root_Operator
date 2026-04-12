self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// --- Persisted state via Cache API (survives iOS SW termination) ---

const STATE_CACHE = 'ro-sw-state';

async function getPersistedState(key, fallback) {
  try {
    const cache = await caches.open(STATE_CACHE);
    const resp = await cache.match(key);
    if (!resp) return fallback;
    return await resp.json();
  } catch {
    return fallback;
  }
}

async function setPersistedState(key, value) {
  try {
    const cache = await caches.open(STATE_CACHE);
    await cache.put(key, new Response(JSON.stringify(value)));
  } catch {
    // Cache API unavailable — degrade gracefully
  }
}

async function getUnreadCount() {
  const { count } = await getPersistedState('unread-count', { count: 0 });
  return typeof count === 'number' ? count : 0;
}

async function setUnreadCount(count) {
  await setPersistedState('unread-count', { count });
}

// --- Notification payload ---

function normalizeNotificationPayload(data) {
  const payload = data && typeof data === 'object' ? data : {};
  // Support both flat fields and Declarative Web Push nested format
  const n = payload.notification && typeof payload.notification === 'object' ? payload.notification : {};
  const title = typeof payload.title === 'string' && payload.title
    ? payload.title
    : (typeof n.title === 'string' && n.title ? n.title
      : (typeof payload.assistantName === 'string' && payload.assistantName ? payload.assistantName : 'New message'));
  const body = typeof payload.body === 'string' && payload.body
    ? payload.body
    : (typeof n.body === 'string' && n.body ? n.body : 'Operator sent a new message');
  const url = typeof payload.url === 'string' && payload.url ? payload.url : (payload.navigate || n.navigate || '/');

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

// --- Badge ---

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

// --- Push handler ---
//
// IMPORTANT: Every push event MUST call showNotification().
// iOS/WebKit revokes the push subscription after 3 silent pushes
// (userVisibleOnly violation). Foreground suppression is handled
// server-side by skipping push delivery for devices with an active
// WebSocket connection.

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
    const count = (await getUnreadCount()) + 1;
    await setUnreadCount(count);
    await updateBadge(count);

    const notification = normalizeNotificationPayload(payload);
    await self.registration.showNotification(notification.title, notification.options);
  })());
});

// --- Notification click ---

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  event.waitUntil((async () => {
    // Clear badge and persisted count
    await setUnreadCount(0);
    await updateBadge(0);

    const destination = new URL(event.notification.data?.url || '/', self.location.origin).toString();

    const clients = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true,
    });

    // Prefer a client already at the destination URL
    const matching = clients.find((c) => 'focus' in c && c.url === destination);
    const target = matching || clients.find((c) => 'focus' in c);

    if (target) {
      await target.focus();
      if (!matching && 'navigate' in target) {
        await target.navigate(destination);
      }
      return;
    }

    if (self.clients.openWindow) {
      await self.clients.openWindow(destination);
    }
  })());
});

// --- Messages from client ---

self.addEventListener('message', (event) => {
  if (!event.data) return;

  if (event.data.type === 'clear_badge') {
    event.waitUntil((async () => {
      await setUnreadCount(0);
      await updateBadge(0);
    })());
  }
});
