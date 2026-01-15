import { useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import Terminal from './components/Terminal';
import PairingScreen from './components/PairingScreen';
import Header from './components/Header';
import { useWebSocket } from './hooks/useWebSocket';
import { useE2E } from './hooks/useE2E';
import { useAuth } from './hooks/useAuth';

function App() {
  // Initialize WebSocket connection
  const { socket, isReady, connectionState } = useWebSocket();

  // Initialize E2E encryption
  const {
    e2eReady,
    fingerprint,
    encryptInput,
    decryptOutput,
    handleE2EInit,
    handleE2EReady
  } = useE2E(socket);

  // Initialize authentication with pairing flow
  const {
    isAuthenticated,
    isLoading,
    pairingCode,
    pairingStatus,
    pairingError,
    wasAuthenticatedThisSession
  } = useAuth(socket);

  // Handle WebSocket messages for E2E
  useEffect(() => {
    if (!socket) return;

    const handleMessage = async (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (e) {
        return;
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
  }, [socket, handleE2EInit, handleE2EReady]);

  // Safe area wrapper for overlay screens
  const SafeAreaWrapper = ({ children }) => (
    <div className="h-dvh w-full flex flex-col bg-black pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]">
      <div className="flex-shrink-0 bg-black h-[env(safe-area-inset-top)]" />
      <div className="flex-1 flex items-center justify-center bg-black">
        {children}
      </div>
      <div className="flex-shrink-0 bg-black h-[env(safe-area-inset-bottom)]" />
    </div>
  );

  // Show loading state while keys are being set up
  if (isLoading) {
    return (
      <SafeAreaWrapper>
        <p className="text-sm text-white/50">Initializing...</p>
      </SafeAreaWrapper>
    );
  }

  // If already authenticated this session, skip overlays and show terminal view
  // (header spinner will indicate reconnection state)
  const showTerminalView = wasAuthenticatedThisSession;

  if (!showTerminalView) {
    // Show quick authenticating screen for returning devices
    if (!isAuthenticated && pairingStatus === 'authenticating') {
      return (
        <SafeAreaWrapper>
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="w-6 h-6 text-white animate-spin" />
            <p className="text-sm text-white/50">Authenticating...</p>
          </div>
        </SafeAreaWrapper>
      );
    }

    // Show pairing screen when not authenticated (new device)
    if (!isAuthenticated) {
      return (
        <PairingScreen
          code={pairingCode}
          status={pairingStatus}
          error={pairingError}
        />
      );
    }

    // Show securing screen when authenticated but E2E not yet ready
    if (!e2eReady) {
      return (
        <SafeAreaWrapper>
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="w-6 h-6 text-white animate-spin" />
            <p className="text-sm text-white/50">Securing connection...</p>
          </div>
        </SafeAreaWrapper>
      );
    }
  }

  // Show terminal when authenticated and E2E is ready
  return (
    <div className="h-dvh w-full flex flex-col bg-black pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]">
      {/* Top safe area */}
      <div className="flex-shrink-0 bg-black h-[env(safe-area-inset-top)]" />
      <Header fingerprint={fingerprint} connectionState={connectionState} />
      <Terminal
        socket={socket}
        encryptInput={encryptInput}
        decryptOutput={decryptOutput}
        e2eReady={e2eReady}
      />
    </div>
  );
}

export default App;
