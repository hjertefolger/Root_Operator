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
    'GET_SECURE_TOKEN',
    'SET_SECURE_TOKEN',
    'DELETE_SECURE_TOKEN',
    'CUSTOMIZE_SUBDOMAIN',
    'GET_SUBDOMAIN',
    'GET_MACHINE_ID',
    'VERIFY_PAIRING_CODE',
    'CHECK_DEVICE_NAME_EXISTS',
    'GET_PAIRED_DEVICES',
    'REMOVE_PAIRED_DEVICE',
    'GET_TUNNEL_STATE',
    'GET_UPDATE_STATE',
    'CHECK_FOR_UPDATES',
    'INSTALL_UPDATE',
    'DISMISS_UPDATE_BANNER',
    'SET_OPERATING_MODE',
    'GET_OPERATING_MODE',
    'OPEN_LOCAL_CHAT_WINDOW',
    'GET_LOCAL_CHAT_STATE',
    'FETCH_LOCAL_CHAT_ATTACHMENT_BYTES',
    'SEND_LOCAL_CHAT_MESSAGE',
    'SEND_LOCAL_CHAT_FILE',
    'TOGGLE_LOCAL_CHAT_ALWAYS_ON_TOP',
    'GET_DYNAMIC_INDEXING_ENABLED',
    'SET_DYNAMIC_INDEXING_ENABLED',
    'CURSOR_SUBMIT',
    'CURSOR_DISMISS',
    'CURSOR_DISMISS_REPLY',
    'CURSOR_DISMISS_ATTACHMENT',
    'CURSOR_SHIFT_GESTURE',
    'CURSOR_DRAFT_UPDATE',
    'CURSOR_BLUR_PARK',
    'CURSOR_FOCUS_RESUME',
    'CURSOR_SET_MOUSE_PASSTHROUGH',
    'CURSOR_REPORT_HIT_REGIONS',
    'CURSOR_GET_STATE',
    'CURSOR_ANNOTATION_GET_INIT_STATE',
    'CURSOR_ANNOTATION_COMMIT',
    'CURSOR_ANNOTATION_CANCEL',
    'GET_CURSOR_COMPANION_ENABLED',
    'SET_CURSOR_COMPANION_ENABLED',
    'viewer:open',
    'viewer:get-state',
    'viewer:annotated',
    'viewer:send-back',
    'viewer:close'
];

const VALID_SEND_CHANNELS = [
    'QUIT'
];

const VALID_RECEIVE_CHANNELS = [
    'TUNNEL_LIVE',
    'AUTH_FAILED',
    'CF_LOG',
    'E2E_FINGERPRINT',
    'SYNC_STATE',
    'LOCAL_CHAT_EVENT',
    'LOCAL_CHAT_WINDOW_SHOWN',
    'CURSOR_STATE',
    'CURSOR_RIGHT_CLICK',
    'CURSOR_ERROR',
    'CURSOR_ENABLED_CHANGED',
    'CURSOR_COMPANION_ENABLED_CHANGED'
];

// Expose protected methods that only allow specific channels
function invokeAllowed(channel, ...args) {
    if (VALID_INVOKE_CHANNELS.includes(channel)) {
        return ipcRenderer.invoke(channel, ...args);
    }
    console.error(`[SECURITY] Blocked invoke to invalid channel: ${channel}`);
    return Promise.reject(new Error('Invalid IPC channel'));
}

function sendAllowed(channel, ...args) {
    if (VALID_SEND_CHANNELS.includes(channel)) {
        ipcRenderer.send(channel, ...args);
    } else {
        console.error(`[SECURITY] Blocked send to invalid channel: ${channel}`);
    }
}

function subscribeAllowed(channel, callback) {
    if (VALID_RECEIVE_CHANNELS.includes(channel)) {
        // Wrap callback to remove event object (prevents access to sender)
        const wrappedCallback = (event, ...args) => callback(...args);
        ipcRenderer.on(channel, wrappedCallback);

        // Return cleanup function
        return () => {
            ipcRenderer.removeListener(channel, wrappedCallback);
        };
    }

    console.error(`[SECURITY] Blocked listener on invalid channel: ${channel}`);
    return () => {};
}

contextBridge.exposeInMainWorld('electronAPI', {
    // Invoke (request/response pattern)
    invoke: invokeAllowed,

    // Send (fire and forget)
    send: sendAllowed,

    // Receive (main -> renderer)
    on: subscribeAllowed,

    // One-time receive
    once: (channel, callback) => {
        if (VALID_RECEIVE_CHANNELS.includes(channel)) {
            ipcRenderer.once(channel, (event, ...args) => callback(...args));
        } else {
            console.error(`[SECURITY] Blocked once listener on invalid channel: ${channel}`);
        }
    },

    viewer: {
        open: (payload) => invokeAllowed('viewer:open', payload),
        getState: () => invokeAllowed('viewer:get-state'),
        annotated: (payload) => invokeAllowed('viewer:annotated', payload),
        sendBack: (payload) => invokeAllowed('viewer:send-back', payload),
        close: () => invokeAllowed('viewer:close'),
    },
});
