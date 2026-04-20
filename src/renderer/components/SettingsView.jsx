import { useState, useEffect, useRef } from 'react';
import { X, Loader, RefreshCw } from 'lucide-react';
import { useElectron } from '../hooks/useElectron';
import { Button } from "@/components/ui/button";
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
const DEFAULT_ASSISTANT_NAME = 'Operator';
const MAX_ASSISTANT_NAME_LENGTH = 24;

// Worker domain from environment (must be set in .env file)
const WORKER_DOMAIN = import.meta.env.VITE_WORKER_DOMAIN;

function SettingsView({ onBack, tunnelState }) {
  const { invoke } = useElectron();

  // Form state
  const [debugLogging, setDebugLogging] = useState(false);
  const [subdomain, setSubdomain] = useState('');
  const [assistantName, setAssistantName] = useState(DEFAULT_ASSISTANT_NAME);
  const [pairedDevices, setPairedDevices] = useState([]);
  const [updateActionPending, setUpdateActionPending] = useState(false);
  const [dynamicIndexingEnabled, setDynamicIndexingEnabled] = useState(false);
  const [dynamicIndexingBusy, setDynamicIndexingBusy] = useState(false);

  // Initial values for dirty checking
  const initialValues = useRef({});

  // Save button state: 'idle' | 'dirty' | 'saving' | 'saved'
  const [saveState, setSaveState] = useState('idle');

  // Subdomain-specific status (for validation errors)
  const [subdomainError, setSubdomainError] = useState('');
  const update = tunnelState.update;

  // Load settings and paired devices
  useEffect(() => {
    async function loadSettings() {
      try {
        const [settings, currentSubdomain, devices, indexingEnabled] = await Promise.all([
          invoke('GET_STORE', 'cfSettings'),
          invoke('GET_SUBDOMAIN'),
          invoke('GET_PAIRED_DEVICES'),
          invoke('GET_DYNAMIC_INDEXING_ENABLED').catch(() => false),
        ]);

        const loadedDebug = (settings && settings.debugLogging) || false;
        const loadedSubdomain = currentSubdomain || '';
        const loadedAssistantName = (settings && settings.assistantName) || DEFAULT_ASSISTANT_NAME;

        setDebugLogging(loadedDebug);
        setSubdomain(loadedSubdomain);
        setAssistantName(loadedAssistantName);
        setPairedDevices(devices || []);
        setDynamicIndexingEnabled(Boolean(indexingEnabled));

        // Store initial values for dirty checking
        initialValues.current = {
          debugLogging: loadedDebug,
          subdomain: loadedSubdomain,
          assistantName: loadedAssistantName,
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
      debugLogging !== initialValues.current.debugLogging ||
      subdomain !== initialValues.current.subdomain ||
      assistantName !== initialValues.current.assistantName;

    setSaveState(isDirty ? 'dirty' : 'idle');
  }, [debugLogging, subdomain, assistantName, saveState]);

  const handleRemoveDevice = async (kid) => {
    try {
      await invoke('REMOVE_PAIRED_DEVICE', kid);
      setPairedDevices(prev => prev.filter(d => d.kid !== kid));
    } catch (e) {
      console.error('Failed to remove device:', e);
    }
  };

  const handleDynamicIndexingToggle = async (nextValue) => {
    const next = Boolean(nextValue);
    const previous = dynamicIndexingEnabled;
    setDynamicIndexingEnabled(next); // optimistic
    setDynamicIndexingBusy(true);
    try {
      const result = await invoke('SET_DYNAMIC_INDEXING_ENABLED', next);
      if (!result || result.success === false) {
        setDynamicIndexingEnabled(previous);
      } else if (typeof result.enabled === 'boolean') {
        setDynamicIndexingEnabled(result.enabled);
      }
    } catch (e) {
      console.error('Failed to toggle dynamic indexing:', e);
      setDynamicIndexingEnabled(previous);
    } finally {
      setDynamicIndexingBusy(false);
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
    if (saveState === 'idle' || saveState === 'saving' || saveState === 'saved') {
      return;
    }

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
      const normalizedAssistantName = assistantName.trim().slice(0, MAX_ASSISTANT_NAME_LENGTH) || DEFAULT_ASSISTANT_NAME;
      const currentSettings = (await invoke('GET_STORE', 'cfSettings')) || {};

      // Save settings
      await invoke('SET_STORE', 'cfSettings', {
        ...currentSettings,
        debugLogging,
        assistantName: normalizedAssistantName,
      });
      setAssistantName(normalizedAssistantName);

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
        debugLogging,
        subdomain,
        assistantName: normalizedAssistantName,
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

  const handleCheckForUpdates = async () => {
    setUpdateActionPending(true);
    try {
      await invoke('CHECK_FOR_UPDATES');
    } finally {
      setUpdateActionPending(false);
    }
  };

  const handleInstallUpdate = async () => {
    setUpdateActionPending(true);
    try {
      await invoke('INSTALL_UPDATE');
    } finally {
      setUpdateActionPending(false);
    }
  };

  const getSaveButtonContent = () => {
    switch (saveState) {
      case 'saving':
        return (
          <>
            Saving
            <Loader strokeWidth={2} className="h-4 w-4 animate-spin" />
          </>
        );
      case 'saved':
        return 'Saved';
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
        return `${base} bg-[#4B5AFF] text-white gap-1 pointer-events-none`;
      case 'saved':
        return `${base} bg-[#4B5AFF] text-white pointer-events-none`;
      default:
        return `${base} bg-muted text-muted-foreground`;
    }
  };

  return (
    <div className="flex flex-col max-h-[400px] overflow-y-auto">
      {/* Sticky Header */}
      <div className="sticky top-0 flex justify-between items-center pl-5 pr-4 py-2 bg-background z-10">
        <span className="font-mono text-xs font-normal tracking-wider text-foreground">
          SETTINGS
        </span>
        <div className="flex items-center gap-2">
          <Button
            onClick={handleSave}
            disabled={saveState === 'idle'}
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
      <div className="px-5 pb-2">
        <Accordion type="multiple" className="w-full">
          {/* Section 1: Operator URL */}
          <AccordionItem value="operator-url" className="border-none">
            <AccordionTrigger className="text-sm font-medium hover:no-underline py-3">
              Operator URL
            </AccordionTrigger>
            <AccordionContent className="pb-4">
              <div className="flex flex-col gap-2">
                {subdomain ? (
                  <label className="flex items-center cursor-text">
                    <input
                      type="text"
                      value={subdomain}
                      onChange={(e) => {
                        const sanitized = sanitizeSubdomain(e.target.value);
                        setSubdomain(sanitized);
                        setSubdomainError('');
                      }}
                      maxLength={MAX_SUBDOMAIN_LENGTH}
                      className="font-mono bg-transparent border-none text-sm text-foreground focus:outline-none focus:bg-muted/30 rounded py-0.5 transition-colors"
                      style={{ width: `${subdomain.length}ch` }}
                    />
                    <span className="font-mono text-sm text-muted-foreground">.{WORKER_DOMAIN}</span>
                  </label>
                ) : (
                  <p className="font-mono text-sm text-muted-foreground">
                    Hit Jump to generate link
                  </p>
                )}
                {subdomainError && (
                  <span className="text-xs text-destructive">{subdomainError}</span>
                )}
              </div>
            </AccordionContent>
          </AccordionItem>

          {/* Section 2: Operator Name */}
          <AccordionItem value="operator-name" className="border-none">
            <AccordionTrigger className="text-sm font-medium hover:no-underline py-3">
              Operator Name
            </AccordionTrigger>
            <AccordionContent className="pb-4">
              <div className="flex flex-col gap-2">
                <label className="text-xs text-muted-foreground">
                  Assistant name shown in chat activity
                </label>
                <input
                  type="text"
                  value={assistantName}
                  onChange={(event) => setAssistantName(event.target.value.slice(0, MAX_ASSISTANT_NAME_LENGTH))}
                  maxLength={MAX_ASSISTANT_NAME_LENGTH}
                  placeholder={DEFAULT_ASSISTANT_NAME}
                  className="h-9 rounded-xl border border-border bg-transparent px-3 text-sm text-foreground outline-none transition-colors focus:border-[#4B5AFF]"
                />
                <p className="text-[11px] text-muted-foreground/80">
                  Example: Delivered to {assistantName.trim() || DEFAULT_ASSISTANT_NAME}
                </p>
              </div>
            </AccordionContent>
          </AccordionItem>

          {/* Section 3: Paired Devices */}
          <AccordionItem value="paired-devices" className="border-none">
            <AccordionTrigger className="text-sm font-medium hover:no-underline py-3">
              Paired Devices
            </AccordionTrigger>
            <AccordionContent className="pb-4">
              {pairedDevices.length === 0 ? (
                <p className="text-xs text-muted-foreground/60">No devices paired yet</p>
              ) : (
                <div className="flex flex-col">
                  {pairedDevices.map((device) => (
                    <div
                      key={device.kid}
                      className="flex items-center gap-3 border-b border-dashed border-border/60 py-2 last:border-b-0"
                    >
                      <span className="min-w-0 flex-1 break-all font-mono text-sm leading-5 text-muted-foreground">
                        {device.name}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={() => handleRemoveDevice(device.kid)}
                        className="h-6 w-6 shrink-0 rounded-full text-muted-foreground hover:text-destructive transition-colors duration-200"
                      >
                        <X strokeWidth={2} className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </AccordionContent>
          </AccordionItem>

          {/* Section 4: Dynamic Indexing */}
          <AccordionItem value="dynamic-indexing" className="border-none">
            <AccordionTrigger className="text-sm font-medium hover:no-underline py-3">
              Dynamic Indexing
            </AccordionTrigger>
            <AccordionContent className="pb-4">
              <div className="flex justify-between items-center gap-3">
                <span className="text-xs text-muted-foreground">
                  Create local chat embeddings for searchable memory as you chat.
                </span>
                <Switch
                  id="dynamic-indexing"
                  checked={dynamicIndexingEnabled}
                  disabled={dynamicIndexingBusy}
                  onCheckedChange={handleDynamicIndexingToggle}
                />
              </div>
            </AccordionContent>
          </AccordionItem>

          {/* Section 5: App Updates */}
          <AccordionItem value="app-updates" className="border-none">
            <AccordionTrigger className="text-sm font-medium hover:no-underline py-3">
              App Updates
            </AccordionTrigger>
            <AccordionContent className="pb-4">
              <div className="flex flex-col gap-3">
                <div className="rounded-2xl border border-dashed border-border/70 px-3 py-3">
                  <div className="min-w-0">
                    <p className="font-mono text-[12px] font-medium leading-tight tracking-[0.01em] text-foreground">
                      {update?.label || 'Update status unavailable'}
                    </p>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      {update?.detail || 'Update information will appear here in the installed app.'}
                    </p>
                    <p className="mt-2 text-[11px] text-muted-foreground/80">
                      Current version: {update?.currentVersion || tunnelState.version || 'Unknown'}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleCheckForUpdates}
                    disabled={!update?.supported || updateActionPending || update?.status === 'checking' || update?.status === 'downloading' || update?.status === 'installing'}
                    className="rounded-full text-xs"
                  >
                    {update?.status === 'checking' ? (
                      <>
                        Checking
                        <Loader strokeWidth={2} className="h-3 w-3 animate-spin" />
                      </>
                    ) : (
                      <>
                        Check now
                        <RefreshCw strokeWidth={2} className="h-3 w-3" />
                      </>
                    )}
                  </Button>

                  {update?.status === 'downloaded' && (
                    <Button
                      size="sm"
                      onClick={handleInstallUpdate}
                      disabled={updateActionPending || !update.canInstallNow}
                      className="rounded-full bg-[#4B5AFF] text-xs text-white hover:bg-[#4B5AFF]/90"
                    >
                      {updateActionPending ? 'Restarting' : 'Restart to update'}
                    </Button>
                  )}
                </div>
              </div>
            </AccordionContent>
          </AccordionItem>

          {/* Section 6: Debug Logging */}
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
