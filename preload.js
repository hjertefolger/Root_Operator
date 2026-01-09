/**
 * ROOT OPERATOR - PRELOAD SCRIPT
 * Provides secure IPC bridge between renderer and main process
 * with context isolation enabled.
 */
const { contextBridge, ipcRenderer } = require('electron');

// Allowlist of valid IPC channels
const VALID_INVOKE_CHANNELS = [
    'START',
    'STOP',
    'GET_STORE',
    'SET_STORE',
    'RESIZE_WINDOW',
    'SET_TRAY_ICON',
    'REGISTER_KEY',
    'GET_SECURE_TOKEN',
    'SET_SECURE_TOKEN',
    'DELETE_SECURE_TOKEN',
    'CUSTOMIZE_SUBDOMAIN',
    'GET_SUBDOMAIN',
    'GET_MACHINE_ID',
    'VERIFY_PAIRING_CODE',
    'GET_PAIRED_DEVICES',
    'REMOVE_PAIRED_DEVICE',
    'GET_TUNNEL_STATE'
];

const VALID_SEND_CHANNELS = [
    'QUIT'
];

const VALID_RECEIVE_CHANNELS = [
    'TUNNEL_LIVE',
    'AUTH_FAILED',
    'CF_LOG',
    'E2E_FINGERPRINT',
    'SYNC_STATE'
];

// Expose protected methods that only allow specific channels
contextBridge.exposeInMainWorld('electronAPI', {
    // Invoke (request/response pattern)
    invoke: (channel, ...args) => {
        if (VALID_INVOKE_CHANNELS.includes(channel)) {
            return ipcRenderer.invoke(channel, ...args);
        }
        console.error(`[SECURITY] Blocked invoke to invalid channel: ${channel}`);
        return Promise.reject(new Error('Invalid IPC channel'));
    },

    // Send (fire and forget)
    send: (channel, ...args) => {
        if (VALID_SEND_CHANNELS.includes(channel)) {
            ipcRenderer.send(channel, ...args);
        } else {
            console.error(`[SECURITY] Blocked send to invalid channel: ${channel}`);
        }
    },

    // Receive (main -> renderer)
    on: (channel, callback) => {
        if (VALID_RECEIVE_CHANNELS.includes(channel)) {
            // Wrap callback to remove event object (prevents access to sender)
            const wrappedCallback = (event, ...args) => callback(...args);
            ipcRenderer.on(channel, wrappedCallback);

            // Return cleanup function
            return () => {
                ipcRenderer.removeListener(channel, wrappedCallback);
            };
        } else {
            console.error(`[SECURITY] Blocked listener on invalid channel: ${channel}`);
            return () => {};
        }
    },

    // One-time receive
    once: (channel, callback) => {
        if (VALID_RECEIVE_CHANNELS.includes(channel)) {
            ipcRenderer.once(channel, (event, ...args) => callback(...args));
        } else {
            console.error(`[SECURITY] Blocked once listener on invalid channel: ${channel}`);
        }
    }
});
