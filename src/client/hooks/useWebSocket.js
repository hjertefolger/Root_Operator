import { useState, useEffect, useRef, useCallback } from 'react';

// Reconnection configuration
const RECONNECT_CONFIG = {
  initialDelay: 3000,
  maxDelay: 120000,
  multiplier: 2,
  jitterFactor: 0.2,
};

// Heartbeat configuration
const HEARTBEAT_CONFIG = {
  interval: 25000,
  timeout: 5000,
};

function isPageVisible() {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

function getReconnectDelay(attempt) {
  const baseDelay = Math.min(
    RECONNECT_CONFIG.initialDelay * Math.pow(RECONNECT_CONFIG.multiplier, attempt),
    RECONNECT_CONFIG.maxDelay
  );
  const jitter = baseDelay * RECONNECT_CONFIG.jitterFactor * (Math.random() * 2 - 1);
  return Math.round(baseDelay + jitter);
}

export function useWebSocket() {
  const [socket, setSocket] = useState(null);
  const [isReady, setIsReady] = useState(false);
  const [connectionState, setConnectionState] = useState('disconnected');
  const [reconnectAttempt, setReconnectAttempt] = useState(0);

  const socketRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const intentionalCloseRef = useRef(false);
  const heartbeatIntervalRef = useRef(null);
  const heartbeatTimeoutRef = useRef(null);
  const wsUrlRef = useRef(null);
  const reconnectAttemptRef = useRef(0);
  const pendingReconnectOnVisibleRef = useRef(false);
  const serverStoppedRef = useRef(false);

  const syncReconnectAttempt = useCallback((attempt) => {
    reconnectAttemptRef.current = attempt;
    setReconnectAttempt(attempt);
  }, []);

  const clearReconnectTimeout = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
  }, []);

  const clearHeartbeat = useCallback(() => {
    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current);
      heartbeatIntervalRef.current = null;
    }
    if (heartbeatTimeoutRef.current) {
      clearTimeout(heartbeatTimeoutRef.current);
      heartbeatTimeoutRef.current = null;
    }
  }, []);

  // Send a single heartbeat ping. Carries the current visibility state so
  // the server can update clientVisible and lastHeartbeat atomically.
  const sendPing = useCallback((ws) => {
    if (ws.readyState !== WebSocket.OPEN) {
      return;
    }
    try {
      ws.send(JSON.stringify({
        type: 'ping',
        timestamp: Date.now(),
        visible: isPageVisible(),
      }));
    } catch {
      // Socket may be closing
    }
  }, []);

  const startHeartbeat = useCallback((ws) => {
    clearHeartbeat();

    // Fire an immediate ping so lastHeartbeat is fresh right now — don't
    // wait up to 25 s for the first interval tick. This is critical when
    // resuming from background: the visibility change sends client_visible
    // immediately, but without a fresh heartbeat the server sees the pair
    // (visible=true, lastHeartbeat=stale) and sends push anyway.
    sendPing(ws);

    heartbeatIntervalRef.current = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN && isPageVisible()) {
        sendPing(ws);
        heartbeatTimeoutRef.current = setTimeout(() => {
          console.log('[WS] Heartbeat timeout');
          ws.close(4000, 'Heartbeat timeout');
        }, HEARTBEAT_CONFIG.timeout);
      }
    }, HEARTBEAT_CONFIG.interval);
  }, [clearHeartbeat, sendPing]);

  const handlePong = useCallback(() => {
    if (heartbeatTimeoutRef.current) {
      clearTimeout(heartbeatTimeoutRef.current);
      heartbeatTimeoutRef.current = null;
    }
  }, []);

  const connect = useCallback(() => {
    const existingSocket = socketRef.current;
    if (existingSocket && (
      existingSocket.readyState === WebSocket.OPEN
      || existingSocket.readyState === WebSocket.CONNECTING
    )) {
      return existingSocket;
    }

    if (!wsUrlRef.current) {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      wsUrlRef.current = `${protocol}//${window.location.host}`;
    }

    clearReconnectTimeout();
    pendingReconnectOnVisibleRef.current = false;
    serverStoppedRef.current = false;

    console.log(`[WS] Connecting to: ${wsUrlRef.current}`);
    setConnectionState(reconnectAttemptRef.current > 0 ? 'reconnecting' : 'connecting');

    const ws = new WebSocket(wsUrlRef.current);
    socketRef.current = ws;
    setSocket(ws);

    ws.onopen = () => {
      if (socketRef.current !== ws) {
        return;
      }

      console.log('[WS] Connected');
      intentionalCloseRef.current = false;
      setIsReady(true);
      setConnectionState('connected');
      syncReconnectAttempt(0);

      if (isPageVisible()) {
        startHeartbeat(ws);
      }
    };

    ws.onmessage = (event) => {
      if (socketRef.current !== ws) {
        return;
      }

      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'pong') {
          handlePong();
        }
      } catch {
        // Not JSON, let other handlers process
      }
    };

    ws.onclose = (event) => {
      if (socketRef.current !== ws) {
        return;
      }

      console.log(`[WS] Disconnected (code: ${event.code})`);
      clearHeartbeat();
      clearReconnectTimeout();
      socketRef.current = null;
      setIsReady(false);
      setSocket(null);

      if (event.code === 1001 || (event.code === 1000 && event.reason === 'Bridge stopped')) {
        serverStoppedRef.current = true;
        pendingReconnectOnVisibleRef.current = false;
        setConnectionState('server_stopped');
        return;
      }

      if (intentionalCloseRef.current) {
        pendingReconnectOnVisibleRef.current = false;
        setConnectionState('disconnected');
        return;
      }

      setConnectionState('reconnecting');
      if (!isPageVisible()) {
        pendingReconnectOnVisibleRef.current = true;
        console.log('[WS] Waiting for page to become visible before reconnecting');
        return;
      }

      const attempt = reconnectAttemptRef.current;
      const delay = getReconnectDelay(attempt);
      console.log(`[WS] Reconnecting in ${delay}ms...`);
      reconnectTimeoutRef.current = setTimeout(() => {
        reconnectTimeoutRef.current = null;

        if (intentionalCloseRef.current) {
          return;
        }

        if (!isPageVisible()) {
          pendingReconnectOnVisibleRef.current = true;
          console.log('[WS] Page hidden during reconnect delay, deferring reconnect');
          return;
        }

        syncReconnectAttempt(attempt + 1);
        connect();
      }, delay);
    };

    ws.onerror = (err) => {
      if (socketRef.current !== ws) {
        return;
      }

      console.error('[WS] Error:', err);
    };

    return ws;
  }, [clearHeartbeat, clearReconnectTimeout, handlePong, startHeartbeat, syncReconnectAttempt]);

  const disconnect = useCallback(() => {
    intentionalCloseRef.current = true;
    pendingReconnectOnVisibleRef.current = false;
    clearReconnectTimeout();
    clearHeartbeat();

    const currentSocket = socketRef.current;
    socketRef.current = null;
    setSocket(null);
    setIsReady(false);

    if (currentSocket && (
      currentSocket.readyState === WebSocket.OPEN
      || currentSocket.readyState === WebSocket.CONNECTING
    )) {
      currentSocket.close(1000, 'User initiated disconnect');
    }

    setConnectionState('disconnected');
  }, [clearHeartbeat, clearReconnectTimeout]);

  const forceReconnect = useCallback(() => {
    intentionalCloseRef.current = false;
    serverStoppedRef.current = false;
    pendingReconnectOnVisibleRef.current = false;
    clearReconnectTimeout();
    clearHeartbeat();
    syncReconnectAttempt(0);

    const currentSocket = socketRef.current;
    socketRef.current = null;
    setSocket(null);
    setIsReady(false);

    if (currentSocket && (
      currentSocket.readyState === WebSocket.OPEN
      || currentSocket.readyState === WebSocket.CONNECTING
    )) {
      currentSocket.close(4001, 'Force reconnect');
    }

    connect();
  }, [clearHeartbeat, clearReconnectTimeout, connect, syncReconnectAttempt]);

  useEffect(() => {
    if (typeof document === 'undefined') {
      return undefined;
    }

    const handleVisibilityChange = () => {
      const currentSocket = socketRef.current;

      if (!isPageVisible()) {
        clearHeartbeat();

        if (reconnectTimeoutRef.current) {
          clearReconnectTimeout();
          pendingReconnectOnVisibleRef.current = true;
        }

        return;
      }

      if (serverStoppedRef.current || intentionalCloseRef.current) {
        return;
      }

      if (currentSocket?.readyState === WebSocket.OPEN) {
        startHeartbeat(currentSocket);
        return;
      }

      if (currentSocket?.readyState === WebSocket.CONNECTING) {
        return;
      }

      if (pendingReconnectOnVisibleRef.current || !currentSocket) {
        console.log('[WS] Page visible, reconnecting immediately');
        pendingReconnectOnVisibleRef.current = false;
        connect();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [clearHeartbeat, clearReconnectTimeout, connect, startHeartbeat]);

  useEffect(() => {
    connect();
    return () => {
      intentionalCloseRef.current = true;
      pendingReconnectOnVisibleRef.current = false;
      clearHeartbeat();
      clearReconnectTimeout();

      const currentSocket = socketRef.current;
      socketRef.current = null;

      if (currentSocket && (
        currentSocket.readyState === WebSocket.OPEN
        || currentSocket.readyState === WebSocket.CONNECTING
      )) {
        currentSocket.close(1000, 'Component unmounting');
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    socket,
    isReady,
    connectionState,
    reconnectAttempt,
    disconnect,
    forceReconnect,
  };
}
