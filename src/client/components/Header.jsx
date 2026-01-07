import { useState } from 'react';
import { Shield, ShieldCheck, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

function Header({ fingerprint }) {
  const [showModal, setShowModal] = useState(false);
  const words = fingerprint ? fingerprint.split('-') : [];
  const isSecure = !!fingerprint;

  const handleReload = () => {
    window.location.reload();
  };

  return (
    <>
      {/* Header bar matching tray app style */}
      <header className="flex-shrink-0 h-11 flex items-center justify-between bg-black" style={{ paddingLeft: 12, paddingRight: 12 }}>
        <span className="font-mono text-xs font-normal tracking-wider text-foreground">
          ROOT_OPERATOR
        </span>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={handleReload}
            className="rounded-full"
            title="Reload"
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
        <div className="fixed inset-0 bg-black z-[2000] flex flex-col p-5 pt-[calc(20px+env(safe-area-inset-top))]">
          <div className="flex justify-between items-center mb-6">
            <span className="font-mono text-xs font-normal tracking-wider text-foreground">
              E2E_FINGERPRINT
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowModal(false)}
              className="text-[#007AFF] hover:text-[#007AFF]/80"
            >
              Close
            </Button>
          </div>

          <div className="flex flex-wrap gap-2 justify-center">
            {words.map((word, i) => (
              <div
                key={i}
                className="inline-flex items-center gap-2 bg-white/10 px-3.5 py-2.5 rounded-lg min-w-[120px]"
              >
                <span className="text-xs text-white/50 font-mono">{i + 1}.</span>
                <span className="text-sm text-white font-mono">{word}</span>
              </div>
            ))}
          </div>

          <p className="mt-6 text-center text-[13px] text-white/50">
            Verify these words match your Mac
          </p>
        </div>
      )}
    </>
  );
}

export default Header;
