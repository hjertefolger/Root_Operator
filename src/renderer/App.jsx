import { useState, useEffect, useRef } from 'react';
import { useElectron } from './hooks/useElectron';
import MainView from './components/MainView';
import SettingsView from './components/SettingsView';

const DEV_UPDATE_PREVIEW = import.meta.env.DEV
  ? {
      supported: true,
      status: 'downloaded',
      label: 'Update 2.0.5 ready',
      detail: 'Preview mode in development. Restart action is not wired to a real downloaded update.',
      currentVersion: '2.0.0',
      availableVersion: '2.0.5',
      downloadedVersion: '2.0.5',
      progressPercent: 100,
      checkedAt: '',
      readyToInstall: true,
      canInstallNow: true,
      installBlockedReason: '',
      error: '',
      dismissedBanner: false,
      preview: true,
    }
  : null;

function withDevUpdatePreview(state) {
  if (!import.meta.env.DEV || !DEV_UPDATE_PREVIEW) {
    return state;
  }

  const currentUpdate = state?.update;

  if (currentUpdate && !['disabled', 'idle'].includes(currentUpdate.status)) {
    return state;
  }

  return {
    ...state,
    update: {
      ...DEV_UPDATE_PREVIEW,
      currentVersion: currentUpdate?.currentVersion || DEV_UPDATE_PREVIEW.currentVersion,
    },
  };
}

function App() {
  const { invoke, on } = useElectron();
  const [view, setView] = useState('main'); // 'main' or 'settings'
  const [tunnelState, setTunnelState] = useState({
    active: false,
    connecting: false,
    url: '',
    fingerprint: null,
    mode: 'channel',
    channelConnected: false,
    update: null,
    health: null,
  });
  const containerRef = useRef(null);
  const resizeFrameRef = useRef(null);
  const lastSentHeightRef = useRef(0);

  // Auto-resize window to fit content
  useEffect(() => {
    if (!containerRef.current) return;

    const resizeWindow = () => {
      if (resizeFrameRef.current != null) {
        cancelAnimationFrame(resizeFrameRef.current);
      }

      resizeFrameRef.current = requestAnimationFrame(() => {
        resizeFrameRef.current = null;

        if (!containerRef.current) return;

        const height = Math.ceil(containerRef.current.scrollHeight);
        if (height > 0 && height !== lastSentHeightRef.current) {
          lastSentHeightRef.current = height;
          invoke('RESIZE_WINDOW', height);
        }
      });
    };

    const observer = new ResizeObserver(() => {
      resizeWindow();
    });

    observer.observe(containerRef.current);
    resizeWindow(); // Initial resize

    return () => {
      observer.disconnect();
      if (resizeFrameRef.current != null) {
        cancelAnimationFrame(resizeFrameRef.current);
      }
    };
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
          setTunnelState(withDevUpdatePreview({
            active: tunnelStateFromMain.active || false,
            connecting: tunnelStateFromMain.connecting || false,
            url: tunnelStateFromMain.url || '',
            fingerprint: tunnelStateFromMain.fingerprint || null,
            mode: tunnelStateFromMain.mode || 'channel',
            channelConnected: tunnelStateFromMain.channelConnected || false,
            update: tunnelStateFromMain.update || null,
            health: tunnelStateFromMain.health || null,
          }));
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
          url,
        }));
        invoke('SET_TRAY_ICON', true);
      }),

      on('E2E_FINGERPRINT', (fingerprint) => {
        setTunnelState(prev => ({ ...prev, fingerprint }));
      }),

      on('SYNC_STATE', (state) => {
        setTunnelState(withDevUpdatePreview({
          active: state.active || false,
          connecting: state.connecting || false,
          url: state.url || '',
          fingerprint: state.fingerprint || null,
          mode: state.mode || 'channel',
          channelConnected: state.channelConnected || false,
          update: state.update || null,
          health: state.health || null,
        }));
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
      fingerprint: null,
      mode: tunnelState.mode,
      channelConnected: false,
      update: tunnelState.update || null,
      health: null,
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
