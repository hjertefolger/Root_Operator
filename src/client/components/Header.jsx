import { useState } from 'react';
import { Shield, ShieldCheck, RotateCw, X, Loader, MessageCircle, Terminal } from 'lucide-react';
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
  const lines = [
    `${clientMode === 'channel' ? 'Chat' : 'Terminal'}: ${status.label}`,
    status.detail,
  ];

  if (systemState?.health?.tunnel?.label) {
    lines.push(`Tunnel: ${systemState.health.tunnel.label}`);
  }

  if (systemState?.health?.channel?.label) {
    lines.push(`Claude: ${systemState.health.channel.label}`);
  }

  if (systemState?.health?.channel?.activity?.label) {
    lines.push(`Activity: ${systemState.health.channel.activity.label}`);
  }

  return lines.filter(Boolean).join('\n');
}

function Header({ fingerprint, connectionState, clientMode, onToggleMode, systemState, e2eReady }) {
  const isReconnecting = connectionState === 'reconnecting';
  const [showModal, setShowModal] = useState(false);
  const words = fingerprint ? fingerprint.split('-') : [];
  const isSecure = !!fingerprint;
  const status = getClientStatus(systemState, connectionState, e2eReady, clientMode);
  const statusTooltip = buildStatusTooltip(status, systemState, clientMode);

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
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => fingerprint && setShowModal(true)}
            disabled={!fingerprint}
            className="rounded-full"
            title={fingerprint ? "E2E Encrypted - Tap to verify" : "Connecting..."}
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
          </Button>
        </div>
      </header>

      {/* Fingerprint verification modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black z-[2000] flex flex-col" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
          {/* Modal header matching main terminal header */}
          <div className="flex-shrink-0 h-11 flex items-center justify-between bg-black" style={{ paddingLeft: 12, paddingRight: 12 }}>
            <span className="font-mono text-xs font-normal tracking-wider text-white">
              E2E_BIP39_FINGERPRINT
            </span>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setShowModal(false)}
              className="rounded-full text-white/60 hover:text-white transition-colors duration-200"
            >
              <X strokeWidth={2} />
            </Button>
          </div>

          {/* Fingerprint words grid */}
          <div style={{ paddingLeft: 20, paddingRight: 16, marginTop: 8, paddingBottom: 12 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', rowGap: 8, columnGap: 6 }}>
              {words.map((word, i) => (
                <div
                  key={i}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 4,
                    width: '100%',
                    padding: '4px 0',
                    fontSize: 12,
                    borderRadius: 9999,
                    backgroundColor: 'rgba(255, 255, 255, 0.1)'
                  }}
                >
                  <span style={{ color: 'rgba(255, 255, 255, 0.5)', fontFamily: 'var(--font-mono)' }}>{i + 1}.</span>
                  <span style={{ color: 'white' }}>{word}</span>
                </div>
              ))}
            </div>
            <p style={{ fontSize: 12, color: 'rgba(255, 255, 255, 0.5)', textAlign: 'center', marginTop: 16 }}>
              Verify these words match your desktop app
            </p>
          </div>
        </div>
      )}
    </>
  );
}

export default Header;
