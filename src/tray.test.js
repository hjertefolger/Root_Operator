const { test } = require('node:test');
const assert = require('node:assert/strict');

const { init } = require('./main/tray');

function createSubject({
    isConnecting = false,
    server = null,
    tunnelProcess = null,
    tunnelSettings = { token: 'abc' },
    startBridgeImpl = async () => {},
} = {}) {
    let registeredAccelerator = null;
    let registeredCallback = null;
    const stopCalls = [];
    const startCalls = [];
    const debugLogs = [];

    const subject = init({
        app: {},
        Tray: function Tray() {},
        Menu: { buildFromTemplate: (template) => template },
        shell: { openExternal: () => {} },
        globalShortcut: {
            register(accelerator, callback) {
                registeredAccelerator = accelerator;
                registeredCallback = callback;
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
    });

    return {
        subject,
        getRegisteredAccelerator: () => registeredAccelerator,
        triggerShortcut: async () => {
            if (typeof registeredCallback !== 'function') {
                throw new Error('Shortcut callback was not registered');
            }
            await registeredCallback();
        },
        getStartCalls: () => startCalls,
        getStopCalls: () => stopCalls,
        getDebugLogs: () => debugLogs,
    };
}

test('registerGlobalShortcuts registers Cmd/Ctrl+Shift+J and starts the tunnel when idle', async () => {
    const harness = createSubject({ tunnelSettings: { subdomain: 'night-lab' } });

    harness.subject.registerGlobalShortcuts();

    assert.equal(harness.getRegisteredAccelerator(), 'CommandOrControl+Shift+J');

    await harness.triggerShortcut();

    assert.deepEqual(harness.getStartCalls(), [{ subdomain: 'night-lab' }]);
    assert.equal(harness.getStopCalls().length, 0);
});

test('registerGlobalShortcuts stops the tunnel when one is already active', async () => {
    const harness = createSubject({ server: { close() {} } });

    harness.subject.registerGlobalShortcuts();
    await harness.triggerShortcut();

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
    await harness.triggerShortcut();

    assert.equal(harness.getStartCalls().length, 1);
    assert.equal(harness.getStopCalls().length, 1);
    assert.match(harness.getDebugLogs().join('\n'), /Failed to toggle tunnel from shortcut: boom/);
});
