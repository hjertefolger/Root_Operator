import { useState, useEffect, useRef } from 'react';
import { Settings2, Shield, ShieldCheck, Copy, Check, CirclePlay, CirclePause, Loader, Plus, X } from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { useElectron } from '../hooks/useElectron';
import FingerprintSection from './FingerprintSection';

// Random connecting state words
const CONNECTING_WORDS = ['Bridging', 'Phasing', 'Warping', 'Tunneling', 'Gliding', 'Flying', 'Encoding'];

// Only allow valid pairing code characters
const PAIRING_CODE_REGEXP = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]*$/;

// Device name validation
const MAX_NAME_LENGTH = 10;
const NAME_PATTERN = /^[a-zA-Z0-9]+(-[a-zA-Z0-9]+)*$/;

function MainView({ tunnelState, onStart, onStop, onShowSettings }) {
  const { invoke } = useElectron();
  const [fingerprintVisible, setFingerprintVisible] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pairingMode, setPairingMode] = useState(false);
  const [pairingStep, setPairingStep] = useState(1); // 1=name, 2=OTP
  const [deviceName, setDeviceName] = useState('');
  const [nameError, setNameError] = useState('');
  const [nameWarning, setNameWarning] = useState('');
  const [pairingCode, setPairingCode] = useState('');
  const [pairingError, setPairingError] = useState('');
  const [pairingLoading, setPairingLoading] = useState(false);
  const [connectingWord, setConnectingWord] = useState(CONNECTING_WORDS[0]);
  const wasConnectingRef = useRef(false);

  const { active, connecting, url, fingerprint } = tunnelState;

  // Pick a random connecting word when connecting starts
  useEffect(() => {
    if (connecting && !wasConnectingRef.current) {
      const randomWord = CONNECTING_WORDS[Math.floor(Math.random() * CONNECTING_WORDS.length)];
      setConnectingWord(randomWord);
    }
    wasConnectingRef.current = connecting;
  }, [connecting]);

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
    setPairingStep(1);
    setDeviceName('');
    setNameError('');
    setNameWarning('');
    setPairingCode('');
    setPairingError('');
  };

  const handleClosePairing = () => {
    setPairingMode(false);
    setPairingStep(1);
    setDeviceName('');
    setNameError('');
    setNameWarning('');
    setPairingCode('');
    setPairingError('');
  };

  // Sanitize device name input
  const sanitizeName = (value) => {
    return value
      .replace(/[^a-zA-Z0-9-]/g, '')
      .replace(/--+/g, '-')
      .replace(/^-/, '')
      .slice(0, MAX_NAME_LENGTH);
  };

  const validateName = (value) => {
    if (!value || value.length < 3) {
      return 'Must be 3-10 characters';
    }
    if (value.endsWith('-')) {
      return 'Cannot end with hyphen';
    }
    if (!NAME_PATTERN.test(value)) {
      return 'Letters, numbers, and hyphens only';
    }
    return '';
  };

  const handleNameChange = async (e) => {
    const sanitized = sanitizeName(e.target.value);
    setDeviceName(sanitized);
    setNameError('');
    setNameWarning('');

    // Check for duplicate name if valid length
    if (sanitized.length >= 3) {
      const exists = await invoke('CHECK_DEVICE_NAME_EXISTS', sanitized);
      if (exists) {
        setNameWarning('Device with this name already exists');
      }
    }
  };

  const handleNameSubmit = () => {
    const error = validateName(deviceName);
    if (error) {
      setNameError(error);
      return;
    }
    // Proceed to OTP step
    setPairingStep(2);
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
      const result = await invoke('VERIFY_PAIRING_CODE', code, deviceName);
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

  // Pairing Mode View - Step 1: Name Input
  if (pairingMode && pairingStep === 1) {
    return (
      <div className="flex flex-col gap-1 pl-5 pr-4 py-2">
        {/* Row 1: ADD_DEVICE + Next Button */}
        <div className="flex justify-between items-center">
          <span className="font-mono text-xs font-normal tracking-wider text-foreground">
            ADD_DEVICE
          </span>
          <div className="flex items-center gap-2">
            <Button
              onClick={handleNameSubmit}
              disabled={deviceName.length < 3}
              className={`rounded-full text-xs px-3 h-7 transition-colors duration-200 ${
                deviceName.length < 3
                  ? 'bg-muted text-muted-foreground'
                  : 'bg-[#4B5AFF] hover:bg-[#4B5AFF]/90 text-white'
              }`}
              size="sm"
            >
              Next
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={handleClosePairing}
              className="rounded-full text-muted-foreground transition-colors duration-200"
            >
              <X strokeWidth={2} />
            </Button>
          </div>
        </div>

        {/* Row 2: Name Input */}
        <div className="flex flex-col items-center justify-center pt-1 pb-3">
          <Input
            type="text"
            value={deviceName}
            onChange={handleNameChange}
            placeholder="My-iPhone"
            maxLength={MAX_NAME_LENGTH}
            autoFocus
            className="font-mono text-sm text-center w-32 h-10 border-0 border-b-2 border-border rounded-none bg-transparent focus-visible:ring-0 focus-visible:border-[#4B5AFF]"
          />

          <p className="text-xs text-muted-foreground mt-2">
            {nameError ? '' : 'Enter a name for this device'}
          </p>

          {nameError && (
            <p className="text-xs text-destructive">{nameError}</p>
          )}

          {nameWarning && !nameError && (
            <p className="text-xs text-amber-500">{nameWarning}</p>
          )}
        </div>
      </div>
    );
  }

  // Pairing Mode View - Step 2: OTP
  if (pairingMode && pairingStep === 2) {
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
            {connectingWord}
            <Loader strokeWidth={2} className="animate-spin" />
          </Button>
        ) : active ? (
          <Button
            variant="default"
            size="sm"
            onClick={handleToggle}
            className="rounded-full text-xs py-1.5 h-auto gap-1 bg-foreground text-background hover:bg-foreground/90"
          >
            Hover
            <CirclePause strokeWidth={2} />
          </Button>
        ) : (
          <Button
            variant="default"
            size="sm"
            onClick={handleToggle}
            className="rounded-full text-xs py-1.5 h-auto gap-1 bg-[#4B5AFF] hover:bg-[#4B5AFF]/90 transition-colors duration-200"
          >
            Jump
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
