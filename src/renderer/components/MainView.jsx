import { useState } from 'react';
import { Settings2, Shield, ShieldCheck, Copy, Check, CirclePlay, CirclePause, Loader } from 'lucide-react';
import { Button } from "@/components/ui/button";
import FingerprintSection from './FingerprintSection';

function MainView({ tunnelState, onStart, onStop, onShowSettings }) {
  const [fingerprintVisible, setFingerprintVisible] = useState(false);
  const [copied, setCopied] = useState(false);

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
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const handleToggleFingerprint = () => {
    if (!fingerprint) return;
    setFingerprintVisible(!fingerprintVisible);
  };

  return (
    <div className="flex flex-col gap-1 pl-5 pr-4 py-2">
      {/* Row 1: App Name + Settings */}
      <div className="flex justify-between items-center">
        <span className="font-mono text-xs font-normal tracking-wider text-foreground">
          ROOT_OPERATOR
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onShowSettings}
          className="rounded-full text-muted-foreground transition-colors duration-200"
        >
          <Settings2 strokeWidth={2} />
        </Button>
      </div>

      {/* Row 2: Lock/Copy Icons + Play/Pause Button */}
      <div className="flex justify-between items-center pb-0.5">
        <div className="flex gap-1 -ml-2">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={handleToggleFingerprint}
            disabled={!fingerprint}
            className="rounded-full transition-colors duration-200"
          >
            {fingerprint ? (
              <ShieldCheck strokeWidth={2} className="text-[#4B5AFF] transition-colors duration-200" />
            ) : (
              <Shield strokeWidth={2} className="transition-colors duration-200" />
            )}
          </Button>

          <Button
            variant="ghost"
            size="icon-sm"
            onClick={handleCopyLink}
            disabled={!url}
            className="rounded-full transition-colors duration-200"
          >
            {copied ? (
              <Check strokeWidth={2} className="text-[#4B5AFF] transition-colors duration-200" />
            ) : (
              <Copy strokeWidth={2} className={`transition-colors duration-200 ${url ? 'text-[#4B5AFF]' : ''}`} />
            )}
          </Button>
        </div>

        {connecting ? (
          <Button
            variant="default"
            size="sm"
            disabled
            className="rounded-full text-xs py-1.5 h-auto gap-1 bg-[#4B5AFF] hover:bg-[#4B5AFF]/90 transition-colors duration-200"
          >
            Connecting
            <Loader strokeWidth={2} className="animate-spin" />
          </Button>
        ) : active ? (
          <Button
            variant="default"
            size="sm"
            onClick={handleToggle}
            className="rounded-full text-xs py-1.5 h-auto gap-1 bg-foreground text-background hover:bg-foreground/90 transition-colors duration-200"
          >
            Pause
            <CirclePause strokeWidth={2} />
          </Button>
        ) : (
          <Button
            variant="default"
            size="sm"
            onClick={handleToggle}
            className="rounded-full text-xs py-1.5 h-auto gap-1 bg-[#4B5AFF] hover:bg-[#4B5AFF]/90 transition-colors duration-200"
          >
            Start
            <CirclePlay strokeWidth={2} />
          </Button>
        )}
      </div>

      {/* Fingerprint section */}
      {fingerprintVisible && fingerprint && (
        <FingerprintSection fingerprint={fingerprint} />
      )}
    </div>
  );
}

export default MainView;
