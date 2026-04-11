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
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-[11px] uppercase tracking-wider text-white/42">{label}</span>
      <span className="font-mono text-[11px] text-white/88 text-right">{value}</span>
    </div>
  );
}

function Divider() {
  return (
    <div
      aria-hidden="true"
      className="my-3"
      style={{
        borderTop: '1px dashed rgba(255,255,255,0.14)',
      }}
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

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Session security details"
      className="absolute right-3 top-12 z-50 w-[280px] bg-black/95 backdrop-blur-sm rounded-lg p-4"
      style={{
        border: '1px solid rgba(75, 90, 255, 0.32)',
        boxShadow: '0 8px 32px rgba(0,0,0,0.6), 0 0 0 1px rgba(75,90,255,0.12)',
      }}
    >
      <div className="text-[10px] font-mono uppercase tracking-[0.12em] text-[#4B5AFF]">
        {isReady ? 'End-to-end encrypted' : 'Securing session'}
      </div>

      <Divider />

      <div className="flex flex-col gap-1.5">
        <Row label="Cipher" value="AES-256-GCM" />
        <Row label="Key exchange" value="ECDH P-256" />
        <Row label="Identity" value="RSA-PSS 2048" />
      </div>

      <Divider />

      <div className="flex flex-col gap-1.5">
        <Row
          label="Pinned desktop"
          value={pinnedShort || <span className="text-white/32">—</span>}
        />
        <Row
          label="Session started"
          value={started || <span className="text-white/32">—</span>}
        />
      </div>

      <Divider />

      <div className="flex flex-col gap-1">
        <div className="text-[10px] font-mono uppercase tracking-wider text-white/42">
          Session fingerprint
        </div>
        {fingerprintFormatted ? (
          <div className="font-mono text-[11px] text-white/88 leading-relaxed">
            {fingerprintFormatted}
          </div>
        ) : (
          <div className="font-mono text-[11px] text-white/32">—</div>
        )}
        <div className="text-[9px] text-white/42 mt-1 leading-snug">
          Compare with the desktop panel to verify no MITM.
        </div>
      </div>
    </div>
  );
}

export default SecurityPanel;
