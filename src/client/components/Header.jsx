import { useState } from 'react';
import { Shield, ShieldCheck, RotateCw, X, Loader } from 'lucide-react';
import { Button } from '@/components/ui/button';

function Header({ fingerprint, connectionState }) {
  const isReconnecting = connectionState === 'reconnecting';
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
          {isReconnecting && (
            <div className="w-8 h-8 flex items-center justify-center">
              <Loader
                size={16}
                strokeWidth={2}
                className="text-[#4B5AFF] animate-spin"
              />
            </div>
          )}
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
