import { useEffect, useRef, useState, useCallback } from 'react';
import { Loader } from 'lucide-react';
import Terminal from './components/Terminal';
import ChannelChat from './components/ChannelChat';
import PairingScreen from './components/PairingScreen';
import Header from './components/Header';
import { useWebSocket } from './hooks/useWebSocket';
import { useE2E } from './hooks/useE2E';
import { useAuth } from './hooks/useAuth';
import { useNotifications } from './hooks/useNotifications';
import { mergeChannelActivity } from './lib/channelActivity';

function getMessageKey(item) {
  return `${item.role}:${item.ts || ''}:${item.content}`;
}

function mergeMessages(prev, incoming) {
  if (!Array.isArray(incoming) || incoming.length === 0) {
    return prev;
  }

  const next = [...prev];
  const seen = new Set(prev.map(getMessageKey));

  for (const item of incoming) {
    const key = getMessageKey(item);
    if (!seen.has(key)) {
      seen.add(key);
      next.push(item);
    }
  }

  return next;
}

function getBootstrapLabel({
  isLoading,
  isAuthenticated,
  e2eReady,
  pairingStatus,
  pairingError,
  isReturningDevice,
  connectionState,
}) {
  if (isLoading) {
    return 'Preparing secure session...';
  }

  if (!isAuthenticated) {
    if (pairingStatus === 'authenticating') {
      return 'Authenticating device...';
    }

    if (isReturningDevice && !pairingError && pairingStatus !== 'waiting') {
      return connectionState === 'reconnecting'
        ? 'Reconnecting to desktop...'
        : 'Connecting to desktop...';
    }

    return '';
  }

  if (!e2eReady) {
    return 'Securing session...';
  }

  return '';
}

function App() {
  // Operating mode: 'terminal' or 'channel' (default matches server default)
  const [clientMode, setClientMode] = useState('channel');
  const [systemState, setSystemState] = useState(null);

  // Channel messages — managed at App level so we never miss history
  const [channelMessages, setChannelMessages] = useState([]);
  const [channelWaiting, setChannelWaiting] = useState(false);
  const [channelActivities, setChannelActivities] = useState([]);

  // Initialize WebSocket connection
  const { socket, connectionState, disconnect } = useWebSocket();

  // Initialize authentication with pairing flow
  const {
    isAuthenticated,
    isLoading,
    pairingCode,
    pairingStatus,
    pairingError,
    isReturningDevice,
    serverIdentityJwk,
    signPayload,
    handleSecurityFailure,
    wasAuthenticatedThisSession
  } = useAuth(socket);
  const notifications = useNotifications(socket, isAuthenticated);

  // Initialize E2E encryption
  const {
    e2eReady,
    encryptInput,
    decryptOutput,
    handleServerKeyMessage
  } = useE2E({
    socket,
    isAuthenticated,
    serverIdentityJwk,
    signPayload,
    onSecurityFailure: handleSecurityFailure,
    disconnect
  });

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
  const messageChainRef = useRef(Promise.resolve());
  useEffect(() => {
    if (!socket) return;

    // Serialize async message processing through a promise chain.
    // Browser WS 'message' events fire synchronously in arrival order, but
    // async handlers run concurrently — so an `e2e_output` carrying
    // `channel_history` could start processing before `handleServerKeyMessage`
    // had finished setting `e2eReady`, and get silently dropped. Chaining
    // guarantees each message's handler completes before the next begins.
    messageChainRef.current = Promise.resolve();

    const processMessage = async (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (e) {
        return;
      }

      if (msg.type === 'e2e_server_key') {
        await handleServerKeyMessage(msg);
      }

      if (msg.type === 'operating_mode') {
        setClientMode(msg.mode);
      }

      if (msg.type === 'system_status') {
        setSystemState(msg.state || null);
      }

      if (msg.type === 'e2e_output') {
        const plaintext = await decryptOutput({ iv: msg.iv, data: msg.data, tag: msg.tag });
        if (plaintext === null) return;

        let parsed;
        try { parsed = JSON.parse(plaintext); } catch { return; }

        if (parsed.type === 'channel_history') {
          setChannelMessages(parsed.messages || []);
        } else if (parsed.type === 'channel_message') {
          setChannelWaiting(false);
          setChannelMessages(prev => mergeMessages(prev, [{
            role: parsed.role || 'assistant',
            content: parsed.content,
            ts: parsed.ts || new Date().toISOString(),
          }]));
          setChannelActivities(prev => prev.map((item) => (
            item.active
              ? { ...item, active: false, done: true, completedAt: parsed.ts || new Date().toISOString() }
              : item
          )));
        } else if (parsed.type === 'channel_activity' && parsed.activity) {
          setChannelActivities(prev => mergeChannelActivity(prev, parsed.activity));
        }
      }
    };

    const handleMessage = (event) => {
      messageChainRef.current = messageChainRef.current
        .then(() => processMessage(event))
        .catch((err) => {
          console.error('[MSG] Handler error:', err);
        });
    };

    socket.addEventListener('message', handleMessage);
    return () => socket.removeEventListener('message', handleMessage);
  }, [socket, handleServerKeyMessage, decryptOutput]);

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

  // If already authenticated this session, skip overlays and show main view
  const showMainView = wasAuthenticatedThisSession;
  const bootstrapLabel = getBootstrapLabel({
    isLoading,
    isAuthenticated,
    e2eReady,
    pairingStatus,
    pairingError,
    isReturningDevice,
    connectionState,
  });

  if (!showMainView) {
    if (bootstrapLabel) {
      return (
        <SafeAreaWrapper>
          <div className="flex flex-col items-center gap-3">
            <Loader className="w-6 h-6 text-white/70 animate-spin" strokeWidth={2} />
            <p className="text-sm text-white/50">{bootstrapLabel}</p>
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
  }

  // Main view
  return (
    <div className="h-dvh w-full flex flex-col bg-black pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]">
      <div className="flex-shrink-0 bg-black h-[env(safe-area-inset-top)]" />
      <Header
        connectionState={connectionState}
        clientMode={clientMode}
        onToggleMode={handleToggleMode}
        systemState={systemState}
        e2eReady={e2eReady}
        notifications={notifications}
      />
      {clientMode === 'channel' ? (
        <ChannelChat
          socket={socket}
          encryptInput={encryptInput}
          e2eReady={e2eReady}
          assistantName={systemState?.health?.channel?.assistantName || 'Operator'}
          draftStorageKey="root_operator_chat_draft"
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
