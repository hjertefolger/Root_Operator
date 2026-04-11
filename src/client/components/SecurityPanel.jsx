import { useEffect, useRef } from 'react';

function formatFingerprint(hex) {
  if (!hex || hex.length < 16) return null;
  return `${hex.slice(0, 4)} · ${hex.slice(4, 8)} · ${hex.slice(8, 12)} · ${hex.slice(12, 16)}`;
}

function formatTime(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

function Row({ label, value }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="font-mono text-xs font-normal tracking-wider text-muted-foreground">
        {label}
      </span>
      <span className="font-mono text-xs font-normal tracking-wider text-foreground text-right">
        {value}
      </span>
    </div>
  );
}

function Divider() {
  return (
    <div
      aria-hidden="true"
      className="my-3"
      style={{ borderTop: '1px dashed rgba(255,255,255,0.14)' }}
    />
  );
}

function SecurityPanel({
  isReady,
  pinnedDesktopKidHex,
  sessionFingerprintHex,
  sessionStartedAt,
  onClose,
  anchorRef,
}) {
  const panelRef = useRef(null);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (
        panelRef.current
        && !panelRef.current.contains(event.target)
        && anchorRef?.current
        && !anchorRef.current.contains(event.target)
      ) {
        onClose?.();
      }
    };
    const handleKey = (event) => {
      if (event.key === 'Escape') onClose?.();
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('touchstart', handleClickOutside);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('touchstart', handleClickOutside);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose, anchorRef]);

  const fingerprintFormatted = formatFingerprint(sessionFingerprintHex);
  const pinnedShort = pinnedDesktopKidHex ? pinnedDesktopKidHex.slice(0, 8) : null;
  const started = formatTime(sessionStartedAt);
  const placeholder = <span className="text-muted-foreground">—</span>;

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Session security details"
      className="absolute right-3 top-12 z-50 w-[280px] bg-black rounded-lg pl-5 pr-4 pt-3 pb-3"
      style={{
        border: '1px solid rgba(255,255,255,0.08)',
        boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
      }}
    >
      <div className="flex items-center justify-between">
        <span className="font-mono text-xs font-normal tracking-wider text-foreground">
          {isReady ? 'SESSION_SECURE' : 'SESSION_PENDING'}
        </span>
      </div>

      <Divider />

      <div className="flex flex-col gap-1">
        <Row label="Cipher" value="AES-256-GCM" />
        <Row label="Key exchange" value="ECDH P-256" />
        <Row label="Identity" value="RSA-PSS 2048" />
      </div>

      <Divider />

      <div className="flex flex-col gap-1">
        <Row label="Pinned desktop" value={pinnedShort || placeholder} />
        <Row label="Session started" value={started || placeholder} />
      </div>

      <Divider />

      <div className="flex flex-col gap-1">
        <span className="font-mono text-xs font-normal tracking-wider text-muted-foreground">
          Session fingerprint
        </span>
        <span className="font-mono text-xs font-normal tracking-wider text-foreground">
          {fingerprintFormatted || placeholder}
        </span>
        <span className="font-mono text-[11px] tracking-wider text-muted-foreground mt-1">
          Compare with desktop to verify
        </span>
      </div>
    </div>
  );
}

export default SecurityPanel;
