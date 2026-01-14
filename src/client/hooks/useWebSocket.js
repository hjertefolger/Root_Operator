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

  const startHeartbeat = useCallback((ws) => {
    clearHeartbeat();
    heartbeatIntervalRef.current = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
        heartbeatTimeoutRef.current = setTimeout(() => {
          console.log('[WS] Heartbeat timeout');
          ws.close(4000, 'Heartbeat timeout');
        }, HEARTBEAT_CONFIG.timeout);
      }
    }, HEARTBEAT_CONFIG.interval);
  }, [clearHeartbeat]);

  const handlePong = useCallback(() => {
    if (heartbeatTimeoutRef.current) {
      clearTimeout(heartbeatTimeoutRef.current);
      heartbeatTimeoutRef.current = null;
    }
  }, []);

  const connect = useCallback(() => {
    if (!wsUrlRef.current) {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      wsUrlRef.current = `${protocol}//${window.location.host}`;
    }

    console.log(`[WS] Connecting to: ${wsUrlRef.current}`);
    setConnectionState('connecting');

    const ws = new WebSocket(wsUrlRef.current);
    socketRef.current = ws;
    setSocket(ws);

    ws.onopen = () => {
      console.log('[WS] Connected');
      intentionalCloseRef.current = false;
      setIsReady(true);
      setConnectionState('connected');
      setReconnectAttempt(0);
      startHeartbeat(ws);
    };

    ws.onmessage = (event) => {
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
      console.log(`[WS] Disconnected (code: ${event.code})`);
      clearHeartbeat();
      setIsReady(false);
      setSocket(null);

      if (event.code === 1001 || (event.code === 1000 && event.reason === 'Bridge stopped')) {
        setConnectionState('server_stopped');
        return;
      }

      if (intentionalCloseRef.current) {
        setConnectionState('disconnected');
        return;
      }

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
    };

    return ws;
  }, [reconnectAttempt, startHeartbeat, handlePong, clearHeartbeat]);

  const disconnect = useCallback(() => {
    intentionalCloseRef.current = true;
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      socketRef.current.close(1000, 'User initiated disconnect');
    }
    setConnectionState('disconnected');
  }, []);

  const forceReconnect = useCallback(() => {
    intentionalCloseRef.current = false;
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (socketRef.current) {
      socketRef.current.close();
    }
    setReconnectAttempt(0);
    connect();
  }, [connect]);

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
