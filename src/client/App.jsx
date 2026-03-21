import { useEffect, useState, useCallback } from 'react';
import { Loader2 } from 'lucide-react';
import Terminal from './components/Terminal';
import ChannelChat from './components/ChannelChat';
import PairingScreen from './components/PairingScreen';
import Header from './components/Header';
import { useWebSocket } from './hooks/useWebSocket';
import { useE2E } from './hooks/useE2E';
import { useAuth } from './hooks/useAuth';

function App() {
  // Operating mode: 'terminal' or 'channel' (default matches server default)
  const [clientMode, setClientMode] = useState('channel');
  const [systemState, setSystemState] = useState(null);

  // Channel messages — managed at App level so we never miss history
  const [channelMessages, setChannelMessages] = useState([]);
  const [channelWaiting, setChannelWaiting] = useState(false);
  const [channelActivities, setChannelActivities] = useState([]);

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

  // Toggle between channel and terminal mode
  const handleToggleMode = useCallback(() => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;

    const nextMode = clientMode === 'channel' ? 'terminal' : 'channel';
    setClientMode(nextMode);
    socket.send(JSON.stringify({
      type: 'set_mode',
      mode: nextMode,
    }));
  }, [socket, clientMode]);

  // Handle ALL WebSocket messages at App level — always mounted, never misses
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

      // Operating mode from server
      if (msg.type === 'operating_mode') {
        setClientMode(msg.mode);
      }

      if (msg.type === 'system_status') {
        setSystemState(msg.state || null);
      }

      // Channel messages (encrypted) — always try to decrypt
      if (msg.type === 'e2e_output') {
        const plaintext = await decryptOutput({ iv: msg.iv, data: msg.data, tag: msg.tag });
        if (plaintext === null) return;

        let parsed;
        try { parsed = JSON.parse(plaintext); } catch { return; }

        if (parsed.type === 'channel_history') {
          setChannelMessages(parsed.messages || []);
          setChannelWaiting(false);
        } else if (parsed.type === 'channel_message') {
          setChannelWaiting(false);
          setChannelMessages(prev => [...prev, {
            role: parsed.role || 'assistant',
            content: parsed.content,
            ts: parsed.ts || new Date().toISOString(),
          }]);
          setChannelActivities(prev => prev.map((item) => (
            item.active
              ? { ...item, active: false, done: true, completedAt: parsed.ts || new Date().toISOString() }
              : item
          )));
        } else if (parsed.type === 'channel_activity' && parsed.activity) {
          const activity = parsed.activity;
          const markerTs = activity.ts || new Date().toISOString();
          const isActive = activity.active !== false;

          if (activity.phase === 'idle') {
            setChannelActivities(prev => prev
              .map((item) => (
                item.active
                  ? { ...item, active: false, done: true, completedAt: markerTs }
                  : item
              ))
              .slice(-4));
            return;
          }

          const activityKey = `${activity.phase}:${activity.label}:${activity.toolName || ''}`;
          setChannelActivities(prev => {
            const next = prev
              .map((item) => (
                item.active
                  ? { ...item, active: false, done: true, completedAt: markerTs }
                  : item
              ))
              .filter((item, index, items) => {
                if (index !== items.length - 1) {
                  return true;
                }
                return item.key !== activityKey || item.active;
              });

            next.push({
              id: `${markerTs}:${activityKey}`,
              key: activityKey,
              label: activity.label,
              detail: activity.detail || '',
              active: isActive,
              done: !isActive,
              ts: markerTs,
              completedAt: !isActive ? markerTs : undefined,
            });

            return next.slice(-4);
          });
        }
      }
    };

    socket.addEventListener('message', handleMessage);
    return () => socket.removeEventListener('message', handleMessage);
  }, [socket, handleE2EInit, handleE2EReady, decryptOutput]);

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

  // If already authenticated this session, skip overlays and show main view
  const showMainView = wasAuthenticatedThisSession;

  if (!showMainView) {
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

    if (!isAuthenticated) {
      return (
        <PairingScreen
          code={pairingCode}
          status={pairingStatus}
          error={pairingError}
        />
      );
    }

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

  // Main view
  return (
    <div className="h-dvh w-full flex flex-col bg-black pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]">
      <div className="flex-shrink-0 bg-black h-[env(safe-area-inset-top)]" />
      <Header
        fingerprint={fingerprint}
        connectionState={connectionState}
        clientMode={clientMode}
        onToggleMode={handleToggleMode}
        systemState={systemState}
        e2eReady={e2eReady}
      />
      {clientMode === 'channel' ? (
        <ChannelChat
          socket={socket}
          encryptInput={encryptInput}
          e2eReady={e2eReady}
          messages={channelMessages}
          setMessages={setChannelMessages}
          activities={channelActivities}
          setActivities={setChannelActivities}
          waiting={channelWaiting}
          setWaiting={setChannelWaiting}
        />
      ) : (
        <Terminal
          socket={socket}
          encryptInput={encryptInput}
          decryptOutput={decryptOutput}
          e2eReady={e2eReady}
        />
      )}
    </div>
  );
}

export default App;
