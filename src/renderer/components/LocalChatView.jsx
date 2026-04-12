import { useEffect, useState, useCallback } from 'react';
import { PictureInPicture2 } from 'lucide-react';
import rabbitLogo from '../../client/assets/rabbit.svg';
import ChannelChat from '../../client/components/ChannelChat';
import { mergeChannelActivity } from '../../client/lib/channelActivity';
import { useElectron } from '../hooks/useElectron';

const STATUS_COLORS = {
  green: '#34d399',
  orange: '#f59e0b',
  red: '#d44d69',
};

function mergeMessages(prev, incoming) {
  if (!Array.isArray(incoming) || incoming.length === 0) {
    return prev;
  }

  const next = [...prev];
  const seen = new Set(prev.map((item) => `${item.role}:${item.ts || ''}:${item.content}`));

  for (const item of incoming) {
    const key = `${item.role}:${item.ts || ''}:${item.content}`;
    if (!seen.has(key)) {
      seen.add(key);
      next.push(item);
    }
  }

  return next;
}

function LocalChatView({ tunnelState }) {
  const { invoke, on } = useElectron();
  const [messages, setMessages] = useState([]);
  const [activities, setActivities] = useState([]);
  const [waiting, setWaiting] = useState(false);
  const [alwaysOnTop, setAlwaysOnTop] = useState(false);
  const [forceScrollToBottomKey, setForceScrollToBottomKey] = useState(0);

  useEffect(() => {
    let mounted = true;

    const off = on('LOCAL_CHAT_EVENT', (payload) => {
      if (!payload || typeof payload !== 'object') {
        return;
      }

      if (payload.type === 'channel_message') {
        setWaiting(false);
        setMessages((prev) => mergeMessages(prev, [{
          role: payload.role || 'assistant',
          content: payload.content,
          ts: payload.ts || new Date().toISOString(),
        }]));
        setActivities((prev) => prev.map((item) => (
          item.active
            ? { ...item, active: false, done: true, completedAt: payload.ts || new Date().toISOString() }
            : item
        )));
        return;
      }

      if (payload.type === 'channel_activity' && payload.activity) {
        setActivities((prev) => mergeChannelActivity(prev, payload.activity));
      }
    });
    const offShown = on('LOCAL_CHAT_WINDOW_SHOWN', () => {
      setForceScrollToBottomKey((prev) => prev + 1);
    });

    async function loadInitialState() {
      try {
        const state = await invoke('GET_LOCAL_CHAT_STATE');
        if (!mounted || !state) {
          return;
        }

        setMessages((prev) => mergeMessages(prev, state.messages || []));
        setWaiting(Boolean(state.waiting));
        setActivities(state.activities || []);
        setAlwaysOnTop(Boolean(state.alwaysOnTop));
      } catch (error) {
        console.error('Failed to load local chat state:', error);
      }
    }

    loadInitialState();

    return () => {
      mounted = false;
      off?.();
      offShown?.();
    };
  }, [invoke, on]);

  const handleSubmitMessage = useCallback(async (text) => {
    const result = await invoke('SEND_LOCAL_CHAT_MESSAGE', text);
    if (!result?.success) {
      throw new Error(result?.error || 'Failed to send local chat message');
    }
  }, [invoke]);

  const handleSendFile = useCallback(async (file, caption) => {
    const buffer = await file.arrayBuffer();
    const result = await invoke('SEND_LOCAL_CHAT_FILE', {
      data: Array.from(new Uint8Array(buffer)),
      filename: file.name,
      mimeType: file.type || 'application/octet-stream',
      caption: caption || '',
    });
    if (!result?.success) {
      throw new Error(result?.error || 'Failed to send file');
    }
  }, [invoke]);

  const handleToggleAlwaysOnTop = useCallback(async () => {
    try {
      const result = await invoke('TOGGLE_LOCAL_CHAT_ALWAYS_ON_TOP');
      if (result?.success) {
        setAlwaysOnTop(Boolean(result.alwaysOnTop));
      }
    } catch (error) {
      console.error('Failed to toggle always-on-top:', error);
    }
  }, [invoke]);

  const channelStatus = tunnelState?.health?.channel || {
    level: 'orange',
    label: 'Channel status loading',
    detail: 'Waiting for Root Operator to report chat status.',
  };
  const canSend = Boolean(
    tunnelState?.mode === 'channel'
    && channelStatus?.bridgeConnected
    && channelStatus?.phase === 'ready'
  );

  const statusTooltip = [
    `Chat: ${channelStatus.label}`,
    channelStatus.detail,
    tunnelState?.health?.channel?.activity?.label ? `Activity: ${tunnelState.health.channel.activity.label}` : null,
  ].filter(Boolean).join('\n');

  return (
    <div className="desktop-chat-window flex h-dvh w-full flex-col bg-black text-white">
      <header
        className="flex min-h-11 flex-shrink-0 items-center justify-between bg-black py-2 pr-3 select-none"
        style={{ WebkitAppRegion: 'drag', paddingLeft: 16 }}
      >
        <div className="inline-flex items-center">
          <img src={rabbitLogo} alt="Root Operator" style={{ height: 20 }} />
        </div>
        <div
          className="inline-flex items-center gap-3"
          style={{ WebkitAppRegion: 'no-drag' }}
          title={statusTooltip}
          aria-label={statusTooltip}
        >
          <span
            aria-hidden="true"
            style={{
              width: 6,
              height: 6,
              flexShrink: 0,
              borderRadius: '9999px',
              backgroundColor: STATUS_COLORS[channelStatus.level] || STATUS_COLORS.orange,
              boxShadow: `0 0 0 1px #000, 0 0 8px ${(STATUS_COLORS[channelStatus.level] || STATUS_COLORS.orange)}40`,
            }}
          />
          <button
            type="button"
            onClick={handleToggleAlwaysOnTop}
            onMouseDown={(event) => event.preventDefault()}
            title={alwaysOnTop ? 'Disable always on top' : 'Pin always on top'}
            aria-pressed={alwaysOnTop}
            tabIndex={-1}
            style={{
              border: 'none',
              background: 'transparent',
              padding: 0,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: alwaysOnTop ? '#4B5AFF' : 'rgba(255,255,255,0.42)',
              cursor: 'pointer',
              transition: 'color 0.15s ease',
              outline: 'none',
              boxShadow: 'none',
              WebkitTapHighlightColor: 'transparent',
              WebkitAppRegion: 'no-drag',
            }}
          >
            <PictureInPicture2 size={16} strokeWidth={2} />
          </button>
        </div>
      </header>

      <ChannelChat
        assistantName={channelStatus?.assistantName || 'Operator'}
        forceScrollToBottomKey={forceScrollToBottomKey}
        messages={messages}
        setMessages={setMessages}
        activities={activities}
        setActivities={setActivities}
        waiting={waiting}
        setWaiting={setWaiting}
        onSubmitMessage={handleSubmitMessage}
        onSendFile={handleSendFile}
        canSendOverride={canSend}
      />
    </div>
  );
}

export default LocalChatView;
