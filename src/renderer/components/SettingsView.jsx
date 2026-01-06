import { useState, useEffect } from 'react';
import { X, Trash2 } from 'lucide-react';
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
  const [pairedDevices, setPairedDevices] = useState([]);

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

        setToken(secureToken || '');
        setDomain((settings && settings.domain) || '');
        setDebugLogging((settings && settings.debugLogging) || false);
        setSubdomain(currentSubdomain || '');
        setPairedDevices(devices || []);
      } catch (e) {
        console.error('Failed to load settings:', e);
      }
    }
    loadSettings();
  }, [invoke]);

  const handleRemoveDevice = async (kid) => {
    try {
      await invoke('REMOVE_PAIRED_DEVICE', kid);
      setPairedDevices(prev => prev.filter(d => d.kid !== kid));
    } catch (e) {
      console.error('Failed to remove device:', e);
    }
  };

  const handleSave = async () => {
    try {
      await invoke('SET_SECURE_TOKEN', token);
      await invoke('SET_STORE', 'cfSettings', { domain, debugLogging });
      await onBack();
    } catch (e) {
      console.error('Failed to save settings:', e);
    }
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
    <div className="flex flex-col gap-1 pl-5 pr-4 py-2">
      {/* Row 1: Settings Title + Close Button */}
      <div className="flex justify-between items-center">
        <span className="font-mono text-xs font-normal tracking-wider text-foreground">
          SETTINGS
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onBack}
          className="rounded-full text-muted-foreground transition-colors duration-200"
        >
          <X strokeWidth={2} />
        </Button>
      </div>

      {/* Row 2: Subdomain customization */}
      <div className="flex flex-col gap-2 pt-1">
        <Label htmlFor="subdomain" className="text-xs text-muted-foreground">
          Tunnel Address
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
          className="w-full text-xs rounded-full bg-[#4B5AFF] hover:bg-[#4B5AFF]/90 transition-colors duration-200"
          size="sm"
        >
          {subdomainLoading ? 'Updating...' : 'Update Address'}
        </Button>
        {subdomainStatus && (
          <div className={`text-xs text-center ${
            subdomainStatus.startsWith('✓') ? 'text-[#4B5AFF]' : 'text-destructive'
          }`}>
            {subdomainStatus}
          </div>
        )}
      </div>

      {/* Row 3: Legacy settings */}
      <div className="flex flex-col gap-2 pt-3">
        <Label className="text-xs text-muted-foreground">
          Legacy Settings
        </Label>
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

      {/* Row 4: Debug logging toggle */}
      <div className="flex justify-between items-center pt-3">
        <Label htmlFor="debug-logging" className="text-sm">
          Debug Logging
        </Label>
        <Switch
          id="debug-logging"
          checked={debugLogging}
          onCheckedChange={setDebugLogging}
        />
      </div>

      {/* Row 5: Paired Devices */}
      <div className="flex flex-col gap-2 pt-3">
        <Label className="text-xs text-muted-foreground">
          Paired Devices
        </Label>
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
      </div>

      {/* Row 6: Save button */}
      <div className="pt-3 pb-1">
        <Button
          onClick={handleSave}
          className="w-full text-xs rounded-full bg-foreground text-background hover:bg-foreground/90 transition-colors duration-200"
          size="sm"
        >
          Save Changes
        </Button>
      </div>
    </div>
  );
}

export default SettingsView;
