const { test } = require('node:test');
const assert = require('node:assert/strict');

const { init } = require('./main/tray');

function createSubject({
    isConnecting = false,
    server = null,
    tunnelProcess = null,
    tunnelSettings = { token: 'abc' },
    startBridgeImpl = async () => {},
    toggleLocalChatWindowImpl = () => {},
} = {}) {
    const registrations = new Map();
    const stopCalls = [];
    const startCalls = [];
    const debugLogs = [];
    const localChatToggleCalls = [];

    const subject = init({
        app: {},
        Tray: function Tray() {},
        Menu: { buildFromTemplate: (template) => template },
        shell: { openExternal: () => {} },
        globalShortcut: {
            register(accelerator, callback) {
                registrations.set(accelerator, callback);
                return true;
            },
        },
        iconDirectory: '/tmp',
        getMainWindow: () => null,
        getOperatingMode: () => 'channel',
        setOperatingMode: () => {},
        showAboutWindow: () => {},
        syncStateWithRenderer: () => {},
        getStoredTunnelSettings: async () => tunnelSettings,
        startBridge: async (settings) => {
            startCalls.push(settings);
            return startBridgeImpl(settings);
        },
        stopBridge: () => {
            stopCalls.push(true);
        },
        getIsConnecting: () => isConnecting,
        getServer: () => server,
        getTunnelProcess: () => tunnelProcess,
        logDebug: (message) => {
            debugLogs.push(String(message));
        },
        toggleLocalChatWindow: () => {
            localChatToggleCalls.push(Date.now());
            toggleLocalChatWindowImpl();
        },
    });

    return {
        subject,
        getRegisteredAccelerators: () => Array.from(registrations.keys()),
        triggerShortcut: async (accelerator = 'CommandOrControl+Shift+J') => {
            const callback = registrations.get(accelerator);
            if (typeof callback !== 'function') {
                throw new Error(`Shortcut ${accelerator} was not registered`);
            }
            await callback();
        },
        getStartCalls: () => startCalls,
        getStopCalls: () => stopCalls,
        getDebugLogs: () => debugLogs,
        getLocalChatToggleCalls: () => localChatToggleCalls,
    };
}

test('registerGlobalShortcuts registers Cmd/Ctrl+Shift+J and starts the tunnel when idle', async () => {
    const harness = createSubject({ tunnelSettings: { subdomain: 'night-lab' } });

    harness.subject.registerGlobalShortcuts();

    assert.ok(harness.getRegisteredAccelerators().includes('CommandOrControl+Shift+J'));

    await harness.triggerShortcut('CommandOrControl+Shift+J');

    assert.deepEqual(harness.getStartCalls(), [{ subdomain: 'night-lab' }]);
    assert.equal(harness.getStopCalls().length, 0);
});

test('registerGlobalShortcuts stops the tunnel when one is already active', async () => {
    const harness = createSubject({ server: { close() {} } });

    harness.subject.registerGlobalShortcuts();
    await harness.triggerShortcut('CommandOrControl+Shift+J');

    assert.equal(harness.getStartCalls().length, 0);
    assert.equal(harness.getStopCalls().length, 1);
});

test('registerGlobalShortcuts stops the bridge and logs when tunnel startup fails', async () => {
    const harness = createSubject({
        startBridgeImpl: async () => {
            throw new Error('boom');
        },
    });

    harness.subject.registerGlobalShortcuts();
    await harness.triggerShortcut('CommandOrControl+Shift+J');

    assert.equal(harness.getStartCalls().length, 1);
    assert.equal(harness.getStopCalls().length, 1);
    assert.match(harness.getDebugLogs().join('\n'), /Failed to toggle tunnel from shortcut: boom/);
});

test('registerGlobalShortcuts registers Cmd/Ctrl+Shift+K for the desktop chat', async () => {
    const harness = createSubject();

    harness.subject.registerGlobalShortcuts();

    assert.ok(harness.getRegisteredAccelerators().includes('CommandOrControl+Shift+K'));

    await harness.triggerShortcut('CommandOrControl+Shift+K');

    assert.equal(harness.getLocalChatToggleCalls().length, 1);
});

test('Cmd/Ctrl+Shift+K logs when toggleLocalChatWindow throws', async () => {
    const harness = createSubject({
        toggleLocalChatWindowImpl: () => { throw new Error('chat-boom'); },
    });

    harness.subject.registerGlobalShortcuts();
    await harness.triggerShortcut('CommandOrControl+Shift+K');

    assert.match(harness.getDebugLogs().join('\n'), /Failed to toggle desktop chat: chat-boom/);
});
