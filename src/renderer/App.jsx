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

  // Load initial settings and sync tunnel state
  useEffect(() => {
    async function loadInitialState() {
      try {
        // Request authoritative tunnel state from main process
        // This eliminates race conditions with SYNC_STATE event
        const [tunnelStateFromMain] = await Promise.all([
          invoke('GET_TUNNEL_STATE'),
          invoke('GET_SECURE_TOKEN'),
          invoke('GET_STORE', 'cfSettings')
        ]);

        if (tunnelStateFromMain) {
          setTunnelState({
            active: tunnelStateFromMain.active || false,
            connecting: tunnelStateFromMain.connecting || false,
            url: tunnelStateFromMain.url || '',
            fingerprint: tunnelStateFromMain.fingerprint || null
          });
          // Sync tray icon with actual state
          invoke('SET_TRAY_ICON', tunnelStateFromMain.active);
        }
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
          connecting: state.connecting || false,
          url: state.url || '',
          fingerprint: state.fingerprint || null
        });
        // Sync tray icon with authoritative state
        invoke('SET_TRAY_ICON', state.active || false);
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
