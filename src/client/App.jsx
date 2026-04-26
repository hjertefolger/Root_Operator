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
import { useFileAttachment } from './hooks/useFileAttachment';
import { mergeChannelActivity } from './lib/channelActivity';

function getMessageKey(item) {
  const attachmentKey = Array.isArray(item.attachments)
    ? item.attachments.map((attachment) => `${attachment.id || attachment.name}:${attachment.sha256 || ''}`).join('|')
    : '';
  return `${item.role}:${item.ts || ''}:${item.content}:${attachmentKey}`;
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
  // True once we've received a `channel_history` frame for the current session.
  // Distinguishes "still loading" from "loaded and empty" in ChannelChat.
  const [channelHistoryLoaded, setChannelHistoryLoaded] = useState(false);

  // Initialize WebSocket connection
  const { socket, connectionState, disconnect, forceReconnect } = useWebSocket();

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
  } = useAuth(socket, forceReconnect);
  const notifications = useNotifications(socket, isAuthenticated);

  // Initialize E2E encryption
  const {
    e2eReady,
    sessionFingerprintHex,
    sessionStartedAt,
    pinnedDesktopKidHex,
    encryptInput,
    encryptBuffer,
    decryptOutput,
    handleServerKeyMessage
  } = useE2E({
    socket,
    isAuthenticated,
    serverIdentityJwk,
    signPayload,
    onSecurityFailure: handleSecurityFailure,
    disconnect,
    forceReconnect,
  });

  // File attachment support
  const { sendFile, uploadProgress, abortUpload } = useFileAttachment({
    encryptBuffer,
    socket,
    e2eReady,
  });

  const handleSendFile = useCallback(async (file, caption) => {
    const result = await sendFile(file, caption);
    if (!result.success) {
      const err = new Error(result.error || 'Upload failed');
      err.uploadFailure = true;
      throw err;
    }
  }, [sendFile]);

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
  const pendingAttachmentRequestsRef = useRef(new Map());

  useEffect(() => () => {
    for (const pending of pendingAttachmentRequestsRef.current.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Connection closed'));
    }
    pendingAttachmentRequestsRef.current.clear();
  }, [socket]);

  // A new socket means a new session — reset history-loaded so the chat
  // shows the loading state again until the server's channel_history arrives.
  useEffect(() => {
    setChannelHistoryLoaded(false);
  }, [socket]);

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
          const incoming = Array.isArray(parsed.messages) ? parsed.messages : [];
          // Replace only on the first arrival per session. Subsequent
          // re-sends (reconnect mid-conversation) merge so we don't clobber
          // any channel_message that arrived first on a slow path.
          setChannelMessages((prev) => (prev.length === 0 ? incoming : mergeMessages(prev, incoming)));
          setChannelHistoryLoaded(true);
        } else if (parsed.type === 'channel_message') {
          // Clear badge when receiving a message while visible
          if (!document.hidden && 'clearAppBadge' in navigator) {
            navigator.clearAppBadge().catch(() => {});
          }
          if (!document.hidden && 'serviceWorker' in navigator && navigator.serviceWorker.controller) {
            navigator.serviceWorker.controller.postMessage({ type: 'clear_badge' });
          }
          setChannelWaiting(false);
          setChannelMessages(prev => mergeMessages(prev, [{
            role: parsed.role || 'assistant',
            content: parsed.content,
            ts: parsed.ts || new Date().toISOString(),
            attachments: parsed.attachments,
            external_ref: parsed.external_ref,
          }]));
          setChannelActivities(prev => prev.map((item) => (
            item.active
              ? { ...item, active: false, done: true, completedAt: parsed.ts || new Date().toISOString() }
              : item
          )));
        } else if (parsed.type === 'attachment_bytes_response') {
          const pending = pendingAttachmentRequestsRef.current.get(parsed.request_id);
          if (!pending) {
            return;
          }

          pendingAttachmentRequestsRef.current.delete(parsed.request_id);
          if (parsed.isError) {
            pending.reject(new Error(parsed.error || 'Image unavailable'));
            return;
          }

          pending.resolve({
            attachmentId: parsed.attachment_id,
            bytesBase64: parsed.bytesBase64,
            mime: parsed.mime,
          });
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

  const [appActionPending, setAppActionPending] = useState(null);

  useEffect(() => {
    if (!appActionPending) return undefined;
    if (connectionState === 'reconnecting' || connectionState === 'disconnected' || connectionState === 'server_stopped') {
      setAppActionPending(null);
      return undefined;
    }
    const timer = setTimeout(() => setAppActionPending(null), 20000);
    return () => clearTimeout(timer);
  }, [appActionPending, connectionState]);

  const handleRequestAppAction = useCallback(async (action) => {
    if (!socket || socket.readyState !== WebSocket.OPEN || !e2eReady) {
      throw new Error('Secure session unavailable');
    }
    if (action !== 'restart' && action !== 'exit') {
      throw new Error(`Unsupported app action: ${action}`);
    }
    const encrypted = await encryptInput(JSON.stringify({ action }));
    if (!encrypted) {
      throw new Error('Secure session unavailable');
    }
    socket.send(JSON.stringify({ type: 'e2e_app_control', ...encrypted }));
    setAppActionPending(action);
  }, [e2eReady, encryptInput, socket]);

  const handleRequestAttachmentBytes = useCallback(async ({ attachmentId, externalRef }) => {
    if (!socket || socket.readyState !== WebSocket.OPEN || !e2eReady) {
      throw new Error('Secure session unavailable');
    }
    if (!attachmentId || !externalRef) {
      throw new Error('Attachment reference missing');
    }

    const requestId = globalThis.crypto?.randomUUID?.() || `att-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const encrypted = await encryptInput(JSON.stringify({
      type: 'fetch_attachment_bytes',
      request_id: requestId,
      attachment_id: attachmentId,
      external_ref: externalRef,
    }));

    if (!encrypted) {
      throw new Error('Secure session unavailable');
    }

    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = pendingAttachmentRequestsRef.current.get(requestId);
        if (!pending) {
          return;
        }
        pendingAttachmentRequestsRef.current.delete(requestId);
        pending.reject(new Error('Image unavailable'));
      }, 15000);

      pendingAttachmentRequestsRef.current.set(requestId, {
        timer,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      socket.send(JSON.stringify({ type: 'e2e_input', ...encrypted }));
    });
  }, [e2eReady, encryptInput, socket]);

  const handleSendDocAnnotation = useCallback(async ({ filename, items }) => {
    if (!socket || socket.readyState !== WebSocket.OPEN || !e2eReady) {
      throw new Error('Secure session unavailable');
    }
    if (typeof filename !== 'string' || filename.length === 0) {
      throw new Error('Document name missing');
    }
    if (!Array.isArray(items) || items.length === 0) {
      throw new Error('No annotations to send');
    }
    // Cap shape at the client too so a buggy local state can't blast a
    // huge payload — the server enforces the same bounds defensively.
    if (items.length > 50) {
      throw new Error('Too many annotations to send at once');
    }
    const safeItems = items.map((item, idx) => {
      if (!item || typeof item !== 'object') {
        throw new Error(`Annotation #${idx + 1} is malformed`);
      }
      const quote = typeof item.quote === 'string' ? item.quote : '';
      const comment = typeof item.comment === 'string' ? item.comment : '';
      if (quote.length === 0 || comment.length === 0) {
        throw new Error(`Annotation #${idx + 1} is empty`);
      }
      return { quote: quote.slice(0, 1000), comment: comment.slice(0, 2000) };
    });
    const payload = JSON.stringify({
      filename: filename.slice(0, 200),
      items: safeItems,
    });
    const encrypted = await encryptInput(payload);
    if (!encrypted) {
      throw new Error('Secure session unavailable');
    }
    socket.send(JSON.stringify({ type: 'e2e_doc_annotation', ...encrypted }));
  }, [e2eReady, encryptInput, socket]);

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
        pinnedDesktopKidHex={pinnedDesktopKidHex}
        sessionFingerprintHex={sessionFingerprintHex}
        sessionStartedAt={sessionStartedAt}
        onRequestAppAction={handleRequestAppAction}
        appActionPending={appActionPending}
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
          historyLoaded={channelHistoryLoaded}
          activities={channelActivities}
          setActivities={setChannelActivities}
          waiting={channelWaiting}
          setWaiting={setChannelWaiting}
          onSendFile={handleSendFile}
          onSendDocAnnotation={handleSendDocAnnotation}
          onRequestAttachmentBytes={handleRequestAttachmentBytes}
          uploadProgress={uploadProgress}
          onAbortUpload={abortUpload}
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
