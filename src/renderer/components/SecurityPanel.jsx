import { useEffect, useState } from 'react';
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
      <span className="font-sans text-xs font-normal text-muted-foreground">
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

function SecurityPanel({ fingerprint, sessionStartedAt }) {
  const isReady = !!fingerprint;
  const fingerprintNodes = renderFingerprint(fingerprint);
  const started = formatTime(sessionStartedAt);
  const placeholder = <span className="text-muted-foreground">—</span>;

  return (
    <div className="flex flex-col gap-0 pt-4 pb-2">
      <Title trailing={<TwoDots />}>
        {isReady ? 'SECURED_SESSION' : 'PENDING_SESSION'}
      </Title>

      <div className="mt-4 flex flex-col gap-2">
        <Row label="Cipher" value="AES-256-GCM" />
        <Row label="Key exchange" value="ECDH P-256" />
        <Row label="Identity" value="RSA-PSS 2048" />
        <Row label="Session started" value={started || placeholder} />
      </div>

      <div className="mt-4">
        <Title trailing={<Fingerprint size={14} strokeWidth={2} className="text-[#4B5AFF]" />}>
          SESSION_FINGERPRINT
        </Title>
      </div>

      <div className="mt-4 flex flex-col gap-2">
        <span className="font-mono text-xs font-normal tracking-wider">
          {fingerprintNodes || placeholder}
        </span>
        <span className="font-sans text-xs font-normal text-muted-foreground">
          Verify with paired devices
        </span>
      </div>
    </div>
  );
}

export default SecurityPanel;
