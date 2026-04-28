import { useState, useEffect, useRef } from 'react';
import { useElectron } from './hooks/useElectron';
import MainView from './components/MainView';
import SettingsView from './components/SettingsView';
import LocalChatView from './components/LocalChatView';
import ViewerWindow from './components/ViewerWindow';
import CursorCompanionView from './components/CursorCompanionView';

const RENDERER_VIEW = typeof window !== 'undefined'
  ? new URLSearchParams(window.location.search).get('view')
  : null;
const IS_LOCAL_CHAT_VIEW = RENDERER_VIEW === 'chat';
const IS_VIEWER_WINDOW = RENDERER_VIEW === 'viewer';
const IS_CURSOR_COMPANION_VIEW = RENDERER_VIEW === 'cursor-companion';
const IS_AUXILIARY_VIEW =
  IS_LOCAL_CHAT_VIEW || IS_VIEWER_WINDOW || IS_CURSOR_COMPANION_VIEW;

function App() {
  const { invoke, on } = useElectron();
  const [view, setView] = useState('main'); // 'main' or 'settings'
  const [tunnelState, setTunnelState] = useState({
    active: false,
    connecting: false,
    url: '',
    fingerprint: null,
    sessionStartedAt: null,
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
    if (IS_AUXILIARY_VIEW) return undefined;
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
    if (IS_VIEWER_WINDOW || IS_CURSOR_COMPANION_VIEW) {
      return undefined;
    }

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
            fingerprint: tunnelStateFromMain.fingerprint || null,
            sessionStartedAt: tunnelStateFromMain.sessionStartedAt || null,
            mode: tunnelStateFromMain.mode || 'channel',
            channelConnected: tunnelStateFromMain.channelConnected || false,
            update: tunnelStateFromMain.update || null,
            health: tunnelStateFromMain.health || null,
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
    if (IS_VIEWER_WINDOW || IS_CURSOR_COMPANION_VIEW) {
      return undefined;
    }

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

      on('E2E_FINGERPRINT', (fingerprint, sessionStartedAt) => {
        setTunnelState(prev => ({ ...prev, fingerprint, sessionStartedAt }));
      }),

      on('SYNC_STATE', (state) => {
        setTunnelState({
          active: state.active || false,
          connecting: state.connecting || false,
          url: state.url || '',
          fingerprint: state.fingerprint || null,
          sessionStartedAt: state.sessionStartedAt || null,
          mode: state.mode || 'channel',
          channelConnected: state.channelConnected || false,
          update: state.update || null,
          health: state.health || null,
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
      fingerprint: null,
      sessionStartedAt: null,
      mode: tunnelState.mode,
      channelConnected: false,
      update: tunnelState.update || null,
      health: null,
    });
    await invoke('SET_TRAY_ICON', false);
  };

  return (
    <div ref={containerRef} className="flex flex-col">
      {IS_CURSOR_COMPANION_VIEW ? (
        <CursorCompanionView />
      ) : IS_VIEWER_WINDOW ? (
        <ViewerWindow />
      ) : IS_LOCAL_CHAT_VIEW ? (
        <LocalChatView tunnelState={tunnelState} />
      ) : view === 'main' ? (
        <MainView
          tunnelState={tunnelState}
          onStart={handleStart}
          onStop={handleStop}
          onShowSettings={() => setView('settings')}
        />
      ) : (
        <SettingsView
          onBack={() => setView('main')}
          tunnelState={tunnelState}
        />
      )}
    </div>
  );
}

export default App;
