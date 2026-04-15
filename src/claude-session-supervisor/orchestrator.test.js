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

test('PreToolUse reply increments visible_effect_count', async () => {
    const { supervisor, hookLog, store } = fixture();
    await supervisor.start();
    const { dispatchId } = supervisor.enqueue({ source: 'channel', chatId: 'c1', payload: 'hi' });
    const outcome = supervisor.awaitOutcome(dispatchId);
    appendHook(hookLog, { hookEventName: 'PreToolUse', toolName: 'reply' });
    appendHook(hookLog, { hookEventName: 'PreToolUse', toolName: 'reply' });
    // Wait a tick for tailer to read the lines via fs.watchFile poller
    await waitForCondition(() => store.getDispatch(dispatchId).visible_effect_count >= 2, { timeoutMs: 2000 });
    assert.equal(store.getDispatch(dispatchId).visible_effect_count, 2);
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

// --- Session-token isolation (mid-dispatch crash attribution) ---

test('notifyClaudeExited with active dispatch marks it FAILED, not COMPLETED', async () => {
    // Core incident repro: Claude dies mid-dispatch, active dispatch must be
    // marked FAILED with reason 'claude_exited'. Late Stop hooks from the
    // old session must NOT flip the row to COMPLETED.
    const { supervisor, hookLog, store } = fixture();
    await supervisor.start();
    const TOKEN = 'sess-1';
    supervisor.notifyClaudeSpawned(TOKEN);

    const { dispatchId } = supervisor.enqueue({ source: 'scheduler', payload: 'slow_job' });
    const outcome = supervisor.awaitOutcome(dispatchId);

    // Simulate claudeProcess.on('exit') firing mid-dispatch.
    supervisor.notifyClaudeExited({ sessionToken: TOKEN, pid: 12345, exitCode: null, signal: 'SIGKILL' });

    const result = await outcome;
    assert.equal(result.state, DISPATCH_STATES.FAILED);
    assert.equal(result.error, 'claude_exited');

    const row = store.getDispatch(dispatchId);
    assert.equal(row.state, DISPATCH_STATES.FAILED);
    assert.equal(row.last_error, 'claude_exited');

    // Later Stop hook from the dead session must be ignored.
    appendHook(hookLog, { hookEventName: 'Stop', sessionToken: TOKEN });
    await new Promise(r => setTimeout(r, 150));
    assert.equal(store.getDispatch(dispatchId).state, DISPATCH_STATES.FAILED,
        'late Stop re-terminalized a crashed dispatch');

    await supervisor.shutdown();
    store.close();
});

test('A crashes mid-dispatch, B queued: late old-session Stop must not complete B', async () => {
    // The race my original plan would have shipped: A interrupted → B activates
    // → stale Stop from dead Claude lands → B falsely completes. Session-token
    // gating on hooks must reject the stale Stop.
    const { supervisor, hookLog, store, sent } = fixture();
    await supervisor.start();
    const OLD = 'sess-old';
    const NEW = 'sess-new';
    supervisor.notifyClaudeSpawned(OLD);

    const a = supervisor.enqueue({ source: 'scheduler', payload: 'A' });
    const b = supervisor.enqueue({ source: 'scheduler', payload: 'B' });
    const outcomeA = supervisor.awaitOutcome(a.dispatchId);
    const outcomeB = supervisor.awaitOutcome(b.dispatchId);

    assert.equal(store.getDispatch(a.dispatchId).state, DISPATCH_STATES.ACTIVE);
    assert.equal(store.getDispatch(b.dispatchId).state, DISPATCH_STATES.QUEUED);

    // Old Claude dies mid-dispatch on A.
    supervisor.notifyClaudeExited({ sessionToken: OLD, pid: 111, exitCode: null, signal: 'SIGKILL' });
    const rA = await outcomeA;
    assert.equal(rA.state, DISPATCH_STATES.FAILED);

    // B must NOT have been auto-activated into a dead bridge — activation
    // is gated until notifyClaudeSpawned re-confirms a fresh session.
    assert.equal(store.getDispatch(b.dispatchId).state, DISPATCH_STATES.QUEUED);

    // A stale Stop hook from the dead session arrives. It carries OLD token.
    appendHook(hookLog, { hookEventName: 'Stop', sessionToken: OLD });
    await new Promise(r => setTimeout(r, 150));

    // B is still queued (or FAILED if bridge flipped), never COMPLETED.
    const stateB = store.getDispatch(b.dispatchId).state;
    assert.notEqual(stateB, DISPATCH_STATES.COMPLETED,
        'stale old-session Stop falsely completed B');

    // Now a fresh Claude spawns. B activates and completes normally.
    supervisor.notifyClaudeSpawned(NEW);
    await waitForCondition(() => store.getDispatch(b.dispatchId).state === DISPATCH_STATES.ACTIVE,
        { timeoutMs: 1000 });
    appendHook(hookLog, { hookEventName: 'Stop', sessionToken: NEW });
    const rB = await outcomeB;
    assert.equal(rB.state, DISPATCH_STATES.COMPLETED);
    assert.equal(sent.length, 2);

    await supervisor.shutdown();
    store.close();
});

test('notifyClaudeExited with no active dispatch records incident, mutates nothing', async () => {
    const { supervisor, store, incidents } = fixture();
    await supervisor.start();
    supervisor.notifyClaudeSpawned('tok-1');

    assert.equal(supervisor.activeDispatch, null);
    // Should not throw, should not affect state.
    supervisor.notifyClaudeExited({ sessionToken: 'tok-1', pid: 42, exitCode: 0, signal: null });

    assert.equal(supervisor.activeDispatch, null);
    // currentSessionToken cleared; awaitingSpawn flag set so nothing auto-activates.
    assert.equal(supervisor.currentSessionToken, null);

    // Verify an incident of kind 'claude_exited' was recorded.
    const rows = store.db.prepare("SELECT kind FROM incidents WHERE kind = 'claude_exited'").all();
    assert.ok(rows.length >= 1, 'claude_exited incident not recorded');

    await supervisor.shutdown();
    store.close();
});

test('Stop arrives first, then notifyClaudeExited: exit does not re-terminalize', async () => {
    const { supervisor, hookLog, store } = fixture();
    await supervisor.start();
    const TOKEN = 'sess-1';
    supervisor.notifyClaudeSpawned(TOKEN);

    const { dispatchId } = supervisor.enqueue({ source: 'scheduler', payload: 'x' });
    const outcome = supervisor.awaitOutcome(dispatchId);
    appendHook(hookLog, { hookEventName: 'Stop', sessionToken: TOKEN });
    const result = await outcome;
    assert.equal(result.state, DISPATCH_STATES.COMPLETED);

    // Now exit fires (Claude shut down cleanly after Stop).
    supervisor.notifyClaudeExited({ sessionToken: TOKEN, pid: 1, exitCode: 0, signal: null });

    // Dispatch row stays COMPLETED.
    assert.equal(store.getDispatch(dispatchId).state, DISPATCH_STATES.COMPLETED);

    await supervisor.shutdown();
    store.close();
});

test('hook event with mismatched sessionToken is rejected, no progress update', async () => {
    const { supervisor, hookLog, store } = fixture();
    await supervisor.start();
    supervisor.notifyClaudeSpawned('sess-current');

    const { dispatchId } = supervisor.enqueue({ source: 'scheduler', payload: 'x' });
    supervisor.awaitOutcome(dispatchId).catch(() => {}); // absorb shutdown rejection

    const beforeProgress = store.getDispatch(dispatchId).last_progress_at;

    // Stale hook from a dead session.
    appendHook(hookLog, { hookEventName: 'PreToolUse', toolName: 'reply', sessionToken: 'sess-stale' });
    await new Promise(r => setTimeout(r, 150));

    // visible_effect_count must NOT increment, progress must NOT update.
    const row = store.getDispatch(dispatchId);
    assert.equal(row.visible_effect_count, 0, 'stale hook counted as visible effect');
    assert.equal(row.state, DISPATCH_STATES.ACTIVE);

    await supervisor.shutdown();
    store.close();
});

test('hook with empty-string sessionToken is rejected when session is set', async () => {
    // Regression for Codex review: the shipped hook script always emits
    // sessionToken, defaulting to '' if ROOT_OPERATOR_SESSION_TOKEN env
    // propagation breaks. An empty-string token against a non-empty current
    // token must be rejected, otherwise a broken plumbing path silently
    // re-opens the bug this patch is supposed to close.
    const { supervisor, hookLog, store } = fixture();
    await supervisor.start();
    supervisor.notifyClaudeSpawned('sess-real');

    const { dispatchId } = supervisor.enqueue({ source: 'scheduler', payload: 'x' });
    supervisor.awaitOutcome(dispatchId).catch(() => {}); // absorb shutdown rejection

    // A hook arrives with sessionToken present but empty (broken env prop).
    appendHook(hookLog, { hookEventName: 'Stop', sessionToken: '' });
    await new Promise(r => setTimeout(r, 150));

    // Dispatch must remain ACTIVE — the empty token is a mismatch, not a legacy absence.
    assert.equal(store.getDispatch(dispatchId).state, DISPATCH_STATES.ACTIVE,
        'hook with empty token falsely completed active dispatch');

    await supervisor.shutdown();
    store.close();
});

test('enqueue after notifyClaudeExited stays queued until notifyClaudeSpawned', async () => {
    // Locks down the parked-window contract. Between crash and respawn,
    // new enqueues must NOT activate into the dead bridge.
    const { supervisor, store, sent } = fixture();
    await supervisor.start();
    supervisor.notifyClaudeSpawned('sess-old');

    // Crash before any dispatch is enqueued.
    supervisor.notifyClaudeExited({ sessionToken: 'sess-old', pid: 1, exitCode: null, signal: 'SIGKILL' });
    assert.equal(supervisor._awaitingSpawn, true);

    // New enqueue during the parked window.
    const { dispatchId } = supervisor.enqueue({ source: 'scheduler', payload: 'queued-during-park' });
    assert.equal(store.getDispatch(dispatchId).state, DISPATCH_STATES.QUEUED,
        'dispatch auto-activated into dead bridge during parked window');
    assert.equal(sent.length, 0, 'send fired before spawn confirmed');

    // Fresh session arrives; dispatch should now activate.
    supervisor.notifyClaudeSpawned('sess-new');
    await waitForCondition(() => store.getDispatch(dispatchId).state === DISPATCH_STATES.ACTIVE,
        { timeoutMs: 1000 });
    assert.equal(sent.length, 1);

    await supervisor.shutdown();
    store.close();
});

test('notifyClaudeExited with stale token does not touch active dispatch', async () => {
    // Extra defensive case: main.js could in principle notify with an already-
    // rotated token (multiple crashes in fast succession). Supervisor must
    // ignore stale exit notifications once it has moved on.
    const { supervisor, store } = fixture();
    await supervisor.start();
    supervisor.notifyClaudeSpawned('sess-a');

    const { dispatchId } = supervisor.enqueue({ source: 'scheduler', payload: 'x' });
    supervisor.awaitOutcome(dispatchId).catch(() => {}); // absorb shutdown rejection

    // A notify arrives with a token we never issued.
    supervisor.notifyClaudeExited({ sessionToken: 'sess-bogus', pid: 999, exitCode: 0, signal: null });

    // Active dispatch is untouched.
    assert.equal(store.getDispatch(dispatchId).state, DISPATCH_STATES.ACTIVE);
    assert.equal(supervisor.currentSessionToken, 'sess-a');

    await supervisor.shutdown();
    store.close();
});
