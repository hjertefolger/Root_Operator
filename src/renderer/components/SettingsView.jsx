import { useState, useEffect } from 'react';
import { useElectron } from '../hooks/useElectron';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

function SettingsView({ onBack, tunnelState }) {
  const { invoke } = useElectron();
  const [token, setToken] = useState('');
  const [domain, setDomain] = useState('');
  const [debugLogging, setDebugLogging] = useState(false);
  const [subdomain, setSubdomain] = useState('');
  const [subdomainStatus, setSubdomainStatus] = useState('');
  const [subdomainLoading, setSubdomainLoading] = useState(false);

  // Load settings
  useEffect(() => {
    async function loadSettings() {
      try {
        const [secureToken, settings, currentSubdomain] = await Promise.all([
          invoke('GET_SECURE_TOKEN'),
          invoke('GET_STORE', 'cfSettings'),
          invoke('GET_SUBDOMAIN')
        ]);

        setToken(secureToken || '');
        setDomain((settings && settings.domain) || '');
        setDebugLogging((settings && settings.debugLogging) || false);
        setSubdomain(currentSubdomain || '');
      } catch (e) {
        console.error('Failed to load settings:', e);
      }
    }
    loadSettings();
  }, [invoke]);

  const handleSave = async () => {
    try {
      await invoke('SET_SECURE_TOKEN', token);
      await invoke('SET_STORE', 'cfSettings', { domain, debugLogging });
      await handleBack();
    } catch (e) {
      console.error('Failed to save settings:', e);
    }
  };

  const handleBack = async () => {
    await invoke('RESIZE_WINDOW', 80);
    onBack();
  };

  const handleChangeSubdomain = async () => {
    const newSubdomain = subdomain.trim().toLowerCase();

    // Validate format
    const validPattern = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
    if (!newSubdomain || newSubdomain.length < 3) {
      setSubdomainStatus('Subdomain must be at least 3 characters');
      return;
    }
    if (!validPattern.test(newSubdomain)) {
      setSubdomainStatus('Use letters, numbers, and hyphens only');
      return;
    }

    setSubdomainLoading(true);
    setSubdomainStatus('');

    try {
      const result = await invoke('CUSTOMIZE_SUBDOMAIN', newSubdomain);
      if (result.success) {
        setSubdomainStatus('✓ Address updated successfully!');
      } else {
        setSubdomainStatus(result.error || 'Failed to update address');
      }
    } catch (e) {
      setSubdomainStatus(e.message || 'Failed to update address');
    }

    setSubdomainLoading(false);
  };

  return (
    <div className="flex flex-col gap-4 opacity-100 transition-opacity">
      {/* Header */}
      <div className="flex justify-between items-center pb-3 border-b border-border">
        <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">SETTINGS</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleBack}
          className="text-xs uppercase tracking-wide h-auto p-0"
        >
          Back
        </Button>
      </div>

      {/* Content */}
      <div className="flex flex-col gap-3">
        {/* Subdomain customization */}
        <div className="mb-2 space-y-2">
          <Label htmlFor="subdomain" className="text-xs text-muted-foreground uppercase tracking-wide">
            Your Tunnel Address
          </Label>
          <div className="flex items-center gap-1">
            <Input
              id="subdomain"
              type="text"
              value={subdomain}
              onChange={(e) => setSubdomain(e.target.value)}
              placeholder="your-name"
              className="text-sm text-right h-8"
            />
            <span className="text-sm text-muted-foreground">.v0x.one</span>
          </div>
          <Button
            onClick={handleChangeSubdomain}
            disabled={subdomainLoading}
            className="w-full text-xs uppercase tracking-wide rounded-full"
            size="sm"
          >
            {subdomainLoading ? 'Updating...' : 'Update Address'}
          </Button>
          {subdomainStatus && (
            <div className={`text-xs text-center ${
              subdomainStatus.startsWith('✓') ? 'text-primary' : 'text-destructive'
            }`}>
              {subdomainStatus}
            </div>
          )}
        </div>

        {/* Legacy settings */}
        <div className="border-t border-border pt-3 mt-1 space-y-3">
          <Label className="text-xs text-muted-foreground uppercase tracking-wide">
            Legacy Settings
          </Label>
          <div className="space-y-2">
            <Input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Cloudflare Token (optional)"
              className="text-sm h-8"
            />
            <Input
              type="text"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="Custom Domain (optional)"
              className="text-sm h-8"
            />
          </div>
        </div>

        {/* Debug logging toggle */}
        <div className="flex justify-between items-center py-2">
          <Label htmlFor="debug-logging" className="text-sm">
            Debug Logging
          </Label>
          <Switch
            id="debug-logging"
            checked={debugLogging}
            onCheckedChange={setDebugLogging}
          />
        </div>

        {/* Save button */}
        <Button
          onClick={handleSave}
          className="w-full text-xs uppercase tracking-wide rounded-full mt-2"
          size="sm"
        >
          Save Changes
        </Button>
      </div>
    </div>
  );
}

export default SettingsView;
