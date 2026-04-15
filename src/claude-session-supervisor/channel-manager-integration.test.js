/**
 * Integration test: supervisor + real ChannelManager.
 *
 * Verifies that when the bridge socket is down, the supervisor uses
 * sendToChannelUnbuffered(), which does NOT populate
 * ChannelManager.pendingMessages. This closes the "supervisor marked
 * dispatch failed, but ChannelManager buffered the payload and flushed
 * it on reconnect" race end-to-end, against the real ChannelManager
 * (not a stub).
 *
 * Runner: node --test --test-force-exit src/claude-session-supervisor/channel-manager-integration.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ChannelManager } = require('../channel-manager');
const { DispatchStore } = require('./dispatch-store');
const { Runtime } = require('./runtime');
const { IncidentLogger } = require('./incidents');
const { createSupervisor } = require('./orchestrator');
const { DISPATCH_STATES } = require('./policy');

function fixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-cm-it-'));
    const dbPath = path.join(dir, 'claude-supervisor.db');
    const runtimeDir = path.join(dir, 'runtime');
    const jsonlPath = path.join(runtimeDir, 'supervisor-incidents.jsonl');
    // Use a path that definitely does NOT have a listening socket so the
    // manager stays disconnected for the entire test.
    const socketPath = path.join(dir, 'nonexistent-bridge.sock');

    const store = new DispatchStore(dbPath);
    const runtime = new Runtime({ store, runtimeDir, socketPath });
    const { hookLog } = runtime.ensureEpochFiles(0);
    const incidents = new IncidentLogger({ store, jsonlPath });

    // Real ChannelManager. Do NOT call connect() — we want it disconnected.
    const channelManager = new ChannelManager(socketPath);

    const supervisor = createSupervisor({
        store, runtime, incidents, channelManager,
        hookLogPath: hookLog,
    });

    return { dir, store, runtime, channelManager, supervisor, hookLog };
}

test('supervisor + real ChannelManager: disconnected send does NOT populate pendingMessages', async () => {
    const { store, channelManager, supervisor } = fixture();

    // Sanity: real ChannelManager starts disconnected
    assert.equal(channelManager.connected, false);
    assert.equal(channelManager.pendingMessages.length, 0);

    await supervisor.start();

    const { dispatchId } = supervisor.enqueue({
        source: 'scheduler', payload: 'sensitive payload',
    });
    const outcome = await supervisor.awaitOutcome(dispatchId);

    // Dispatch must fail with bridge_unavailable
    assert.equal(outcome.state, DISPATCH_STATES.FAILED);
    assert.equal(outcome.error, 'bridge_unavailable');
    const row = store.getDispatch(dispatchId);
    assert.equal(row.state, DISPATCH_STATES.FAILED);

    // CRITICAL: the real ChannelManager's internal buffer must still be
    // empty. If supervisor had used the legacy sendToChannel(), the payload
    // would now be sitting in pendingMessages ready to flush on reconnect.
    assert.equal(channelManager.pendingMessages.length, 0,
        `real ChannelManager.pendingMessages leaked: ${JSON.stringify(channelManager.pendingMessages)}`);

    await supervisor.shutdown();
    channelManager.disconnect();
    store.close();
});

test('supervisor + real ChannelManager: multiple disconnected dispatches all fail, buffer stays empty', async () => {
    const { store, channelManager, supervisor } = fixture();

    await supervisor.start();

    const ids = [];
    for (let i = 0; i < 3; i++) {
        const { dispatchId } = supervisor.enqueue({
            source: 'scheduler', payload: `payload ${i}`,
        });
        ids.push(dispatchId);
    }

    const outcomes = await Promise.all(ids.map(id => supervisor.awaitOutcome(id)));
    for (const o of outcomes) {
        assert.equal(o.state, DISPATCH_STATES.FAILED);
        assert.equal(o.error, 'bridge_unavailable');
    }

    // Buffer remains empty — no risk of post-reconnect flush
    assert.equal(channelManager.pendingMessages.length, 0);

    await supervisor.shutdown();
    channelManager.disconnect();
    store.close();
});

test('ChannelManager.sendToChannelUnbuffered exists and returns false when disconnected without buffering', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-cm-method-'));
    const cm = new ChannelManager(path.join(dir, 'never.sock'));
    assert.equal(typeof cm.sendToChannelUnbuffered, 'function');
    const result = cm.sendToChannelUnbuffered('chat1', 'hi', 'user1');
    assert.equal(result, false);
    assert.equal(cm.pendingMessages.length, 0);
    cm.disconnect();
});
