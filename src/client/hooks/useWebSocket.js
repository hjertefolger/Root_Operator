import { useState, useEffect, useRef } from 'react';

export function useWebSocket() {
  const [socket, setSocket] = useState(null);
  const [isReady, setIsReady] = useState(false);
  const socketRef = useRef(null);

  useEffect(() => {
    // Determine WebSocket URL
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;

    console.log('[WS] Connecting to:', wsUrl);

    const ws = new WebSocket(wsUrl);
    socketRef.current = ws;

    ws.onopen = () => {
      console.log('[WS] Connected');
      setIsReady(true);
      setSocket(ws);
    };

    ws.onclose = () => {
      console.log('[WS] Disconnected');
      setIsReady(false);
      setSocket(null);
    };

    ws.onerror = (err) => {
      console.error('[WS] Error:', err);
      setIsReady(false);
    };

    return () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    };
  }, []);

  return { socket, isReady };
}
