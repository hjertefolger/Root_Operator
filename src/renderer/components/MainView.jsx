import { useState } from 'react';
import { Settings2, Shield, ShieldCheck, Copy, Check, CirclePlay, CirclePause, Loader, Plus, X } from 'lucide-react';
import { Button } from "@/components/ui/button";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { useElectron } from '../hooks/useElectron';
import FingerprintSection from './FingerprintSection';

// Only allow valid pairing code characters
const PAIRING_CODE_REGEXP = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]*$/;

function MainView({ tunnelState, onStart, onStop, onShowSettings }) {
  const { invoke } = useElectron();
  const [fingerprintVisible, setFingerprintVisible] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pairingMode, setPairingMode] = useState(false);
  const [pairingCode, setPairingCode] = useState('');
  const [pairingError, setPairingError] = useState('');
  const [pairingLoading, setPairingLoading] = useState(false);

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

  const handleOpenPairing = () => {
    setPairingMode(true);
    setPairingCode('');
    setPairingError('');
  };

  const handleClosePairing = () => {
    setPairingMode(false);
    setPairingCode('');
    setPairingError('');
  };

  const handlePairingCodeChange = (value) => {
    // Convert to uppercase and filter valid characters
    const filtered = value.toUpperCase().replace(/[^ABCDEFGHJKMNPQRSTUVWXYZ23456789]/g, '');
    setPairingCode(filtered);
    setPairingError('');

    // Auto-submit when 6 characters entered
    if (filtered.length === 6) {
      handlePairingSubmit(filtered);
    }
  };

  const handlePairingSubmit = async (code) => {
    if (code.length !== 6) return;

    setPairingLoading(true);
    setPairingError('');

    try {
      const result = await invoke('VERIFY_PAIRING_CODE', code);
      if (result.success) {
        handleClosePairing();
      } else {
        setPairingError(result.error || 'Invalid code');
        setPairingCode('');
      }
    } catch (e) {
      setPairingError('Failed to verify code');
      setPairingCode('');
    }

    setPairingLoading(false);
  };

  // Pairing Mode View
  if (pairingMode) {
    return (
      <div className="flex flex-col gap-1 pl-5 pr-4 py-2">
        {/* Row 1: ADD_DEVICE + Close Button */}
        <div className="flex justify-between items-center">
          <span className="font-mono text-xs font-normal tracking-wider text-foreground">
            ADD_DEVICE
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={handleClosePairing}
            className="rounded-full text-muted-foreground transition-colors duration-200"
          >
            <X strokeWidth={2} />
          </Button>
        </div>

        {/* Row 2: Centered Input OTP */}
        <div className="flex flex-col items-center justify-center pt-1 pb-3">
          <InputOTP
            maxLength={6}
            value={pairingCode}
            onChange={handlePairingCodeChange}
            disabled={pairingLoading}
            autoFocus
          >
            <InputOTPGroup>
              <InputOTPSlot index={0} className="w-8 h-10 text-base font-mono" />
              <InputOTPSlot index={1} className="w-8 h-10 text-base font-mono" />
              <InputOTPSlot index={2} className="w-8 h-10 text-base font-mono" />
              <InputOTPSlot index={3} className="w-8 h-10 text-base font-mono" />
              <InputOTPSlot index={4} className="w-8 h-10 text-base font-mono" />
              <InputOTPSlot index={5} className="w-8 h-10 text-base font-mono" />
            </InputOTPGroup>
          </InputOTP>

          <p className="text-xs text-muted-foreground mt-2">
            {pairingLoading ? 'Verifying...' : pairingError ? '' : 'Enter device pairing code'}
          </p>

          {pairingError && (
            <p className="text-xs text-destructive">{pairingError}</p>
          )}
        </div>
      </div>
    );
  }

  // Normal Mode View
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

      {/* Row 2: Plus/Lock/Copy Icons + Play/Pause Button */}
      <div className="flex justify-between items-center pb-0.5">
        <div className="flex gap-1 -ml-2">
          {/* Add Device button - only when tunnel is ready */}
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={handleOpenPairing}
            disabled={!url}
            className="rounded-full transition-none"
            title="Add Device"
          >
            <Plus strokeWidth={2} className={url ? 'text-[#4B5AFF]' : ''} />
          </Button>

          <Button
            variant="ghost"
            size="icon-sm"
            onClick={handleCopyLink}
            disabled={!url}
            className="rounded-full transition-none"
            title="Copy Address"
          >
            {copied ? (
              <Check strokeWidth={2} className="text-[#4B5AFF]" />
            ) : (
              <Copy strokeWidth={2} className={url ? 'text-[#4B5AFF]' : ''} />
            )}
          </Button>

          <Button
            variant="ghost"
            size="icon-sm"
            onClick={handleToggleFingerprint}
            disabled={!fingerprint}
            className="rounded-full transition-none"
            title="Verify Session"
          >
            {fingerprint ? (
              <ShieldCheck strokeWidth={2} className="text-[#4B5AFF]" />
            ) : (
              <Shield strokeWidth={2} />
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
            className="rounded-full text-xs py-1.5 h-auto gap-1 bg-foreground text-background hover:bg-foreground/90"
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
