import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

function supportsPushNotifications() {
  return (
    typeof window !== 'undefined'
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window
  );
}

function isStandaloneDisplayMode() {
  if (typeof window === 'undefined') {
    return false;
  }

  return Boolean(
    window.matchMedia?.('(display-mode: standalone)').matches
    || window.navigator.standalone === true
  );
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let i = 0; i < rawData.length; i += 1) {
    outputArray[i] = rawData.charCodeAt(i);
  }

  return outputArray;
}

async function registerServiceWorker() {
  return navigator.serviceWorker.register('/sw.js', { scope: '/' });
}

function getSubscriptionSignature(subscription) {
  if (!subscription || typeof subscription.toJSON !== 'function') {
    return '';
  }

  const serialized = subscription.toJSON();
  return `${serialized.endpoint}:${serialized.keys?.p256dh || ''}:${serialized.keys?.auth || ''}`;
}

function getPlatformLabel() {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const isIOS = /iPhone|iPad|iPod/i.test(ua);

  if (isIOS && isStandaloneDisplayMode()) {
    return 'ios-pwa';
  }

  if (isStandaloneDisplayMode()) {
    return 'pwa';
  }

  return 'web';
}

export function useNotifications(socket, isAuthenticated) {
  const supported = useMemo(() => supportsPushNotifications(), []);
  const [permission, setPermission] = useState(() => (
    typeof Notification === 'undefined' ? 'default' : Notification.permission
  ));
  const [subscribed, setSubscribed] = useState(false);
  const [vapidPublicKey, setVapidPublicKey] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const syncSignatureRef = useRef('');
  const pendingStateRequestRef = useRef(null);
  const prevSubscribedRef = useRef(false);

  const requestServerState = useCallback(() => {
    if (!socket || socket.readyState !== WebSocket.OPEN || !isAuthenticated) {
      return Promise.reject(new Error('Reconnect the chat first, then enable notifications.'));
    }

    return new Promise((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        pendingStateRequestRef.current = null;
        reject(new Error('Notification setup timed out. Please try again.'));
      }, 4000);

      pendingStateRequestRef.current = {
        resolve,
        reject,
        timeoutId,
      };

      socket.send(JSON.stringify({ type: 'notifications_get_state' }));
    });
  }, [socket, isAuthenticated]);

  const syncSubscription = useCallback(async (nextVapidPublicKey) => {
    if (!supported || !socket || socket.readyState !== WebSocket.OPEN || !isAuthenticated) {
      return false;
    }

    const registration = await registerServiceWorker();
    let subscription = await registration.pushManager.getSubscription();

    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(nextVapidPublicKey),
      });
    }

    const serialized = subscription.toJSON();
    const signature = `${serialized.endpoint}:${serialized.keys?.p256dh || ''}:${serialized.keys?.auth || ''}`;
    if (signature === syncSignatureRef.current) {
      return true;
    }

    syncSignatureRef.current = signature;
    socket.send(JSON.stringify({
      type: 'notifications_subscribe',
      subscription: serialized,
      platform: getPlatformLabel(),
      userAgent: navigator.userAgent,
    }));

    return true;
  }, [isAuthenticated, socket, supported]);

  const refreshLocalState = useCallback(async () => {
    const nextPermission = typeof Notification === 'undefined' ? 'default' : Notification.permission;
    setPermission(nextPermission);

    if (!supported || !window.isSecureContext) {
      syncSignatureRef.current = '';
      prevSubscribedRef.current = false;
      setSubscribed(false);
      return { permission: nextPermission, subscription: null };
    }

    // iOS can briefly return 'default' instead of 'granted' during foreground resume.
    // If we were previously subscribed, don't kill the bell on a transient permission read.
    if (nextPermission !== 'granted') {
      if (prevSubscribedRef.current) {
        return { permission: nextPermission, subscription: null };
      }
      syncSignatureRef.current = '';
      setSubscribed(false);
      return { permission: nextPermission, subscription: null };
    }

    const registration = await registerServiceWorker();
    let subscription = await registration.pushManager.getSubscription();

    // iOS WebKit returns null transiently after extended background — retry once
    if (!subscription) {
      await new Promise((r) => setTimeout(r, 400));
      subscription = await registration.pushManager.getSubscription();
    }

    // If still null but we were previously subscribed, don't flip the bell off —
    // the server-side subscription is still valid, rely on server state to recover
    if (!subscription && prevSubscribedRef.current) {
      return { permission: nextPermission, subscription: null };
    }

    syncSignatureRef.current = getSubscriptionSignature(subscription);
    prevSubscribedRef.current = Boolean(subscription);
    setSubscribed(Boolean(subscription));
    return { permission: nextPermission, subscription };
  }, [supported]);

  const enableNotifications = useCallback(async () => {
    setError('');

    if (!supported) {
      setError(
        isStandaloneDisplayMode()
          ? 'Notifications are not available in this browser.'
          : 'Install the PWA to enable notifications on this device.'
      );
      return false;
    }

    if (!window.isSecureContext) {
      setError('Notifications require a secure HTTPS connection.');
      return false;
    }

    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    const isIOS = /iPhone|iPad|iPod/i.test(ua);
    if (isIOS && !isStandaloneDisplayMode()) {
      setError('Add Root Operator to the Home Screen to enable notifications on iPhone or iPad.');
      return false;
    }

    if (!socket || socket.readyState !== WebSocket.OPEN || !isAuthenticated) {
      setError('Reconnect the chat first, then enable notifications.');
      return false;
    }

    setIsLoading(true);

    try {
      await registerServiceWorker();

      let nextPermission = Notification.permission;
      if (nextPermission !== 'granted') {
        nextPermission = await Notification.requestPermission();
      }
      setPermission(nextPermission);

      if (nextPermission !== 'granted') {
        throw new Error(
          nextPermission === 'denied'
            ? 'Notifications are blocked for this app.'
            : 'Notification permission was not granted.'
        );
      }

      const state = await requestServerState();
      const nextVapidPublicKey = typeof state?.vapidPublicKey === 'string' ? state.vapidPublicKey : vapidPublicKey;
      if (!nextVapidPublicKey) {
        throw new Error('The desktop app did not provide push setup details.');
      }

      setVapidPublicKey(nextVapidPublicKey);
      setSubscribed(Boolean(state?.subscribed));
      await syncSubscription(nextVapidPublicKey);
      prevSubscribedRef.current = true;
      setSubscribed(true);
      return true;
    } catch (notificationError) {
      console.error('[NOTIFICATIONS] Failed to enable notifications:', notificationError);
      setError(notificationError.message || 'Failed to enable notifications.');
      return false;
    } finally {
      setIsLoading(false);
    }
  }, [isAuthenticated, requestServerState, socket, supported, syncSubscription, vapidPublicKey]);

  useEffect(() => {
    if (!socket) {
      return undefined;
    }

    const handleMessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      if (msg.type === 'notifications_state') {
        setVapidPublicKey(typeof msg.vapidPublicKey === 'string' ? msg.vapidPublicKey : '');
        prevSubscribedRef.current = Boolean(msg.subscribed);
        setSubscribed(Boolean(msg.subscribed));
        if (pendingStateRequestRef.current) {
          clearTimeout(pendingStateRequestRef.current.timeoutId);
          pendingStateRequestRef.current.resolve(msg);
          pendingStateRequestRef.current = null;
        }
        return;
      }

      if (msg.type === 'notifications_error') {
        if (pendingStateRequestRef.current) {
          clearTimeout(pendingStateRequestRef.current.timeoutId);
          pendingStateRequestRef.current.reject(new Error(msg.message || 'Notifications are unavailable right now.'));
          pendingStateRequestRef.current = null;
        }
        setError(msg.message || 'Notifications are unavailable right now.');
      }
    };

    socket.addEventListener('message', handleMessage);
    return () => {
      socket.removeEventListener('message', handleMessage);
      if (pendingStateRequestRef.current) {
        clearTimeout(pendingStateRequestRef.current.timeoutId);
        pendingStateRequestRef.current = null;
      }
    };
  }, [socket]);

  useEffect(() => {
    let cancelled = false;

    const hydrateNotificationState = async () => {
      try {
        const { permission: localPermission, subscription } = await refreshLocalState();
        if (
          cancelled
          || !socket
          || socket.readyState !== WebSocket.OPEN
          || !isAuthenticated
          || localPermission !== 'granted'
        ) {
          return;
        }

        // Always consult the server — it's the source of truth for subscription state.
        // Don't bail on !subscription: iOS can return null transiently on fresh open,
        // but the server still knows we're subscribed.
        const state = await requestServerState();
        if (cancelled) {
          return;
        }

        const nextVapidPublicKey = typeof state?.vapidPublicKey === 'string' ? state.vapidPublicKey : '';
        setVapidPublicKey(nextVapidPublicKey);

        if (!state?.subscribed) {
          // Server doesn't have us — clear signature so syncSubscription doesn't
          // skip the send due to a stale signature match
          syncSignatureRef.current = '';
          await syncSubscription(nextVapidPublicKey);
          if (!cancelled) {
            prevSubscribedRef.current = true;
            setSubscribed(true);
          }
        } else if (!subscription && nextVapidPublicKey) {
          // Server says subscribed but local subscription is gone — try to recover.
          // This can happen when iOS revokes the subscription (3-strike silent push
          // rule) or after extended background/storage eviction.
          try {
            await syncSubscription(nextVapidPublicKey);
          } catch {
            // Recovery failed — subscription is likely permanently revoked by iOS.
            // Surface this to the user so they know to re-enable, rather than
            // showing a bell that looks "on" while delivering zero notifications.
            if (!cancelled) {
              prevSubscribedRef.current = false;
              setSubscribed(false);
              syncSignatureRef.current = '';
              // Also tell the server to clear the stale subscription
              if (socket && socket.readyState === WebSocket.OPEN) {
                try {
                  socket.send(JSON.stringify({ type: 'notifications_unsubscribe' }));
                } catch {
                  // Socket may be closing
                }
              }
            }
          }
        }
      } catch (syncError) {
        console.warn('[NOTIFICATIONS] Failed to refresh notification state:', syncError);
      }
    };

    hydrateNotificationState();

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, refreshLocalState, requestServerState, socket, syncSubscription]);

  useEffect(() => {
    if (typeof document === 'undefined' || typeof Notification === 'undefined') {
      return undefined;
    }

    const clearBadge = () => {
      // Clear badge via Badging API (direct)
      if ('clearAppBadge' in navigator) {
        navigator.clearAppBadge().catch(() => {});
      }

      // Tell service worker to reset its counter
      if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({ type: 'clear_badge' });
      }
    };

    const handleVisibilityChange = () => {
      // Tell the server our visibility state so it can route push notifications
      // correctly. iOS suspends WebSockets when backgrounded without closing them,
      // so the server needs an explicit signal to know we can't receive WS messages.
      if (socket && socket.readyState === WebSocket.OPEN) {
        try {
          socket.send(JSON.stringify({ type: 'client_visible', visible: !document.hidden }));
        } catch {
          // Socket may be closing
        }
      }

      if (document.hidden) {
        return;
      }

      clearBadge();
      refreshLocalState().catch((refreshError) => {
        console.warn('[NOTIFICATIONS] Failed to refresh local notification state:', refreshError);
      });
    };

    // Clear badge on initial load (app just opened)
    clearBadge();

    // Send initial visibility state to server once authenticated
    if (isAuthenticated && socket && socket.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify({ type: 'client_visible', visible: !document.hidden }));
      } catch {
        // Socket may be closing
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [isAuthenticated, refreshLocalState, socket]);

  const enabled = subscribed && permission === 'granted';
  const title = error
    || (enabled
      ? 'Notifications on'
      : supported
        ? 'Enable notifications'
        : 'Install the PWA to enable notifications');

  return {
    enabled,
    supported,
    permission,
    isLoading,
    error,
    title,
    enableNotifications,
  };
}
