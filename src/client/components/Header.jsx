import { Shield, ShieldCheck, RotateCw, Loader, MessageCircle, Terminal, Bell, BellDot } from 'lucide-react';
import { Button } from '@/components/ui/button';
import rabbitLogo from '../assets/rabbit.svg';

const STATUS_COLORS = {
  green: '#34d399',
  orange: '#f59e0b',
  red: '#d44d69',
};

function getClientStatus(systemState, connectionState, e2eReady, clientMode) {
  const overall = systemState?.health?.overall;
  const modeLabel = clientMode === 'channel' ? 'Chat' : 'Terminal';

  if (connectionState === 'server_stopped') {
    return {
      level: 'red',
      label: `${modeLabel} stopped`,
      detail: 'The desktop app stopped the bridge, so this client cannot send input.',
    };
  }

  if (connectionState === 'disconnected') {
    return {
      level: 'orange',
      label: 'Connecting',
      detail: 'This device is opening a connection to the desktop app.',
    };
  }

  if (connectionState === 'connecting' || connectionState === 'reconnecting') {
    return {
      level: overall?.level === 'red' ? 'red' : 'orange',
      label: 'Reconnecting',
      detail: 'The client connection is being re-established.',
    };
  }

  if (!e2eReady) {
    return {
      level: overall?.level === 'red' ? 'red' : 'orange',
      label: 'Securing session',
      detail: 'The encrypted session is still being established.',
    };
  }

  return overall || {
    level: 'orange',
    label: 'Loading status',
    detail: 'Waiting for the desktop app to report its readiness.',
  };
}

function buildStatusTooltip(status, systemState, clientMode) {
  const assistantName = systemState?.health?.channel?.assistantName || 'Operator';
  const lines = [
    `${clientMode === 'channel' ? 'Chat' : 'Terminal'}: ${status.label}`,
    status.detail,
  ];

  if (systemState?.health?.tunnel?.label) {
    lines.push(`Tunnel: ${systemState.health.tunnel.label}`);
  }

  if (systemState?.health?.channel?.label) {
    lines.push(`${assistantName}: ${systemState.health.channel.label}`);
  }

  if (systemState?.health?.channel?.activity?.label) {
    lines.push(`Activity: ${systemState.health.channel.activity.label}`);
  }

  return lines.filter(Boolean).join('\n');
}

function Header({ connectionState, clientMode, onToggleMode, systemState, e2eReady, notifications }) {
  const isReconnecting = connectionState === 'reconnecting';
  const isSecure = e2eReady;
  const status = getClientStatus(systemState, connectionState, e2eReady, clientMode);
  const statusTooltip = buildStatusTooltip(status, systemState, clientMode);
  const notificationTitle = notifications?.title || 'Enable notifications';

  const handleReload = () => {
    window.location.reload();
  };

  return (
    <>
      {/* Header bar matching tray app style */}
      <header className="flex-shrink-0 h-11 flex items-center justify-between bg-black" style={{ paddingLeft: 12, paddingRight: 12 }}>
        <div
          className="inline-flex items-center"
          title={statusTooltip}
          aria-label={statusTooltip}
          style={{ gap: 8 }}
        >
          <img src={rabbitLogo} alt="Root Operator" style={{ height: 20 }} />
        </div>
        <div className="flex items-center gap-1">
          {isReconnecting && (
            <div className="w-8 h-8 flex items-center justify-center">
              <Loader
                size={16}
                strokeWidth={2}
                className="text-[#4B5AFF] animate-spin"
              />
            </div>
          )}
          {/* Mode toggle: chat <-> terminal (dev only) */}
          {import.meta.env.DEV && onToggleMode && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onToggleMode}
              className="rounded-full"
              title={clientMode === 'channel' ? 'Switch to Terminal' : 'Switch to Chat'}
            >
              {clientMode === 'channel' ? (
                <Terminal
                  size={16}
                  strokeWidth={2}
                  className="text-[#4B5AFF]"
                />
              ) : (
                <MessageCircle
                  size={16}
                  strokeWidth={2}
                  className="text-[#4B5AFF]"
                />
              )}
            </Button>
          )}
          {/* Status indicator */}
          <div
            className="w-8 h-8 flex items-center justify-center"
            title={statusTooltip}
          >
            <span
              aria-hidden="true"
              style={{
                width: 6,
                height: 6,
                flexShrink: 0,
                borderRadius: '9999px',
                backgroundColor: STATUS_COLORS[status.level] || STATUS_COLORS.orange,
                boxShadow: `0 0 0 1px #000, 0 0 8px ${STATUS_COLORS[status.level] || STATUS_COLORS.orange}40`,
              }}
            />
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => notifications?.enableNotifications?.()}
            className="rounded-full"
            title={notificationTitle}
            aria-pressed={notifications?.enabled || false}
          >
            {notifications?.isLoading ? (
              <Loader
                size={16}
                strokeWidth={2}
                className="text-[#4B5AFF] animate-spin"
              />
            ) : notifications?.enabled ? (
              <BellDot
                size={16}
                strokeWidth={2}
                className="text-[#4B5AFF]"
              />
            ) : (
              <Bell
                size={16}
                strokeWidth={2}
                className={notifications?.supported ? 'text-white/60' : 'text-white/25'}
              />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={handleReload}
            className="rounded-full"
            title="Stop Tunnel"
          >
            <RotateCw
              size={16}
              strokeWidth={2}
              className="text-[#4B5AFF]"
            />
          </Button>
          <div
            className="w-8 h-8 flex items-center justify-center"
            title={e2eReady ? 'Authenticated E2E active' : 'Securing session'}
          >
            {isSecure ? (
              <ShieldCheck
                size={18}
                strokeWidth={2}
                className="text-[#4B5AFF]"
              />
            ) : (
              <Shield
                size={18}
                strokeWidth={2}
                className="text-white/40"
              />
            )}
          </div>
        </div>
      </header>
    </>
  );
}

export default Header;
