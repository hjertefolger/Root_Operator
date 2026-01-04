import { useState } from 'react';
import { useElectron } from '../hooks/useElectron';
import { Button } from "@/components/ui/button";
import PowerButton from './PowerButton';
import FingerprintSection from './FingerprintSection';

function MainView({ tunnelState, onStart, onStop, onShowSettings }) {
  const { invoke, send } = useElectron();
  const [fingerprintVisible, setFingerprintVisible] = useState(false);

  const { active, connecting, url, fingerprint } = tunnelState;

  const handleToggle = () => {
    if (!active && !connecting) {
      onStart();
    } else if (active) {
      onStop();
      setFingerprintVisible(false);
    }
  };

  const handleCopyLink = () => {
    if (!url) return;

    navigator.clipboard.writeText(url).then(() => {
      // Could add visual feedback here
    });
  };

  const handleToggleFingerprint = async () => {
    if (!fingerprint) return;

    if (fingerprintVisible) {
      setFingerprintVisible(false);
      await invoke('RESIZE_WINDOW', 80);
    } else {
      setFingerprintVisible(true);
      await invoke('RESIZE_WINDOW', 180);
    }
  };

  const handleShowSettings = async () => {
    await invoke('RESIZE_WINDOW', 320);
    onShowSettings();
  };

  const handleQuit = () => {
    send('QUIT');
  };

  return (
    <div className="flex flex-col justify-between h-full">
      {/* Row 1: Branding + Toggle */}
      <div className="flex justify-between items-center">
        <div className="flex items-center gap-2">
          <div className="flex items-center justify-center text-sm">◆</div>
          <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">POCKET</span>
        </div>

        <PowerButton
          active={active}
          connecting={connecting}
          onClick={handleToggle}
        />
      </div>

      {/* Row 2: Settings + Icons */}
      <div className="flex justify-between items-center min-h-[22px]">
        <div className="flex gap-3 items-center">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleQuit}
            className="text-xs uppercase tracking-wide h-auto p-0"
          >
            Quit
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleShowSettings}
            className="text-xs uppercase tracking-wide h-auto p-0"
          >
            Settings
          </Button>
        </div>

        <div className="flex items-center gap-2">
          {/* Lock icon - E2E encrypted */}
          <button
            onClick={handleToggleFingerprint}
            disabled={!fingerprint}
            className={`p-0 bg-transparent border-none cursor-pointer transition-opacity ${fingerprint ? 'opacity-60 hover:opacity-100' : 'opacity-60 cursor-default'
              }`}
            title={fingerprint ? "E2E Encrypted - Click to verify" : ""}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={fingerprint ? 'text-foreground' : 'text-muted'}>
              <rect width="18" height="11" x="3" y="11" rx="2" ry="2"/>
              <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
            </svg>
          </button>

          {/* Copy icon */}
          <button
            onClick={handleCopyLink}
            disabled={!url}
            className={`p-0 bg-transparent border-none cursor-pointer transition-opacity ${url ? 'opacity-60 hover:opacity-100' : 'opacity-60 cursor-default'
              }`}
            title={url ? "Copy tunnel link" : ""}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={url ? 'text-foreground' : 'text-muted'}>
              <rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>
              <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>
            </svg>
          </button>
        </div>
      </div>

      {/* Fingerprint section */}
      {fingerprintVisible && fingerprint && (
        <FingerprintSection fingerprint={fingerprint} />
      )}
    </div>
  );
}

export default MainView;
