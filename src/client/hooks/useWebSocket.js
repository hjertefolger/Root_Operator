import { useState, useEffect, useRef, useCallback } from 'react';

// Reconnection configuration
const RECONNECT_CONFIG = {
  initialDelay: 1000,      // 1 second
  maxDelay: 30000,         // 30 seconds
  multiplier: 2,
  jitterFactor: 0.2,       // ±20%
};

// Fetch CSRF token from server before WebSocket connection
async function fetchCsrfToken() {
  try {
    const response = await fetch('/api/csrf-token');
    if (!response.ok) {
      throw new Error(`CSRF token fetch failed: ${response.status}`);
    }
    const data = await response.json();
    return data.token;
  } catch (e) {
    console.error('[WS] Failed to fetch CSRF token:', e);
    return null;
  }
}

// Heartbeat configuration
const HEARTBEAT_CONFIG = {
  interval: 25000,         // Send ping every 25 seconds
  timeout: 5000,           // Consider dead if no pong within 5 seconds
};

/**
 * Calculate reconnect delay with exponential backoff and jitter
 */
function getReconnectDelay(attempt) {
  const baseDelay = Math.min(
    RECONNECT_CONFIG.initialDelay * Math.pow(RECONNECT_CONFIG.multiplier, attempt),
    RECONNECT_CONFIG.maxDelay
  );
  // Add jitter to prevent thundering herd
  const jitter = baseDelay * RECONNECT_CONFIG.jitterFactor * (Math.random() * 2 - 1);
  return Math.round(baseDelay + jitter);
}

