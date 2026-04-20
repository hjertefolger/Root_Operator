const { test } = require('node:test');
const assert = require('node:assert/strict');

const { init } = require('./main/tunnel');

function createSubject() {
    const state = {
        currentTunnelUrl: 'https://night-lab.trycloudflare.com',
        isConnecting: true,
        server: {
            closeCalled: 0,
            close() {
                this.closeCalled += 1;
            },
        },
        wss: { label: 'wss' },
        tunnelProcess: {
            removed: 0,
            stopped: 0,
            removeAllListeners() {
                this.removed += 1;
            },
            stop() {
                this.stopped += 1;
            },
        },
        wakeLock: {
            killed: 0,
            kill() {
                this.killed += 1;
            },
        },
        ptyProcess: {
            killed: 0,
            kill() {
                this.killed += 1;
            },
        },
        fingerprint: 'abc123',
        sessionStartedAt: 'now',
    };

    const calls = {
        sync: 0,
        teardownChannelMode: 0,
        clearActiveClients: 0,
        clearPendingPairings: 0,
        setOutputBuffer: [],
        logDebug: [],
    };

    const subject = init({
        fs: {
            existsSync: () => false,
            readFileSync: () => '{}',
        },
        path: require('node:path'),
        crypto: { randomUUID: () => 'machine-1' },
        keytar: {},
        cloudflared: { use() {}, tunnel() {} },
        WebSocket: { Server: function Server() {} },
        appDir: '/tmp/root-operator',
        isDev: true,
        getStore: () => ({ get: () => null, set: () => {} }),
        getMainWindow: () => null,
        syncStateWithRenderer: () => {
            calls.sync += 1;
        },
        getOperatingMode: () => 'channel',
        initChannelMode: () => {},
        teardownChannelMode: () => {
            calls.teardownChannelMode += 1;
        },
        handleConnection: () => {},
        getCurrentTunnelUrl: () => state.currentTunnelUrl,
        setCurrentTunnelUrl: (value) => {
            state.currentTunnelUrl = value;
        },
        getIsConnecting: () => state.isConnecting,
        setIsConnecting: (value) => {
            state.isConnecting = value;
        },
        getServer: () => state.server,
        setServer: (value) => {
            state.server = value;
        },
        getWebSocketServer: () => state.wss,
        setWebSocketServer: (value) => {
            state.wss = value;
        },
        getTunnelProcess: () => state.tunnelProcess,
        setTunnelProcess: (value) => {
            state.tunnelProcess = value;
        },
        getWakeLock: () => state.wakeLock,
        setWakeLock: (value) => {
            state.wakeLock = value;
        },
        getPtyProcess: () => state.ptyProcess,
        setPtyProcess: (value) => {
            state.ptyProcess = value;
        },
        setOutputBuffer: (value) => {
            calls.setOutputBuffer.push(value);
        },
        clearActiveClients: () => {
            calls.clearActiveClients += 1;
        },
        clearPendingPairings: () => {
            calls.clearPendingPairings += 1;
        },
        setCurrentFingerprint: (value) => {
            state.fingerprint = value;
        },
        setCurrentSessionStartedAt: (value) => {
            state.sessionStartedAt = value;
        },
        logDebug: (message) => {
            calls.logDebug.push(String(message));
        },
    });

    return { subject, state, calls };
}

test('stopBridge tears down active runtime state and resets bridge state', () => {
    const { subject, state, calls } = createSubject();

    const tunnelProcess = state.tunnelProcess;
    const wakeLock = state.wakeLock;
    const server = state.server;
    const ptyProcess = state.ptyProcess;

    subject.stopBridge();

    assert.equal(tunnelProcess.removed, 1);
    assert.equal(tunnelProcess.stopped, 1);
    assert.equal(wakeLock.killed, 1);
    assert.equal(server.closeCalled, 1);
    assert.equal(ptyProcess.killed, 1);
    assert.equal(calls.teardownChannelMode, 1);
    assert.equal(calls.clearActiveClients, 1);
    assert.equal(calls.clearPendingPairings, 1);
    assert.deepEqual(calls.setOutputBuffer, ['']);
    assert.equal(state.tunnelProcess, null);
    assert.equal(state.wakeLock, null);
    assert.equal(state.server, null);
    assert.equal(state.wss, null);
    assert.equal(state.ptyProcess, null);
    assert.equal(state.currentTunnelUrl, null);
    assert.equal(state.fingerprint, null);
    assert.equal(state.sessionStartedAt, null);
    assert.equal(state.isConnecting, false);
    assert.equal(calls.sync, 1);
    assert.match(calls.logDebug.join('\n'), /Bridge stopped/);
});
