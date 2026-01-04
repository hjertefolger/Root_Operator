import { useState, useEffect } from 'react';
import Terminal from './components/Terminal';
import ConnectionStatus from './components/ConnectionStatus';
import EncryptionBadge from './components/EncryptionBadge';
import { useWebSocket } from './hooks/useWebSocket';
import { useE2E } from './hooks/useE2E';
import { useAuth } from './hooks/useAuth';

function App() {
  const [isConnected, setIsConnected] = useState(false);
  const [statusMessage, setStatusMessage] = useState('Connecting...');

  // Initialize WebSocket connection
  const { socket, isReady } = useWebSocket();

  // Initialize E2E encryption
  const {
    e2eReady,
    fingerprint,
    encryptInput,
    decryptOutput,
    handleE2EInit,
    handleE2EReady
  } = useE2E(socket);

  // Initialize authentication
  const {
    isAuthenticated,
    handleAuthChallenge
  } = useAuth(socket);

  // Update connection status
  useEffect(() => {
    if (!isReady) {
      setStatusMessage('Connecting...');
      setIsConnected(false);
    } else if (!isAuthenticated) {
      setStatusMessage('Authenticating...');
      setIsConnected(false);
    } else {
      setStatusMessage('Connected');
      setIsConnected(true);
    }
  }, [isReady, isAuthenticated]);

  // Handle WebSocket messages
  useEffect(() => {
    if (!socket) return;

    const handleMessage = async (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
        console.log('[WS] Received message:', msg.type);
      } catch (e) {
        return;
      }

      // Auth challenge
      if (msg.type === 'auth_challenge') {
        await handleAuthChallenge(msg.data);
      }

      // E2E key exchange
      if (msg.type === 'e2e_init') {
        await handleE2EInit(msg.publicKey, msg.salt);
      }

      // E2E ready
      if (msg.type === 'e2e_ready') {
        handleE2EReady(msg.fingerprint);
      }
    };

    socket.addEventListener('message', handleMessage);
    return () => socket.removeEventListener('message', handleMessage);
  }, [socket, handleAuthChallenge, handleE2EInit, handleE2EReady]);

  return (
    <div className="h-full w-full bg-terminal-bg">
      {!isConnected && (
        <ConnectionStatus message={statusMessage} />
      )}

      {isConnected && (
        <>
          <Terminal
            socket={socket}
            encryptInput={encryptInput}
            decryptOutput={decryptOutput}
            e2eReady={e2eReady}
          />
          {e2eReady && fingerprint && (
            <EncryptionBadge fingerprint={fingerprint} />
          )}
        </>
      )}
    </div>
  );
}

export default App;
