import { useEffect, useCallback } from 'react';

/**
 * Hook for Electron IPC communication
 * Uses the secure electronAPI from preload script
 */
export function useElectron() {
  const api = window.electronAPI;

  // Send IPC message and get response
  const invoke = useCallback(async (channel, ...args) => {
    return await api.invoke(channel, ...args);
  }, [api]);

  // Send one-way IPC message
  const send = useCallback((channel, ...args) => {
    api.send(channel, ...args);
  }, [api]);

  // Listen to IPC events
  const on = useCallback((channel, callback) => {
    api.on(channel, callback);

    // Return cleanup function
    return () => {
      // Note: preload.js needs to support removeListener for this to work
      if (api.removeListener) {
        api.removeListener(channel, callback);
      }
    };
  }, [api]);

  return { invoke, send, on };
}