export function useWebSocket() {
  const [socket, setSocket] = useState(null);
  const [isReady, setIsReady] = useState(false);
  const [connectionState, setConnectionState] = useState('disconnected');
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [csrfValidated, setCsrfValidated] = useState(false);

  // Refs for managing connection lifecycle
  const socketRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const intentionalCloseRef = useRef(false);
  const heartbeatIntervalRef = useRef(null);
  const heartbeatTimeoutRef = useRef(null);
  const messageQueueRef = useRef([]);
  const wsUrlRef = useRef(null);
  const csrfTokenRef = useRef(null);

  /**
   * Clear all heartbeat timers
   */
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

  /**
   * Start heartbeat mechanism
   */
  const startHeartbeat = useCallback((ws) => {
    clearHeartbeat();

    heartbeatIntervalRef.current = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        // Send ping
        ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));

        // Set timeout for pong response
        heartbeatTimeoutRef.current = setTimeout(() => {
          console.log('[WS] Heartbeat timeout - connection appears dead');
          // Force close to trigger reconnection
          ws.close(4000, 'Heartbeat timeout');
        }, HEARTBEAT_CONFIG.timeout);
      }
    }, HEARTBEAT_CONFIG.interval);
  }, [clearHeartbeat]);

  /**
   * Handle pong response - clear timeout
   */
  const handlePong = useCallback(() => {
    if (heartbeatTimeoutRef.current) {
      clearTimeout(heartbeatTimeoutRef.current);
      heartbeatTimeoutRef.current = null;
    }
  }, []);

  /**
   * Queue a message to be sent when reconnected
   */
  const queueMessage = useCallback((message) => {
    messageQueueRef.current.push(message);
  }, []);

  /**
   * Flush message queue after reconnection
   */
  const flushMessageQueue = useCallback((ws) => {
    while (messageQueueRef.current.length > 0 && ws.readyState === WebSocket.OPEN) {
      const message = messageQueueRef.current.shift();
      ws.send(typeof message === 'string' ? message : JSON.stringify(message));
    }
  }, []);

  /**
   * Create and connect WebSocket
   */
  const connect = useCallback(async () => {
    // Fetch CSRF token before connecting
    console.log('[WS] Fetching CSRF token...');
    setConnectionState('fetching_csrf');
    const csrfToken = await fetchCsrfToken();
    if (!csrfToken) {
      console.error('[WS] Failed to get CSRF token, will retry...');
      setConnectionState('reconnecting');
      const delay = getReconnectDelay(reconnectAttempt);
      reconnectTimeoutRef.current = setTimeout(() => {
        setReconnectAttempt((prev) => prev + 1);
        connect();
      }, delay);
      return;
    }
    csrfTokenRef.current = csrfToken;

    // Determine WebSocket URL (calculate once and cache)
    if (!wsUrlRef.current) {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      wsUrlRef.current = `${protocol}//${window.location.host}`;
    }

    console.log(`[WS] Connecting to: ${wsUrlRef.current} (attempt ${reconnectAttempt + 1})`);
    setConnectionState('connecting');
    setCsrfValidated(false);

    const ws = new WebSocket(wsUrlRef.current);
    socketRef.current = ws;

    // Set socket immediately so message listeners can attach
    setSocket(ws);

    ws.onopen = () => {
      console.log('[WS] Connected, sending CSRF token...');
      intentionalCloseRef.current = false;

      // Send CSRF token as first message
      ws.send(JSON.stringify({ type: 'csrf_token', token: csrfTokenRef.current }));
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);

        // Handle CSRF validation response
        if (msg.type === 'csrf_validated') {
          console.log('[WS] CSRF validated, connection ready');
          setCsrfValidated(true);
          setIsReady(true);
          setConnectionState('connected');
          setReconnectAttempt(0);
          // Start heartbeat after CSRF validation
          startHeartbeat(ws);
          return;
        }

        // Handle pong internally
        if (msg.type === 'pong') {
          handlePong();
        }
      } catch {
        // Not JSON or not a pong, let other handlers process
      }
    };

    ws.onclose = (event) => {
      console.log(`[WS] Disconnected (code: ${event.code}, reason: ${event.reason || 'none'})`);
      clearHeartbeat();
      setIsReady(false);
      setCsrfValidated(false);
      setSocket(null);

      // Check if server intentionally closed (bridge stopped)
      if (event.code === 1001 || (event.code === 1000 && event.reason === 'Bridge stopped')) {
        console.log('[WS] Server stopped - not reconnecting');
        setConnectionState('server_stopped');
        return;
      }

      // Don't reconnect if intentional close
      if (intentionalCloseRef.current) {
        setConnectionState('disconnected');
        return;
      }

      // Schedule reconnection
      setConnectionState('reconnecting');
      const delay = getReconnectDelay(reconnectAttempt);
      console.log(`[WS] Reconnecting in ${delay}ms...`);

      reconnectTimeoutRef.current = setTimeout(() => {
        setReconnectAttempt((prev) => prev + 1);
        connect();
      }, delay);
    };

    ws.onerror = (err) => {
      console.error('[WS] Error:', err);
      // onclose will be called after onerror, so reconnection is handled there
    };

    return ws;
  }, [reconnectAttempt, startHeartbeat, handlePong, clearHeartbeat]);

  /**
   * Manually disconnect (prevents auto-reconnect)
   */
  const disconnect = useCallback(() => {
    console.log('[WS] Manual disconnect requested');
    intentionalCloseRef.current = true;

    // Clear any pending reconnect
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    // Close socket
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      socketRef.current.close(1000, 'User initiated disconnect');
    }

    setConnectionState('disconnected');
  }, []);

  /**
   * Force reconnect (for manual retry)
   */
  const forceReconnect = useCallback(() => {
    console.log('[WS] Force reconnect requested');
    intentionalCloseRef.current = false;

    // Clear any pending reconnect
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    // Close existing socket if any
    if (socketRef.current) {
      socketRef.current.close();
    }

    // Reset attempt counter and reconnect immediately
    setReconnectAttempt(0);
    connect();
  }, [connect]);

  // Initial connection
  useEffect(() => {
    connect();

    return () => {
      intentionalCloseRef.current = true;
      clearHeartbeat();

      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }

      if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
        socketRef.current.close(1000, 'Component unmounting');
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only run once on mount

  // Handle online/offline events
  useEffect(() => {
    const handleOnline = () => {
      console.log('[WS] Network online detected');
      if (connectionState === 'disconnected' || connectionState === 'reconnecting') {
        // Clear any pending reconnect and try immediately
        if (reconnectTimeoutRef.current) {
          clearTimeout(reconnectTimeoutRef.current);
          reconnectTimeoutRef.current = null;
        }
        setReconnectAttempt(0);
        connect();
      }
    };

    const handleOffline = () => {
      console.log('[WS] Network offline detected');
      // onclose will handle the disconnection
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [connectionState, connect]);

  // Handle visibility change (iOS PWA backgrounding)
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        console.log('[WS] App became visible');
        // Check if socket is still alive
        if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) {
          if (connectionState !== 'connecting' && !intentionalCloseRef.current) {
            console.log('[WS] Socket dead after returning from background - reconnecting');
            setReconnectAttempt(0);
            connect();
          }
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [connectionState, connect]);

  return {
    socket,
    isReady,
    connectionState,
    reconnectAttempt,
    csrfValidated,
    disconnect,
    forceReconnect,
    queueMessage,
    flushMessageQueue,
  };
}
