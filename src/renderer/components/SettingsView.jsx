import { useState, useEffect, useRef } from 'react';
import { X, Trash2, Loader, Check } from 'lucide-react';
import { useElectron } from '../hooks/useElectron';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

// Subdomain rules:
// - 3-10 lowercase alphanumeric characters and hyphens
// - No hyphen at start/end, no consecutive hyphens
const MAX_SUBDOMAIN_LENGTH = 10;
const SUBDOMAIN_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function SettingsView({ onBack, tunnelState }) {
  const { invoke } = useElectron();

  // Form state
  const [token, setToken] = useState('');
  const [domain, setDomain] = useState('');
  const [debugLogging, setDebugLogging] = useState(false);
  const [subdomain, setSubdomain] = useState('');
  const [pairedDevices, setPairedDevices] = useState([]);

  // Initial values for dirty checking
  const initialValues = useRef({});

  // Save button state: 'idle' | 'dirty' | 'saving' | 'saved'
  const [saveState, setSaveState] = useState('idle');

  // Subdomain-specific status (for validation errors)
  const [subdomainError, setSubdomainError] = useState('');

  // Load settings and paired devices
  useEffect(() => {
    async function loadSettings() {
      try {
        const [secureToken, settings, currentSubdomain, devices] = await Promise.all([
          invoke('GET_SECURE_TOKEN'),
          invoke('GET_STORE', 'cfSettings'),
          invoke('GET_SUBDOMAIN'),
          invoke('GET_PAIRED_DEVICES')
        ]);

        const loadedToken = secureToken || '';
        const loadedDomain = (settings && settings.domain) || '';
        const loadedDebug = (settings && settings.debugLogging) || false;
        const loadedSubdomain = currentSubdomain || '';

        setToken(loadedToken);
        setDomain(loadedDomain);
        setDebugLogging(loadedDebug);
        setSubdomain(loadedSubdomain);
        setPairedDevices(devices || []);

        // Store initial values for dirty checking
        initialValues.current = {
          token: loadedToken,
          domain: loadedDomain,
          debugLogging: loadedDebug,
          subdomain: loadedSubdomain,
        };
      } catch (e) {
        console.error('Failed to load settings:', e);
      }
    }
    loadSettings();
  }, [invoke]);

  // Check if form is dirty
  useEffect(() => {
    if (saveState === 'saving' || saveState === 'saved') return;

    const isDirty =
      token !== initialValues.current.token ||
      domain !== initialValues.current.domain ||
      debugLogging !== initialValues.current.debugLogging ||
      subdomain !== initialValues.current.subdomain;

    setSaveState(isDirty ? 'dirty' : 'idle');
  }, [token, domain, debugLogging, subdomain, saveState]);

  const handleRemoveDevice = async (kid) => {
    try {
      await invoke('REMOVE_PAIRED_DEVICE', kid);
      setPairedDevices(prev => prev.filter(d => d.kid !== kid));
    } catch (e) {
      console.error('Failed to remove device:', e);
    }
  };

  // Sanitize subdomain input - allow lowercase alphanumeric and hyphens
  const sanitizeSubdomain = (value) => {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '')   // Keep only a-z, 0-9, hyphen
      .replace(/--+/g, '-')          // Collapse consecutive hyphens
      .replace(/^-/, '')             // No leading hyphen
      .slice(0, MAX_SUBDOMAIN_LENGTH);
  };

  const validateSubdomain = (value) => {
    if (!value || value.length < 3) {
      return 'Must be 3-10 characters';
    }
    if (value.endsWith('-')) {
      return 'Cannot end with hyphen';
    }
    if (!SUBDOMAIN_PATTERN.test(value)) {
      return 'Letters, numbers, and hyphens only';
    }
    return '';
  };

  const handleSave = async () => {
    // Validate subdomain if it changed
    if (subdomain !== initialValues.current.subdomain) {
      const error = validateSubdomain(subdomain);
      if (error) {
        setSubdomainError(error);
        return;
      }
    }

    setSubdomainError('');
    setSaveState('saving');

    try {
      // Save token and settings
      await invoke('SET_SECURE_TOKEN', token);
      await invoke('SET_STORE', 'cfSettings', { domain, debugLogging });

      // Update subdomain if changed (already sanitized via input handler)
      if (subdomain !== initialValues.current.subdomain) {
        const result = await invoke('CUSTOMIZE_SUBDOMAIN', subdomain);
        if (!result.success) {
          setSubdomainError(result.error || 'Failed to update address');
          setSaveState('dirty');
          return;
        }
      }

      // Update initial values
      initialValues.current = {
        token,
        domain,
        debugLogging,
        subdomain,
      };

      setSaveState('saved');
      setTimeout(() => {
        setSaveState('idle');
      }, 1500);
    } catch (e) {
      console.error('Failed to save settings:', e);
      setSubdomainError(e.message || 'Failed to save');
      setSaveState('dirty');
    }
  };

  const getSaveButtonContent = () => {
    switch (saveState) {
      case 'saving':
        return (
          <>
            Saving
            <Loader strokeWidth={2} className="h-3 w-3 animate-spin" />
          </>
        );
      case 'saved':
        return (
          <>
            Saved
            <Check strokeWidth={2} className="h-3 w-3" />
          </>
        );
      default:
        return 'Save';
    }
  };

  const getSaveButtonClass = () => {
    const base = "rounded-full text-xs px-3 h-7 transition-colors duration-200";
    switch (saveState) {
      case 'dirty':
        return `${base} bg-[#4B5AFF] hover:bg-[#4B5AFF]/90 text-white`;
      case 'saving':
        return `${base} bg-[#4B5AFF] text-white gap-1`;
      case 'saved':
        return `${base} bg-[#4B5AFF] text-white gap-1`;
      default:
        return `${base} bg-muted text-muted-foreground`;
    }
  };

  return (
    <div className="flex flex-col max-h-[400px] overflow-y-auto">
      {/* Sticky Header */}
      <div className="sticky top-0 flex justify-between items-center px-5 py-2 bg-background z-10">
        <span className="font-mono text-xs font-normal tracking-wider text-foreground">
          SETTINGS
        </span>
        <div className="flex items-center gap-2">
          <Button
            onClick={handleSave}
            disabled={saveState === 'idle' || saveState === 'saving' || saveState === 'saved'}
            className={getSaveButtonClass()}
            size="sm"
          >
            {getSaveButtonContent()}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onBack}
            className="rounded-full text-muted-foreground transition-colors duration-200"
          >
            <X strokeWidth={2} />
          </Button>
        </div>
      </div>

      {/* Content */}
      <div className="px-5 py-2">
        <Accordion type="multiple" className="w-full">
          {/* Section 1: Operator URL */}
          <AccordionItem value="operator-url" className="border-none">
            <AccordionTrigger className="text-sm font-medium hover:no-underline py-3">
              Operator URL
            </AccordionTrigger>
            <AccordionContent className="pb-4">
              <div className="flex flex-col gap-2">
                <label className="flex items-center cursor-text">
                  <input
                    type="text"
                    value={subdomain}
                    onChange={(e) => {
                      const sanitized = sanitizeSubdomain(e.target.value);
                      setSubdomain(sanitized);
                      setSubdomainError('');
                    }}
                    placeholder="your-name"
                    maxLength={MAX_SUBDOMAIN_LENGTH}
                    className="font-mono bg-transparent border-none text-sm text-foreground focus:outline-none focus:bg-muted/30 rounded py-0.5 transition-colors"
                    style={{ width: `${subdomain.length || 9}ch` }}
                  />
                  <span className="font-mono text-sm text-muted-foreground">.rootoperator.dev</span>
                </label>
                {subdomainError && (
                  <span className="text-xs text-destructive">{subdomainError}</span>
                )}
              </div>
            </AccordionContent>
          </AccordionItem>

          {/* Section 2: Paired Devices */}
          <AccordionItem value="paired-devices" className="border-none">
            <AccordionTrigger className="text-sm font-medium hover:no-underline py-3">
              Paired Devices
            </AccordionTrigger>
            <AccordionContent className="pb-4">
              {pairedDevices.length === 0 ? (
                <p className="text-xs text-muted-foreground/60">No devices paired yet</p>
              ) : (
                <div className="flex flex-col gap-1">
                  {pairedDevices.map((device) => (
                    <div
                      key={device.kid}
                      className="flex justify-between items-center py-1.5 px-2 bg-muted/30 rounded"
                    >
                      <span className="font-mono text-xs text-muted-foreground">
                        {device.displayId}...
                      </span>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => handleRemoveDevice(device.kid)}
                        className="rounded-full text-muted-foreground hover:text-destructive transition-colors duration-200 h-6 w-6"
                      >
                        <Trash2 strokeWidth={2} className="h-3 w-3" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </AccordionContent>
          </AccordionItem>

          {/* Section 3: Custom Tunnel Settings */}
          <AccordionItem value="custom-tunnel" className="border-none">
            <AccordionTrigger className="text-sm font-medium hover:no-underline py-3">
              Custom Tunnel Settings
            </AccordionTrigger>
            <AccordionContent className="pb-4">
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="cf-token" className="text-xs text-muted-foreground">
                    Cloudflare Token
                  </Label>
                  <Input
                    id="cf-token"
                    type="password"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder="Optional"
                    className="text-sm h-8"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="custom-domain" className="text-xs text-muted-foreground">
                    Custom Domain
                  </Label>
                  <Input
                    id="custom-domain"
                    type="text"
                    value={domain}
                    onChange={(e) => setDomain(e.target.value)}
                    placeholder="Optional"
                    className="text-sm h-8"
                  />
                </div>
              </div>
            </AccordionContent>
          </AccordionItem>

          {/* Section 4: Debug Logging */}
          <AccordionItem value="debug-logging" className="border-none">
            <AccordionTrigger className="text-sm font-medium hover:no-underline py-3">
              Debug Logging
            </AccordionTrigger>
            <AccordionContent className="pb-4">
              <div className="flex justify-between items-center">
                <span className="text-xs text-muted-foreground">
                  Enable debug logs for troubleshooting
                </span>
                <Switch
                  id="debug-logging"
                  checked={debugLogging}
                  onCheckedChange={setDebugLogging}
                />
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </div>
    </div>
  );
}

export default SettingsView;
