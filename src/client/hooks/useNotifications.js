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

  const requestServerState = useCallback(() => {
    if (!socket || socket.readyState !== WebSocket.OPEN || !isAuthenticated) {
      return;
    }

    socket.send(JSON.stringify({ type: 'notifications_get_state' }));
  }, [socket, isAuthenticated]);

  const syncSubscription = useCallback(async ({ allowSubscribe = false } = {}) => {
    if (!supported || !socket || socket.readyState !== WebSocket.OPEN || !isAuthenticated) {
      return false;
    }

    const registration = await registerServiceWorker();
    let subscription = await registration.pushManager.getSubscription();

    if (!subscription) {
      if (!allowSubscribe) {
        return false;
      }

      if (!vapidPublicKey) {
        throw new Error('Notification setup is still loading. Please try again in a moment.');
      }

      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
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
  }, [isAuthenticated, socket, subscribed, supported, vapidPublicKey]);

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

      if (!vapidPublicKey) {
        requestServerState();
        throw new Error('Notification setup is still loading. Please tap again in a moment.');
      }

      await syncSubscription({ allowSubscribe: true });
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
        return;
      }

      if (msg.type === 'notifications_error') {
        setError(msg.message || 'Notifications are unavailable right now.');
      }
    };

    socket.addEventListener('message', handleMessage);
    return () => socket.removeEventListener('message', handleMessage);
  }, [socket]);

  useEffect(() => {
    requestServerState();
  }, [requestServerState]);

  useEffect(() => {
    if (!supported || permission !== 'granted') {
      return;
    }

    syncSubscription().catch((syncError) => {
      console.warn('[NOTIFICATIONS] Failed to sync existing subscription:', syncError.message);
    });
  }, [permission, supported, syncSubscription]);

  useEffect(() => {
    if (typeof document === 'undefined' || typeof Notification === 'undefined') {
      return undefined;
    }

    const handleVisibilityChange = () => {
      setPermission(Notification.permission);
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

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
