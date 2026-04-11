import { useEffect, useRef, useState } from 'react';
import { Fingerprint } from 'lucide-react';

function renderFingerprint(hex) {
  if (!hex || hex.length < 16) return null;
  const groups = [hex.slice(0, 4), hex.slice(4, 8), hex.slice(8, 12), hex.slice(12, 16)];
  return groups.map((g, i) => (
    <span key={i}>
      {i > 0 && <span className="text-muted-foreground"> · </span>}
      <span className="text-foreground">{g}</span>
    </span>
  ));
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

function TwoDots({ color = '#4B5AFF' }) {
  const [active, setActive] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setActive((p) => (p + 1) % 2), 720);
    return () => clearInterval(t);
  }, []);

  const dotStyle = (idx) => ({
    width: 4,
    height: 4,
    borderRadius: '50%',
    backgroundColor: color,
    opacity: active === idx ? 1 : 0.18,
    transform: active === idx ? 'scale(1)' : 'scale(0.78)',
    transition: 'opacity 0.6s ease, transform 0.6s ease',
  });

  return (
    <div style={{ display: 'flex', gap: 3, alignItems: 'center', flexShrink: 0 }}>
      <div style={dotStyle(0)} />
      <div style={dotStyle(1)} />
    </div>
  );
}

function Title({ children, trailing }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="font-mono text-xs font-normal tracking-wider text-[#4B5AFF] leading-none">
        {children}
      </div>
      {trailing}
    </div>
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

  const fingerprintNodes = renderFingerprint(sessionFingerprintHex);
  const pinnedShort = pinnedDesktopKidHex ? pinnedDesktopKidHex.slice(0, 8) : null;
  const started = formatTime(sessionStartedAt);
  const placeholder = <span className="text-muted-foreground">—</span>;

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Session security details"
      className="absolute right-3 top-12 z-50 w-[280px] bg-black rounded-lg p-4"
      style={{
        border: '1px solid rgba(255,255,255,0.08)',
        boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
      }}
    >
      <Title trailing={<TwoDots />}>
        {isReady ? 'SECURED_SESSION' : 'PENDING_SESSION'}
      </Title>

      <div className="mt-4 flex flex-col gap-2">
        <Row label="Cipher" value="AES-256-GCM" />
        <Row label="Key exchange" value="ECDH P-256" />
        <Row label="Identity" value="RSA-PSS 2048" />
        <Row label="Pinned desktop" value={pinnedShort || placeholder} />
        <Row label="Session started" value={started || placeholder} />
      </div>

      <div className="mt-4 flex flex-col gap-2">
        <Title trailing={<Fingerprint size={14} strokeWidth={2} className="text-[#4B5AFF]" />}>
          SESSION_FINGERPRINT
        </Title>
        <span className="font-mono text-xs font-normal tracking-wider">
          {fingerprintNodes || placeholder}
        </span>
        <span className="font-mono text-xs font-normal tracking-wider text-muted-foreground">
          Compare with desktop to verify
        </span>
      </div>
    </div>
  );
}

export default SecurityPanel;
