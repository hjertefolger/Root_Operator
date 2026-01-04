import { useState, useEffect } from 'react';
import { useElectron } from './hooks/useElectron';
import MainView from './components/MainView';
import SettingsView from './components/SettingsView';
import AuthModal from './components/AuthModal';

function App() {
  const { invoke, on } = useElectron();
  const [view, setView] = useState('main'); // 'main' or 'settings'
  const [tunnelState, setTunnelState] = useState({
    active: false,
    connecting: false,
    url: '',
    fingerprint: null
  });
  const [pendingAuth, setPendingAuth] = useState(null);

  // Apply dark mode
  useEffect(() => {
    document.documentElement.classList.add('dark');
  }, []);

  // Load initial settings
  useEffect(() => {
    async function loadInitialState() {
      try {
        const [token, settings] = await Promise.all([
          invoke('GET_SECURE_TOKEN'),
          invoke('GET_STORE', 'cfSettings')
        ]);
        // Settings loaded (stored in state if needed later)
      } catch (e) {
        console.error('Failed to load initial state:', e);
      }
    }
    loadInitialState();
  }, [invoke]);

  // Listen for tunnel events
  useEffect(() => {
    const cleanup = [
      on('TUNNEL_LIVE', (url) => {
        setTunnelState(prev => ({
          ...prev,
          connecting: false,
          active: true,
          url
        }));
        invoke('SET_TRAY_ICON', true);
      }),

      on('E2E_FINGERPRINT', (fingerprint) => {
        setTunnelState(prev => ({ ...prev, fingerprint }));
      }),

      on('AUTH_FAILED', (data) => {
        setPendingAuth(data);
      }),

      on('SYNC_STATE', (state) => {
        setTunnelState({
          active: state.active || false,
          connecting: false,
          url: state.url || '',
          fingerprint: state.fingerprint || null
        });
      })
    ];

    return () => {
      cleanup.forEach(fn => fn && fn());
    };
  }, [on, invoke]);

  const handleStart = async () => {
    setTunnelState(prev => ({ ...prev, connecting: true }));

    try {
      const [token, settings] = await Promise.all([
        invoke('GET_SECURE_TOKEN'),
        invoke('GET_STORE', 'cfSettings')
      ]);

      const cfSettings = {
        token: token || '',
        domain: (settings && settings.domain) || ''
      };

      const res = await invoke('START', cfSettings);
      if (res.success) {
        setTunnelState(prev => ({ ...prev, active: true }));
      } else {
        setTunnelState(prev => ({ ...prev, connecting: false }));
      }
    } catch (e) {
      console.error('Failed to start tunnel:', e);
      setTunnelState(prev => ({ ...prev, connecting: false }));
    }
  };

  const handleStop = async () => {
    await invoke('STOP');
    setTunnelState({
      active: false,
      connecting: false,
      url: '',
      fingerprint: null
    });
    await invoke('SET_TRAY_ICON', false);
    await invoke('RESIZE_WINDOW', 80);
  };

  const handleApproveDevice = async () => {
    if (pendingAuth) {
      await invoke('REGISTER_KEY', {
        kid: pendingAuth.kid,
        jwk: pendingAuth.jwk
      });
      setPendingAuth(null);
    }
  };

  return (
    <div className="h-full flex flex-col p-3">
      {view === 'main' && (
        <MainView
          tunnelState={tunnelState}
          onStart={handleStart}
          onStop={handleStop}
          onShowSettings={() => setView('settings')}
        />
      )}

      {view === 'settings' && (
        <SettingsView
          onBack={() => setView('main')}
          tunnelState={tunnelState}
        />
      )}

      {pendingAuth && (
        <AuthModal
          device={pendingAuth}
          onApprove={handleApproveDevice}
        />
      )}
    </div>
  );
}

export default App;
