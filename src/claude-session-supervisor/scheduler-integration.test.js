/**
 * Integration test: scheduler + supervisor + mocked channelManager.
 * Exercises the real scheduler -> supervisor -> hook-log path end-to-end
 * without requiring an actual Claude subprocess.
 *
 * Runner: node --test --test-force-exit src/claude-session-supervisor/scheduler-integration.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DispatchStore } = require('./dispatch-store');
const { Runtime } = require('./runtime');
const { IncidentLogger } = require('./incidents');
const { createSupervisor } = require('./orchestrator');
const { Scheduler, jobSilenceFor } = require('../scheduler');

/**
 * Minimal electron-store-compatible fake for the scheduler tests.
 */
class InMemStore {
    constructor() { this._map = new Map(); }
    get(key, fallback) {
        return this._map.has(key) ? this._map.get(key) : fallback;
    }
    set(key, value) { this._map.set(key, value); }
}

function buildFixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-scheduler-it-'));
    const dbPath = path.join(dir, 'claude-supervisor.db');
    const runtimeDir = path.join(dir, 'runtime');
    const socketPath = path.join(dir, 'fake.sock');
    const jsonlPath = path.join(runtimeDir, 'supervisor-incidents.jsonl');

    const store = new DispatchStore(dbPath);
    const runtime = new Runtime({ store, runtimeDir, socketPath });
    runtime.incrementEpoch();
    const { hookLog } = runtime.ensureEpochFiles(runtime.currentEpoch);
    const incidents = new IncidentLogger({ store, jsonlPath });

    const sent = [];
    const channelManager = {
        sendToChannel(chatId, content, userId) {
            sent.push({ chatId, content, userId });
        },
    };

    const supervisor = createSupervisor({
        store, runtime, incidents, channelManager,
        hookLogPath: hookLog,
    });

    const jobStore = new InMemStore();
    const scheduler = new Scheduler(jobStore, channelManager, supervisor);

    return { dir, store, runtime, incidents, supervisor, scheduler, channelManager, sent, hookLog, jobStore };
}

function appendHook(hookLog, obj) {
    fs.appendFileSync(hookLog, JSON.stringify(obj) + '\n');
}

async function waitForCondition(pred, { timeoutMs = 2000, intervalMs = 20 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (pred()) return true;
        await new Promise(r => setTimeout(r, intervalMs));
    }
    return false;
}

test('jobSilenceFor picks Night Lab budget', () => {
    assert.equal(jobSilenceFor({ name: 'Night Lab Nightly Build' }), 30 * 60_000);
    assert.equal(jobSilenceFor({ name: 'Signal Nightly Scan' }), 10 * 60_000);
    assert.equal(jobSilenceFor({ name: 'Sleep Cycle' }), 5 * 60_000);
    assert.equal(jobSilenceFor({ name: 'Unknown Job' }), 5 * 60_000);
    assert.equal(jobSilenceFor({ name: 'Any', silenceMs: 123 }), 123);
});

test('scheduler._fireJob completes with success only after Stop hook', async () => {
    const { supervisor, scheduler, sent, hookLog, jobStore } = buildFixture();
    await supervisor.start();

    const job = {
        id: 'j1', name: 'Test Job', cron: '* * * * *', prompt: 'do the thing',
        enabled: true, consecutiveErrors: 0,
    };
    jobStore.set('scheduler-jobs', [job]);

    // Fire
    const firePromise = scheduler._fireJob(job);

    // Wait for supervisor to have sent via channelManager
    await waitForCondition(() => sent.length === 1);
    assert.equal(sent[0].content.includes('do the thing'), true);

    // Job should be marked running; lastRun not yet set
    let persisted = jobStore.get('scheduler-jobs', [])[0];
    assert.ok(persisted.runningAt, 'runningAt should be set while awaiting supervisor');
    assert.equal(persisted.lastRun, undefined);

    // Now emit Stop hook
    appendHook(hookLog, { hookEventName: 'Stop', ts: Date.now() });

    await firePromise;

    persisted = jobStore.get('scheduler-jobs', [])[0];
    assert.equal(persisted.lastResult, 'success');
    assert.equal(persisted.lastError, null);
    assert.equal(persisted.runningAt, null);
    assert.ok(persisted.lastDurationMs >= 0);

    await supervisor.shutdown();
});

test('scheduler._fireJob reports error on StopFailure', async () => {
    const { supervisor, scheduler, hookLog, jobStore } = buildFixture();
    await supervisor.start();

    const job = {
        id: 'j1', name: 'Failing Job', cron: '* * * * *', prompt: 'boom',
        enabled: true, consecutiveErrors: 0,
    };
    jobStore.set('scheduler-jobs', [job]);

    const firePromise = scheduler._fireJob(job);
    await waitForCondition(() => supervisor.activeDispatch !== null);

    appendHook(hookLog, { hookEventName: 'StopFailure', error: 'stream_stall' });
    await firePromise;

    const persisted = jobStore.get('scheduler-jobs', [])[0];
    assert.equal(persisted.lastResult, 'error');
    assert.match(persisted.lastError, /failed|stream_stall/);
    assert.equal(persisted.consecutiveErrors, 1);

    await supervisor.shutdown();
});

test('scheduler._fireJob reports error on safety-net abandon', async () => {
    const { supervisor, scheduler, jobStore } = buildFixture();
    await supervisor.start();

    // Tiny silence budget to trigger the safety-net timeout quickly
    const job = {
        id: 'j1', name: 'Stalling Job', cron: '* * * * *', prompt: 'x',
        enabled: true, consecutiveErrors: 0,
        silenceMs: 3, // 3ms * 10 = 30ms safety-net
    };
    jobStore.set('scheduler-jobs', [job]);

    await scheduler._fireJob(job);

    const persisted = jobStore.get('scheduler-jobs', [])[0];
    assert.equal(persisted.lastResult, 'error');
    assert.match(persisted.lastError, /abandoned|safety_timeout/);
    assert.equal(persisted.consecutiveErrors, 1);

    await supervisor.shutdown();
});

test('scheduler falls back to legacy path when no supervisor provided', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-scheduler-legacy-'));
    const jobStore = new InMemStore();
    const sent = [];
    const channelManager = {
        sendToChannel(chatId, content, userId) {
            sent.push({ chatId, content, userId });
            return true;
        },
    };
    const scheduler = new Scheduler(jobStore, channelManager); // no supervisor

    const job = {
        id: 'j1', name: 'Legacy', cron: '* * * * *', prompt: 'hi',
        enabled: true, consecutiveErrors: 0,
    };
    jobStore.set('scheduler-jobs', [job]);

    await scheduler._fireJob(job);

    assert.equal(sent.length, 1);
    const persisted = jobStore.get('scheduler-jobs', [])[0];
    assert.equal(persisted.lastResult, 'success');
    // Legacy path stamps success on boolean true — this is the old behavior
    // that PR1 PRESERVES when supervisor is absent. PR2 will remove this branch.
});
