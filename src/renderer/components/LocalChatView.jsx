import { useEffect, useState, useCallback } from 'react';
import rabbitLogo from '../../client/assets/rabbit.svg';
import ChannelChat from '../../client/components/ChannelChat';
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
        const activity = payload.activity;
        const markerTs = activity.ts || new Date().toISOString();
        const isActive = activity.active !== false;

        if (activity.phase === 'idle') {
          setActivities((prev) => prev
            .map((item) => (
              item.active
                ? { ...item, active: false, done: true, completedAt: markerTs }
                : item
            ))
            .slice(-4));
          return;
        }

        const activityKey = `${activity.phase}:${activity.label}:${activity.toolName || ''}`;
        setActivities((prev) => {
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
      } catch (error) {
        console.error('Failed to load local chat state:', error);
      }
    }

    loadInitialState();

    return () => {
      mounted = false;
      off?.();
    };
  }, [invoke, on]);

  const handleSubmitMessage = useCallback(async (text) => {
    const result = await invoke('SEND_LOCAL_CHAT_MESSAGE', text);
    if (!result?.success) {
      throw new Error(result?.error || 'Failed to send local chat message');
    }
  }, [invoke]);

  const channelStatus = tunnelState?.health?.channel || {
    level: 'orange',
    label: 'Channel status loading',
    detail: 'Waiting for Root Operator to report Claude channel status.',
  };

  const statusTooltip = [
    `Chat: ${channelStatus.label}`,
    channelStatus.detail,
    tunnelState?.health?.channel?.activity?.label ? `Activity: ${tunnelState.health.channel.activity.label}` : null,
  ].filter(Boolean).join('\n');

  return (
    <div className="flex h-dvh w-full flex-col bg-black text-white">
      <header className="flex h-11 flex-shrink-0 items-center justify-between bg-black px-3">
        <div className="inline-flex items-center gap-2">
          <img src={rabbitLogo} alt="Root Operator" style={{ height: 20 }} />
          <span className="font-mono text-[11px] tracking-wider text-white/60">
            LOCAL_CHAT
          </span>
        </div>
        <div
          className="inline-flex items-center gap-2"
          title={statusTooltip}
          aria-label={statusTooltip}
        >
          <span className="font-mono text-[11px] text-white/45">
            {channelStatus.label}
          </span>
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
        </div>
      </header>

      <ChannelChat
        messages={messages}
        setMessages={setMessages}
        activities={activities}
        setActivities={setActivities}
        waiting={waiting}
        setWaiting={setWaiting}
        onSubmitMessage={handleSubmitMessage}
        canSendOverride={true}
      />
    </div>
  );
}

export default LocalChatView;
