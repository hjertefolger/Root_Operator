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
    if (signature === syncSignatureRef.current && subscribed) {
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
  }, [isAuthenticated, socket, subscribed, supported]);

  const refreshLocalState = useCallback(async () => {
    const nextPermission = typeof Notification === 'undefined' ? 'default' : Notification.permission;
    setPermission(nextPermission);

    if (!supported || !window.isSecureContext || nextPermission !== 'granted') {
      syncSignatureRef.current = '';
      setSubscribed(false);
      return { permission: nextPermission, subscription: null };
    }

    const registration = await registerServiceWorker();
    const subscription = await registration.pushManager.getSubscription();
    syncSignatureRef.current = getSubscriptionSignature(subscription);
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
        const { subscription } = await refreshLocalState();
        if (
          cancelled
          || !subscription
          || !socket
          || socket.readyState !== WebSocket.OPEN
          || !isAuthenticated
        ) {
          return;
        }

        const state = await requestServerState();
        if (cancelled) {
          return;
        }

        const nextVapidPublicKey = typeof state?.vapidPublicKey === 'string' ? state.vapidPublicKey : '';
        setVapidPublicKey(nextVapidPublicKey);

        if (!state?.subscribed) {
          await syncSubscription(nextVapidPublicKey);
          if (!cancelled) {
            setSubscribed(true);
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
      if (!document.hidden) {
        clearBadge();
      }

      refreshLocalState().catch((refreshError) => {
        console.warn('[NOTIFICATIONS] Failed to refresh local notification state:', refreshError);
      });
    };

    // Clear badge on initial load (app just opened)
    clearBadge();

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [refreshLocalState]);

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
