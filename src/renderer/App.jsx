import { useState, useEffect, useRef } from 'react';
import { useElectron } from './hooks/useElectron';
import MainView from './components/MainView';
import SettingsView from './components/SettingsView';

function App() {
  const { invoke, on } = useElectron();
  const [view, setView] = useState('main'); // 'main' or 'settings'
  const [tunnelState, setTunnelState] = useState({
    active: false,
    connecting: false,
    url: '',
    fingerprint: null
  });
  const containerRef = useRef(null);

  // Auto-resize window to fit content
  useEffect(() => {
    if (!containerRef.current) return;

    const resizeWindow = () => {
      const height = containerRef.current.scrollHeight;
      if (height > 0) {
        invoke('RESIZE_WINDOW', height);
      }
    };

    const observer = new ResizeObserver(() => {
      resizeWindow();
    });

    observer.observe(containerRef.current);
    resizeWindow(); // Initial resize

    return () => observer.disconnect();
  }, [invoke]);

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
  };

  return (
    <div ref={containerRef} className="flex flex-col">
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
    </div>
  );
}

export default App;
