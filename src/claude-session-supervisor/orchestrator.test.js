/**
 * Integration-ish tests for orchestrator.js.
 * Runner: node --test src/claude-session-supervisor/orchestrator.test.js
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
const { STATES, DISPATCH_STATES } = require('./policy');

function fixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-orch-test-'));
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

    return { dir, store, runtime, incidents, supervisor, channelManager, sent, hookLog };
}

function appendHook(hookLog, obj) {
    fs.appendFileSync(hookLog, JSON.stringify(obj) + '\n');
}

async function waitForCondition(pred, { timeoutMs = 1000, intervalMs = 20 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (pred()) return true;
        await new Promise(r => setTimeout(r, intervalMs));
    }
    return false;
}

test('start transitions to IDLE', async () => {
    const { supervisor, store } = fixture();
    await supervisor.start();
    assert.equal(supervisor.state, STATES.IDLE);
    await supervisor.shutdown();
    store.close();
});

test('enqueue returns dispatchId and inserts row', async () => {
    const { supervisor, store } = fixture();
    await supervisor.start();
    const { dispatchId } = supervisor.enqueue({
        source: 'scheduler',
        sourceId: 'job-test',
        payload: 'hello',
        silenceMs: 60_000,
    });
    assert.ok(dispatchId);
    const row = store.getDispatch(dispatchId);
    assert.ok(row);
    assert.equal(row.source, 'scheduler');
    assert.equal(row.payload, 'hello');
    await supervisor.shutdown();
    store.close();
});

test('enqueue activates dispatch immediately when idle', async () => {
    const { supervisor, store, sent } = fixture();
    await supervisor.start();
    const { dispatchId } = supervisor.enqueue({
        source: 'scheduler', payload: 'go',
    });
    // send happens synchronously inside enqueue->activate
    assert.equal(sent.length, 1);
    assert.equal(sent[0].content, 'go');
    const row = store.getDispatch(dispatchId);
    assert.equal(row.state, DISPATCH_STATES.ACTIVE);
    assert.equal(supervisor.state, STATES.DISPATCHING);
    await supervisor.shutdown();
    store.close();
});

test('Stop hook completes the dispatch and resolves awaitOutcome', async () => {
    const { supervisor, hookLog, store } = fixture();
    await supervisor.start();
    const { dispatchId } = supervisor.enqueue({ source: 'scheduler', payload: 'x' });
    const outcome = supervisor.awaitOutcome(dispatchId);
    appendHook(hookLog, { hookEventName: 'Stop', ts: '2026-04-15T10:00:00Z' });
    const result = await outcome;
    assert.equal(result.state, DISPATCH_STATES.COMPLETED);
    assert.equal(supervisor.state, STATES.IDLE);
    const row = store.getDispatch(dispatchId);
    assert.equal(row.state, DISPATCH_STATES.COMPLETED);
    assert.ok(row.terminal_at != null);
    await supervisor.shutdown();
    store.close();
});

test('StopFailure hook marks failed with error reason', async () => {
    const { supervisor, hookLog, store } = fixture();
    await supervisor.start();
    const { dispatchId } = supervisor.enqueue({ source: 'scheduler', payload: 'x' });
    const outcome = supervisor.awaitOutcome(dispatchId);
    appendHook(hookLog, { hookEventName: 'StopFailure', error: 'something_broke' });
    const result = await outcome;
    assert.equal(result.state, DISPATCH_STATES.FAILED);
    assert.equal(result.error, 'something_broke');
    const row = store.getDispatch(dispatchId);
    assert.equal(row.last_error, 'something_broke');
    await supervisor.shutdown();
    store.close();
});

test('PreToolUse reply no longer increments visible_effect_count (PR3: moved to effect-ledger)', async () => {
    // PR3 moved visible_effect_count increment to the effect-ledger path in
    // main.js handleReplyRequest(). Hook-based counting was removed to
    // prevent double-counting (Codex finding #4).
    const { supervisor, hookLog, store } = fixture();
    await supervisor.start();
    const { dispatchId } = supervisor.enqueue({ source: 'channel', chatId: 'c1', payload: 'hi' });
    const outcome = supervisor.awaitOutcome(dispatchId);
    appendHook(hookLog, { hookEventName: 'PreToolUse', toolName: 'reply' });
    appendHook(hookLog, { hookEventName: 'PreToolUse', toolName: 'reply' });
    await new Promise(r => setTimeout(r, 300));
    // visible_effect_count should remain 0 — hook-based increment removed in PR3.
    assert.equal(store.getDispatch(dispatchId).visible_effect_count, 0);
    appendHook(hookLog, { hookEventName: 'Stop' });
    await outcome;
    await supervisor.shutdown();
    store.close();
});

test('second enqueue while active gets queued and activates after Stop', async () => {
    const { supervisor, hookLog, store, sent } = fixture();
    await supervisor.start();
    const first = supervisor.enqueue({ source: 'scheduler', payload: 'first' });
    const second = supervisor.enqueue({ source: 'scheduler', payload: 'second' });
    // Only first is sent at this point
    assert.equal(sent.length, 1);
    assert.equal(store.getDispatch(first.dispatchId).state, DISPATCH_STATES.ACTIVE);
    assert.equal(store.getDispatch(second.dispatchId).state, DISPATCH_STATES.QUEUED);

    const outcome1 = supervisor.awaitOutcome(first.dispatchId);
    appendHook(hookLog, { hookEventName: 'Stop' });
    await outcome1;

    // Second should auto-activate
    await waitForCondition(() => store.getDispatch(second.dispatchId).state === DISPATCH_STATES.ACTIVE,
        { timeoutMs: 1000 });
    assert.equal(sent.length, 2);
    assert.equal(sent[1].content, 'second');
    await supervisor.shutdown();
    store.close();
});

test('safety-net timeout abandons dispatch if no Stop arrives', async () => {
    const { supervisor, store } = fixture();
    await supervisor.start();
    const { dispatchId } = supervisor.enqueue({
        source: 'scheduler', payload: 'will_hang',
        silenceMs: 2, // 2ms * 10 = 20ms safety net
    });
    const outcome = await supervisor.awaitOutcome(dispatchId);
    assert.equal(outcome.state, DISPATCH_STATES.ABANDONED);
    assert.equal(outcome.error, 'safety_timeout_no_stop');
    const row = store.getDispatch(dispatchId);
    assert.equal(row.last_error, 'safety_timeout_no_stop');
    await supervisor.shutdown();
    store.close();
});

test('awaitOutcome resolves immediately for already-terminal dispatches', async () => {
    const { supervisor, hookLog, store } = fixture();
    await supervisor.start();
    const { dispatchId } = supervisor.enqueue({ source: 'scheduler', payload: 'x' });
    appendHook(hookLog, { hookEventName: 'Stop' });
    // Let the tailer pick up the line
    await waitForCondition(() => store.getDispatch(dispatchId).state === DISPATCH_STATES.COMPLETED,
        { timeoutMs: 1000 });
    const result = await supervisor.awaitOutcome(dispatchId);
    assert.equal(result.state, DISPATCH_STATES.COMPLETED);
    await supervisor.shutdown();
    store.close();
});

test('shutdown rejects pending awaiters', async () => {
    const { supervisor, store } = fixture();
    await supervisor.start();
    const { dispatchId } = supervisor.enqueue({ source: 'scheduler', payload: 'x' });
    const outcome = supervisor.awaitOutcome(dispatchId);
    await supervisor.shutdown();
    await assert.rejects(outcome, /shutdown/);
    store.close();
});

test('enqueue after hardFailed throws', async () => {
    const { supervisor, store } = fixture();
    await supervisor.start();
    supervisor.state = STATES.HARD_FAILED; // force for test
    assert.throws(() => supervisor.enqueue({ source: 'scheduler', payload: 'x' }), /hardFailed/);
    store.close();
});

// --- Codex round 4 follow-ups ---

test('bridge unavailable: sendToChannel returning false marks dispatch failed', async () => {
    const { supervisor, store, hookLog } = fixture();
    // Swap channelManager to a disconnected-style one that returns false
    supervisor.channelManager = {
        sendToChannel() { return false; },
    };
    await supervisor.start();
    const { dispatchId } = supervisor.enqueue({ source: 'scheduler', payload: 'x' });
    const outcome = await supervisor.awaitOutcome(dispatchId);
    assert.equal(outcome.state, DISPATCH_STATES.FAILED);
    assert.equal(outcome.error, 'bridge_unavailable');
    const row = store.getDispatch(dispatchId);
    assert.equal(row.state, DISPATCH_STATES.FAILED);
    assert.equal(row.last_error, 'bridge_unavailable');
    // Late Stop hook for a FAILED dispatch should be ignored (no activeDispatch)
    fs.appendFileSync(hookLog, JSON.stringify({ hookEventName: 'Stop' }) + '\n');
    await new Promise(r => setTimeout(r, 150));
    assert.equal(store.getDispatch(dispatchId).state, DISPATCH_STATES.FAILED);
    await supervisor.shutdown();
    store.close();
});

test('queued dispatch is NOT auto-abandoned while waiting for activation', async () => {
    // Covers the Codex High: safety timer must arm at ACTIVATION, not at
    // awaitOutcome. A dispatch queued behind a long-running active one
    // should keep its queued state without being auto-abandoned.
    const { supervisor, store, hookLog } = fixture();
    await supervisor.start();

    const first = supervisor.enqueue({
        source: 'scheduler', payload: 'first',
        silenceMs: 5, // 5ms * 10 = 50ms safety on ACTIVE
    });
    const second = supervisor.enqueue({
        source: 'scheduler', payload: 'second',
        silenceMs: 5, // same short budget — but should NOT tick while queued
    });

    // Register waiters for both
    const outcome1 = supervisor.awaitOutcome(first.dispatchId);
    const outcome2 = supervisor.awaitOutcome(second.dispatchId);

    // Wait past the safety budget that WOULD have auto-abandoned the queued
    // dispatch under the old (pre-fix) behaviour. Under the fix, only the
    // ACTIVE dispatch's timer runs, so first will auto-abandon but second's
    // safety counter hasn't started yet.
    await new Promise(r => setTimeout(r, 100));

    // Key assertion: second has NOT been auto-abandoned. It either promoted
    // to ACTIVE (after first was auto-abandoned and _activateNext ran) or
    // stayed QUEUED. It must never be ABANDONED while it was queued.
    const secondState = store.getDispatch(second.dispatchId).state;
    assert.notEqual(secondState, DISPATCH_STATES.ABANDONED,
        `second was zombie-abandoned while queued (state=${secondState})`);
    assert.ok([DISPATCH_STATES.QUEUED, DISPATCH_STATES.ACTIVE, DISPATCH_STATES.FAILED].includes(secondState),
        `unexpected second state: ${secondState}`);

    // Drain: first has auto-abandoned by now.
    const firstResult = await outcome1;
    assert.equal(firstResult.state, DISPATCH_STATES.ABANDONED);

    // Second should activate (if not already) and then eventually safety-net
    // abandon itself because we never send a Stop hook. Either way, its
    // resolver settles.
    const secondResult = await outcome2;
    assert.ok(
        [DISPATCH_STATES.ABANDONED, DISPATCH_STATES.COMPLETED].includes(secondResult.state),
        `second unexpected terminal: ${secondResult.state}`
    );

    await supervisor.shutdown();
    store.close();
});

test('multiple awaitOutcome callers on same dispatch all settle', async () => {
    const { supervisor, store, hookLog } = fixture();
    await supervisor.start();
    const { dispatchId } = supervisor.enqueue({ source: 'scheduler', payload: 'x' });
    const a = supervisor.awaitOutcome(dispatchId);
    const b = supervisor.awaitOutcome(dispatchId);
    const c = supervisor.awaitOutcome(dispatchId);
    fs.appendFileSync(hookLog, JSON.stringify({ hookEventName: 'Stop' }) + '\n');
    const results = await Promise.all([a, b, c]);
    for (const r of results) {
        assert.equal(r.state, DISPATCH_STATES.COMPLETED);
    }
    // Late awaiter on already-terminal dispatch resolves immediately.
    const d = await supervisor.awaitOutcome(dispatchId);
    assert.equal(d.state, DISPATCH_STATES.COMPLETED);
    await supervisor.shutdown();
    store.close();
});

test('disconnected ChannelManager: supervisor uses unbuffered send, nothing enters buffer', async () => {
    // Real-shaped ChannelManager stand-in with the current interface:
    // connected flag + buffered sendToChannel (legacy) + unbuffered variant
    // (PR1 addition). Verifies the supervisor routes through the unbuffered
    // variant so no payload ever reaches the internal buffer.
    const { supervisor, store } = fixture();
    const bufferedPayloads = [];
    const unbufferedAttempts = [];
    supervisor.channelManager = {
        connected: false,
        sendToChannel(chatId, content, userId) {
            // legacy buffered path — if this is ever called, the test fails
            bufferedPayloads.push({ chatId, content, userId });
            return false;
        },
        sendToChannelUnbuffered(chatId, content, userId) {
            unbufferedAttempts.push({ chatId, content, userId });
            return false; // disconnected → no buffer, just false
        },
    };
    await supervisor.start();
    const { dispatchId } = supervisor.enqueue({ source: 'scheduler', payload: 'sensitive' });
    const outcome = await supervisor.awaitOutcome(dispatchId);
    assert.equal(outcome.state, DISPATCH_STATES.FAILED);
    assert.equal(outcome.error, 'bridge_unavailable');
    // Supervisor must use unbuffered, never the buffered legacy method.
    assert.equal(bufferedPayloads.length, 0,
        `supervisor called buffered sendToChannel: ${JSON.stringify(bufferedPayloads)}`);
    assert.equal(unbufferedAttempts.length, 1);
    const row = store.getDispatch(dispatchId);
    assert.equal(row.state, DISPATCH_STATES.FAILED);
    await supervisor.shutdown();
    store.close();
});

test('queue does not stall when pre-activation dispatch fails', async () => {
    // Regression for the Codex round-5 finding: when a dispatch fails
    // before becoming active (bridge_unavailable), _completeDispatch must
    // still call _activateNext() so later queued dispatches can proceed
    // once the bridge recovers.
    const { supervisor, store, hookLog } = fixture();
    let connected = false;
    const cm = {
        get connected() { return connected; },
        sendToChannel(chatId, content, userId) {
            if (!connected) return false;
            return true; // would normally also call supervisor-side handlers
        },
    };
    supervisor.channelManager = cm;
    await supervisor.start();

    const first = supervisor.enqueue({ source: 'scheduler', payload: 'one' });
    const second = supervisor.enqueue({ source: 'scheduler', payload: 'two' });

    const outcome1 = supervisor.awaitOutcome(first.dispatchId);
    const outcome2 = supervisor.awaitOutcome(second.dispatchId);

    // Both should fail with bridge_unavailable (connected === false)
    const r1 = await outcome1;
    assert.equal(r1.state, DISPATCH_STATES.FAILED);
    assert.equal(r1.error, 'bridge_unavailable');

    const r2 = await outcome2;
    assert.equal(r2.state, DISPATCH_STATES.FAILED,
        `queue stalled after pre-activation failure (second state=${r2.state})`);
    assert.equal(r2.error, 'bridge_unavailable');

    // Now "reconnect" and fire a fresh dispatch — it should activate normally.
    connected = true;
    const third = supervisor.enqueue({ source: 'scheduler', payload: 'three' });
    await waitForCondition(() => store.getDispatch(third.dispatchId).state === DISPATCH_STATES.ACTIVE);
    fs.appendFileSync(hookLog, JSON.stringify({ hookEventName: 'Stop' }) + '\n');
    const r3 = await supervisor.awaitOutcome(third.dispatchId);
    assert.equal(r3.state, DISPATCH_STATES.COMPLETED);

    await supervisor.shutdown();
    store.close();
});

test('abandon removes queued id from in-memory queue (defensive)', async () => {
    // Even with the timer fix, an external caller could in principle call
    // _abandonDispatch() on a queued (not-yet-active) id. Verify that does
    // not leave a zombie ready for _activateNext() to promote.
    const { supervisor, store, hookLog } = fixture();
    await supervisor.start();

    const first = supervisor.enqueue({ source: 'scheduler', payload: 'first' });
    const second = supervisor.enqueue({ source: 'scheduler', payload: 'second' });
    const outcome1 = supervisor.awaitOutcome(first.dispatchId);
    const outcome2 = supervisor.awaitOutcome(second.dispatchId);

    // Forcibly abandon the queued one before it ever runs.
    supervisor._abandonDispatch(second.dispatchId, 'force_cancel');

    // Verify second is terminal and no longer in queue.
    assert.equal(store.getDispatch(second.dispatchId).state, DISPATCH_STATES.ABANDONED);
    assert.equal(supervisor.queue.includes(second.dispatchId), false);
    assert.equal((await outcome2).state, DISPATCH_STATES.ABANDONED);

    // Let first finish. _activateNext should NOT promote the abandoned second.
    fs.appendFileSync(hookLog, JSON.stringify({ hookEventName: 'Stop' }) + '\n');
    await outcome1;

    // No active dispatch now, and second stays ABANDONED (not re-sent).
    await new Promise(r => setTimeout(r, 50));
    assert.equal(supervisor.activeDispatch, null);
    assert.equal(store.getDispatch(second.dispatchId).state, DISPATCH_STATES.ABANDONED);

    await supervisor.shutdown();
    store.close();
});

// --- PR2: self-heal tests ---

const EventEmitter = require('events');

function fixturePR2() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-orch-pr2-'));
    const dbPath = path.join(dir, 'claude-supervisor.db');
    const runtimeDir = path.join(dir, 'runtime');
    const socketPath = path.join(dir, 'fake.sock');
    const jsonlPath = path.join(runtimeDir, 'supervisor-incidents.jsonl');
    const store = new DispatchStore(dbPath);

    const killCalls = [];
    let claudePidProbe = 1234; // pretend Claude is alive by default
    const runtime = new Runtime({
        store, runtimeDir, socketPath,
        onKillRequest: () => { killCalls.push(Date.now()); claudePidProbe = null; },
        getClaudePid: () => claudePidProbe,
    });
    runtime.incrementEpoch();
    const { hookLog } = runtime.ensureEpochFiles(runtime.currentEpoch);
    const incidents = new IncidentLogger({ store, jsonlPath });

    // EventEmitter-flavoured channelManager so the supervisor can subscribe
    // to bridge_ready. Also tracks unbuffered sends (system notices go here).
    const channelManager = new EventEmitter();
    const sent = [];
    const notices = [];
    channelManager.sendToChannel = function(chatId, content, userId) { sent.push({ chatId, content, userId }); return true; };
    channelManager.sendToChannelUnbuffered = function(chatId, content, userId) { notices.push({ chatId, content, userId }); return true; };
    channelManager.simulateRespawn = () => channelManager.emit('bridge_ready', { pid: 9999, ts: new Date().toISOString() });
    channelManager.simulateClaudeResurrected = () => { claudePidProbe = 5678; };

    const supervisor = createSupervisor({
        store, runtime, incidents, channelManager,
        hookLogPath: hookLog,
    });
    return { dir, store, runtime, incidents, supervisor, channelManager, sent, notices, hookLog, killCalls };
}

test('PR2: wedge detection triggers kill + dispatch_awaiting_replay', async () => {
    const { supervisor, store, killCalls } = fixturePR2();
    await supervisor.start();
    const { dispatchId } = supervisor.enqueue({
        source: 'scheduler', payload: 'will_hang',
        silenceMs: 30, // short wedge trigger
    });
    assert.equal(supervisor.activeDispatch.dispatchId, dispatchId);
    await waitForCondition(() => killCalls.length > 0, { timeoutMs: 500 });
    assert.equal(killCalls.length, 1, 'runtime.requestKill should fire exactly once on wedge');
    assert.equal(supervisor.state, STATES.RESPAWNING, 'should be in RESPAWNING after kill_ordered');
    assert.equal(supervisor.activeDispatch.inRecovery, true, 'activeDispatch must be flagged inRecovery');
    assert.ok(supervisor._dispatchAwaitingReplay, 'a replay should be pending');
    assert.equal(supervisor._dispatchAwaitingReplay.dispatchId, dispatchId);
    await supervisor.shutdown();
    store.close();
});

test('PR2: bridge_ready after wedge replays the SAME dispatchId', async () => {
    const { supervisor, store, channelManager, killCalls, hookLog } = fixturePR2();
    await supervisor.start();
    // Use silenceMs large enough (800ms) that the wedge timer won't fire on
    // the replay before we can post the Stop hook. But small enough for test
    // speed. The ORIGINAL silenceMs trigger is driven by clock, so we advance
    // via setTimeout: first enqueue with a sentinel payload, wait for kill,
    // then respawn, then post Stop before the new wedge fires.
    const { dispatchId } = supervisor.enqueue({
        source: 'scheduler', payload: 'replay_me', silenceMs: 250,
    });
    const outcomePromise = supervisor.awaitOutcome(dispatchId);
    await waitForCondition(() => killCalls.length > 0, { timeoutMs: 1500 });
    channelManager.simulateClaudeResurrected();
    channelManager.simulateRespawn();
    await waitForCondition(() => store.getDispatch(dispatchId).replay_count === 1, { timeoutMs: 500 });
    const row = store.getDispatch(dispatchId);
    assert.equal(row.replay_count, 1, 'replay_count bumped');
    assert.ok(row.state === DISPATCH_STATES.ACTIVE || row.state === DISPATCH_STATES.SENDING,
        'dispatch re-entered lifecycle');
    assert.equal(supervisor.activeDispatch && supervisor.activeDispatch.dispatchId, dispatchId,
        'same dispatchId is active after replay');
    // Close the replay cleanly so the test tears down without dangling timers.
    appendHook(hookLog, { hookEventName: 'Stop' });
    const final = await outcomePromise;
    assert.equal(final.state, DISPATCH_STATES.COMPLETED);
    await supervisor.shutdown();
    store.close();
});

test('PR2: late Stop hook during inRecovery does NOT complete the dispatch', async () => {
    const { supervisor, store, hookLog, killCalls } = fixturePR2();
    await supervisor.start();
    const { dispatchId } = supervisor.enqueue({
        source: 'scheduler', payload: 'wedge_then_late_stop', silenceMs: 30,
    });
    await waitForCondition(() => killCalls.length > 0, { timeoutMs: 500 });
    // Late Stop hook from the dying old Claude
    appendHook(hookLog, { hookEventName: 'Stop' });
    await new Promise(r => setTimeout(r, 150));
    const row = store.getDispatch(dispatchId);
    assert.notEqual(row.state, DISPATCH_STATES.COMPLETED, 'late Stop must not complete recovery dispatch');
    await supervisor.shutdown();
    store.close();
});

test('PR2: notifyClaudeExited during active → respawning + awaiting replay', async () => {
    const { supervisor, store } = fixturePR2();
    await supervisor.start();
    const { dispatchId } = supervisor.enqueue({ source: 'scheduler', payload: 'x', silenceMs: 60_000 });
    supervisor.notifyClaudeExited(137); // simulate SIGKILL exit
    assert.equal(supervisor.state, STATES.RESPAWNING);
    assert.equal(supervisor.activeDispatch.inRecovery, true);
    assert.equal(supervisor._dispatchAwaitingReplay.dispatchId, dispatchId);
    await supervisor.shutdown();
    store.close();
});

test('shutdown with active dispatch marks it abandoned', async () => {
    const { supervisor, store } = fixturePR2();
    await supervisor.start();
    const { dispatchId } = supervisor.enqueue({ source: 'scheduler', payload: 'long-job', silenceMs: 300_000 });
    assert.equal(supervisor.state, STATES.DISPATCHING);
    await supervisor.shutdown();
    const row = store.getDispatch(dispatchId);
    assert.equal(row.state, DISPATCH_STATES.ABANDONED, 'in-flight dispatch must be abandoned on shutdown');
    assert.match(row.last_error || '', /shutdown_while_active/);
    store.close();
});

test('PR2: notifyClaudeExited with no active dispatch is a no-op', async () => {
    const { supervisor, store } = fixturePR2();
    await supervisor.start();
    // no enqueue → no activeDispatch
    supervisor.notifyClaudeExited(0);
    assert.equal(supervisor.state, STATES.IDLE, 'state unchanged when no active dispatch');
    await supervisor.shutdown();
    store.close();
});

test('PR2: replay cap exceeded → failed + system notice on chat_id', async () => {
    const { supervisor, store, channelManager, notices, killCalls } = fixturePR2();
    await supervisor.start();
    const { dispatchId } = supervisor.enqueue({
        source: 'scheduler', chatId: 'dev-123', payload: 'hopeless', silenceMs: 30,
    });
    // Force replay_count to cap so canReplayDispatch returns false
    store.incrementReplayCount(dispatchId);
    store.incrementReplayCount(dispatchId); // now 2 == replay_cap for scheduler
    await waitForCondition(() => killCalls.length > 0, { timeoutMs: 500 });
    channelManager.simulateClaudeResurrected();
    channelManager.simulateRespawn();
    await waitForCondition(() => store.getDispatch(dispatchId).state === DISPATCH_STATES.FAILED,
        { timeoutMs: 500 });
    const row = store.getDispatch(dispatchId);
    assert.equal(row.state, DISPATCH_STATES.FAILED);
    assert.match(row.last_error || '', /replay_not_allowed:replay_cap_exceeded/);
    // Initial dispatch payload also flows through sendToChannelUnbuffered,
    // so filter to just the system-notice-class messages.
    const systemNotices = notices.filter(n => /^\[system notice\]/.test(n.content));
    assert.equal(systemNotices.length, 1, 'one system notice must be emitted');
    assert.equal(systemNotices[0].chatId, 'dev-123');
    await supervisor.shutdown();
    store.close();
});

test('PR2: intensity-exhausted → hard_failed, dispatch failed, notice', async () => {
    const { supervisor, store, channelManager, notices, killCalls } = fixturePR2();
    await supervisor.start();
    // Pre-load the ring buffer with 3 recent timestamps (burst exhaustion).
    const now = Date.now();
    store.setStateValue('respawn_intensity_ring', JSON.stringify([now - 10_000, now - 8_000, now - 5_000]));
    const { dispatchId } = supervisor.enqueue({
        source: 'scheduler', chatId: 'dev-xyz', payload: 'nope', silenceMs: 30,
    });
    await waitForCondition(() => killCalls.length > 0, { timeoutMs: 500 });
    channelManager.simulateClaudeResurrected();
    channelManager.simulateRespawn();
    await waitForCondition(() => supervisor.state === STATES.HARD_FAILED, { timeoutMs: 500 });
    assert.equal(supervisor.state, STATES.HARD_FAILED);
    const row = store.getDispatch(dispatchId);
    assert.equal(row.state, DISPATCH_STATES.FAILED);
    assert.match(row.last_error || '', /intensity_exhausted/);
    const systemNotices = notices.filter(n => /^\[system notice\]/.test(n.content));
    assert.equal(systemNotices.length, 1, 'one system notice for intensity exhaustion');
    await supervisor.shutdown();
    store.close();
});

test('PR2: system notice with no chat_id is log-only (no channel call)', async () => {
    const { supervisor, store, notices, killCalls, channelManager } = fixturePR2();
    await supervisor.start();
    const { dispatchId } = supervisor.enqueue({
        source: 'scheduler', chatId: null, payload: 'silent_fail', silenceMs: 30,
    });
    // Force an immediate hard fail path by exhausting intensity + ensuring cap
    const now = Date.now();
    store.setStateValue('respawn_intensity_ring', JSON.stringify([now - 5_000, now - 3_000, now - 1_000]));
    await waitForCondition(() => killCalls.length > 0, { timeoutMs: 500 });
    channelManager.simulateClaudeResurrected();
    channelManager.simulateRespawn();
    await waitForCondition(() => store.getDispatch(dispatchId).state === DISPATCH_STATES.FAILED,
        { timeoutMs: 500 });
    const systemNotices = notices.filter(n => /^\[system notice\]/.test(n.content));
    assert.equal(systemNotices.length, 0, 'no chat_id → notice is log-only, no channel call');
    await supervisor.shutdown();
    store.close();
});

test('PR2: bridge_ready with no pending replay is a no-op walk through STARTING/VERIFYING', async () => {
    const { supervisor, store, channelManager } = fixturePR2();
    await supervisor.start();
    // Supervisor is in IDLE after start() — bridge_ready at rest should not disturb.
    channelManager.simulateRespawn();
    await new Promise(r => setTimeout(r, 50));
    assert.equal(supervisor.state, STATES.IDLE, 'supervisor stays IDLE');
    await supervisor.shutdown();
    store.close();
});

// Codex round-2 regression tests

test('PR2: notifyClaudeExited keeps safety-net so dispatch does not hang if bridge_ready never arrives', async () => {
    const { supervisor, store } = fixturePR2();
    await supervisor.start();
    const { dispatchId } = supervisor.enqueue({
        source: 'scheduler', payload: 'crash_then_no_bridge',
        silenceMs: 30, // → safety 300ms
    });
    const outcomePromise = supervisor.awaitOutcome(dispatchId);
    // Simulate a crash during active dispatch. No bridge_ready will follow.
    supervisor.notifyClaudeExited(137);
    // Safety-net must still fire. Without the fix, this await hangs forever.
    const outcome = await outcomePromise;
    assert.equal(outcome.state, DISPATCH_STATES.ABANDONED);
    assert.equal(outcome.error, 'safety_timeout_no_stop');
    await supervisor.shutdown();
    store.close();
});

test('PR2: HARD_FAILED blocks queued dispatches from auto-activating', async () => {
    const { supervisor, store, channelManager, killCalls } = fixturePR2();
    await supervisor.start();
    // Pre-exhaust the intensity ring so the first wedge → hard_failed.
    const now = Date.now();
    store.setStateValue('respawn_intensity_ring', JSON.stringify([now - 10_000, now - 8_000, now - 5_000]));

    const { dispatchId: first } = supervisor.enqueue({
        source: 'scheduler', chatId: 'dev-hf', payload: 'first', silenceMs: 30,
    });
    // Queue a second job while the first is dispatching — it should NOT run after hard-fail.
    const { dispatchId: second } = supervisor.enqueue({
        source: 'scheduler', chatId: 'dev-hf', payload: 'second', silenceMs: 30,
    });

    await waitForCondition(() => killCalls.length > 0, { timeoutMs: 500 });
    channelManager.simulateClaudeResurrected();
    channelManager.simulateRespawn();

    await waitForCondition(() => supervisor.state === STATES.HARD_FAILED, { timeoutMs: 500 });
    assert.equal(supervisor.state, STATES.HARD_FAILED);
    assert.equal(store.getDispatch(first).state, DISPATCH_STATES.FAILED);
    // Second job must still be queued (not promoted) — HARD_FAILED is terminal
    // for the supervisor and all pending work halts until manual_reset.
    assert.equal(store.getDispatch(second).state, DISPATCH_STATES.QUEUED);
    assert.equal(supervisor.activeDispatch, null, 'no new activeDispatch after hard-fail');
    await supervisor.shutdown();
    store.close();
});

test('PR2: wedge timer is cleared on normal Stop completion (no leak)', async () => {
    const { supervisor, store, hookLog } = fixturePR2();
    await supervisor.start();
    const { dispatchId } = supervisor.enqueue({
        source: 'scheduler', payload: 'normal_complete', silenceMs: 60_000,
    });
    await waitForCondition(() => supervisor.activeDispatch && supervisor.activeDispatch.dispatchId === dispatchId);
    appendHook(hookLog, { hookEventName: 'Stop' });
    await waitForCondition(() => store.getDispatch(dispatchId).state === DISPATCH_STATES.COMPLETED);
    assert.equal(supervisor.activeDispatch, null);
    // If wedgeTimer had leaked, shutdown's _clearActiveWedgeTimer would no-op
    // because activeDispatch is null. The remaining timer would keep the event
    // loop alive past shutdown. We exit the test normally because of
    // --test-force-exit, but the leak is visible as asynchronous-activity
    // warnings in the full test output. This assertion is belt-and-braces.
    await supervisor.shutdown();
    store.close();
});

test('PR2: system_notice_failed incident when bridge send returns false', async () => {
    const { supervisor, store, channelManager, killCalls } = fixturePR2();
    await supervisor.start();
    // Let the initial dispatch send succeed, but the system-notice send
    // (triggered on cap-exceeded replay attempt) returns false. Distinguish
    // by content prefix — system notices start with "[system notice]".
    channelManager.sendToChannelUnbuffered = function(chatId, content) {
        if (content && content.startsWith('[system notice]')) return false;
        return true;
    };

    const { dispatchId } = supervisor.enqueue({
        source: 'scheduler', chatId: 'dev-x', payload: 'p', silenceMs: 30,
    });
    store.incrementReplayCount(dispatchId);
    store.incrementReplayCount(dispatchId);
    await waitForCondition(() => killCalls.length > 0, { timeoutMs: 500 });
    channelManager.simulateClaudeResurrected();
    channelManager.simulateRespawn();
    await waitForCondition(() => store.getDispatch(dispatchId).state === DISPATCH_STATES.FAILED,
        { timeoutMs: 500 });

    const rows = store.db.prepare('SELECT kind FROM incidents WHERE dispatch_id = ? ORDER BY incident_id').all(dispatchId);
    const kinds = rows.map(r => r.kind);
    assert.ok(kinds.includes('system_notice_failed'),
        `expected system_notice_failed in ${JSON.stringify(kinds)}`);
    assert.ok(!kinds.includes('system_notice_emitted'),
        `must NOT record emitted when send returned false`);
    await supervisor.shutdown();
    store.close();
});
