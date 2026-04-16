/**
 * Unit tests for dispatch-store.js.
 * Uses better-sqlite3 file-backed DB in a temp directory (no :memory: because
 * we also exercise WAL mode).
 * Runner: node --test src/claude-session-supervisor/dispatch-store.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DispatchStore } = require('./dispatch-store');

function tempDbPath() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-store-test-'));
    return path.join(dir, 'claude-supervisor.db');
}

test('opens and creates schema idempotently', () => {
    const p = tempDbPath();
    const s1 = new DispatchStore(p);
    s1.close();
    // Reopen — schema migration should be a no-op
    const s2 = new DispatchStore(p);
    s2.close();
});

test('insert + getDispatch roundtrip', () => {
    const s = new DispatchStore(tempDbPath());
    s.insertDispatch({
        dispatchId: 'd1',
        source: 'scheduler',
        sourceId: 'job-nightly',
        chatId: null,
        payload: 'run night lab',
        silenceMs: 60_000,
        replayCap: 2,
        state: 'queued',
        epoch: 1,
        enqueuedAt: 1000,
    });
    const got = s.getDispatch('d1');
    assert.equal(got.dispatch_id, 'd1');
    assert.equal(got.source, 'scheduler');
    assert.equal(got.source_id, 'job-nightly');
    assert.equal(got.payload, 'run night lab');
    assert.equal(got.silence_ms, 60_000);
    assert.equal(got.replay_cap, 2);
    assert.equal(got.replay_count, 0);
    assert.equal(got.state, 'queued');
    assert.equal(got.epoch, 1);
    assert.equal(got.enqueued_at, 1000);
    s.close();
});

test('updateDispatchState respects COALESCE on _at fields', () => {
    const s = new DispatchStore(tempDbPath());
    s.insertDispatch({
        dispatchId: 'd1', source: 'channel', sourceId: null, chatId: 'chat1',
        payload: 'hi', silenceMs: 60_000, replayCap: 1, state: 'queued',
        epoch: 1, enqueuedAt: 1000,
    });
    s.updateDispatchState('d1', { state: 'sending', sendingAt: 1100 });
    s.updateDispatchState('d1', { state: 'sending', sendingAt: 9999 }); // should NOT overwrite
    let row = s.getDispatch('d1');
    assert.equal(row.sending_at, 1100);

    s.updateDispatchState('d1', { state: 'active', activatedAt: 1200, lastProgressAt: 1200 });
    row = s.getDispatch('d1');
    assert.equal(row.state, 'active');
    assert.equal(row.activated_at, 1200);
    assert.equal(row.sending_at, 1100); // preserved

    s.updateDispatchState('d1', { state: 'completed', terminalAt: 1500 });
    row = s.getDispatch('d1');
    assert.equal(row.state, 'completed');
    assert.equal(row.terminal_at, 1500);
    s.close();
});

test('markProgress updates last_progress_at', () => {
    const s = new DispatchStore(tempDbPath());
    s.insertDispatch({
        dispatchId: 'd1', source: 'channel', chatId: 'c', payload: 'hi',
        silenceMs: 60_000, replayCap: 1, state: 'active', epoch: 1, enqueuedAt: 1000,
    });
    s.markProgress('d1', 2000);
    assert.equal(s.getDispatch('d1').last_progress_at, 2000);
    s.markProgress('d1', 3000);
    assert.equal(s.getDispatch('d1').last_progress_at, 3000);
    s.close();
});

test('incrementVisibleEffect adds one each call', () => {
    const s = new DispatchStore(tempDbPath());
    s.insertDispatch({
        dispatchId: 'd1', source: 'channel', chatId: 'c', payload: 'hi',
        silenceMs: 60_000, replayCap: 1, state: 'active', epoch: 1, enqueuedAt: 1000,
    });
    s.incrementVisibleEffect('d1');
    s.incrementVisibleEffect('d1');
    s.incrementVisibleEffect('d1');
    assert.equal(s.getDispatch('d1').visible_effect_count, 3);
    s.close();
});

test('listOpenDispatches returns only non-terminal', () => {
    const s = new DispatchStore(tempDbPath());
    s.insertDispatch({ dispatchId: 'a', source: 'channel', payload: 'x', silenceMs: 1, replayCap: 1, state: 'queued', enqueuedAt: 1 });
    s.insertDispatch({ dispatchId: 'b', source: 'channel', payload: 'x', silenceMs: 1, replayCap: 1, state: 'active', enqueuedAt: 2 });
    s.insertDispatch({ dispatchId: 'c', source: 'channel', payload: 'x', silenceMs: 1, replayCap: 1, state: 'completed', enqueuedAt: 3 });
    const open = s.listOpenDispatches().map(r => r.dispatch_id);
    assert.deepEqual(open, ['a', 'b']);
    s.close();
});

test('effects UNIQUE(dispatch_id, ordinal, kind) enforced', () => {
    const s = new DispatchStore(tempDbPath());
    s.insertPreparedEffect({
        effectId: 'reply:d1:0', dispatchId: 'd1', ordinal: 0, kind: 'reply', preparedAt: 100,
    });
    assert.throws(() => {
        s.insertPreparedEffect({
            effectId: 'reply:d1:0-dup', dispatchId: 'd1', ordinal: 0, kind: 'reply', preparedAt: 101,
        });
    }, /UNIQUE/);
    // Different ordinal is fine
    s.insertPreparedEffect({
        effectId: 'reply:d1:1', dispatchId: 'd1', ordinal: 1, kind: 'reply', preparedAt: 102,
    });
    // Different kind at same ordinal is fine
    s.insertPreparedEffect({
        effectId: 'memory_assistant:d1:1', dispatchId: 'd1', ordinal: 1, kind: 'memory_assistant', preparedAt: 103,
    });
    assert.equal(s.listEffectsForDispatch('d1').length, 3);
    s.close();
});

test('markEffectCommitted flips status and stamps committed_at + external_ref', () => {
    const s = new DispatchStore(tempDbPath());
    s.insertPreparedEffect({
        effectId: 'reply:d1:0', dispatchId: 'd1', ordinal: 0, kind: 'reply', preparedAt: 100,
    });
    let prepared = s.listPreparedEffects();
    assert.equal(prepared.length, 1);
    s.markEffectCommitted('reply:d1:0', 200, 'chat-store-row-42');
    prepared = s.listPreparedEffects();
    assert.equal(prepared.length, 0);
    const committed = s.listEffectsForDispatch('d1')[0];
    assert.equal(committed.status, 'committed');
    assert.equal(committed.committed_at, 200);
    assert.equal(committed.external_ref, 'chat-store-row-42');
    s.close();
});

test('incidents are persisted and ordered', () => {
    const s = new DispatchStore(tempDbPath());
    s.insertIncident({ kind: 'a', stateFrom: 'x', stateTo: 'y', occurredAt: 100 });
    s.insertIncident({ kind: 'b', stateFrom: 'y', stateTo: 'z', dispatchId: 'd1', occurredAt: 200 });
    const rows = s.db.prepare('SELECT * FROM incidents ORDER BY occurred_at ASC').all();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].kind, 'a');
    assert.equal(rows[1].kind, 'b');
    assert.equal(rows[1].dispatch_id, 'd1');
    s.close();
});

test('supervisor_state key-value store', () => {
    const s = new DispatchStore(tempDbPath());
    assert.equal(s.getStateValue('epoch', '0'), '0');
    s.setStateValue('epoch', 5);
    assert.equal(s.getStateValue('epoch'), '5');
    s.setStateValue('epoch', 7);
    assert.equal(s.getStateValue('epoch'), '7');
    s.close();
});

test('WAL mode is enabled', () => {
    const s = new DispatchStore(tempDbPath());
    const mode = s.db.pragma('journal_mode', { simple: true });
    assert.equal(mode, 'wal');
    s.close();
});

test('PR2: incrementReplayCount bumps by 1', () => {
    const s = new DispatchStore(tempDbPath());
    s.insertDispatch({
        dispatchId: 'r1', source: 'scheduler', sourceId: null, chatId: null,
        payload: 'p', silenceMs: 1000, replayCap: 2, state: 'queued', epoch: 0,
        enqueuedAt: 1000,
    });
    assert.equal(s.getDispatch('r1').replay_count, 0);
    s.incrementReplayCount('r1');
    assert.equal(s.getDispatch('r1').replay_count, 1);
    s.incrementReplayCount('r1');
    assert.equal(s.getDispatch('r1').replay_count, 2);
    s.close();
});

test('PR2: resetDispatchToQueued clears lifecycle columns and sets epoch', () => {
    const s = new DispatchStore(tempDbPath());
    s.insertDispatch({
        dispatchId: 'q1', source: 'scheduler', sourceId: null, chatId: null,
        payload: 'p', silenceMs: 1000, replayCap: 2, state: 'queued', epoch: 0,
        enqueuedAt: 1000,
    });
    // Walk it through to a terminal-ish state
    s.updateDispatchState('q1', {
        state: 'active',
        sendingAt: 1100,
        activatedAt: 1200,
        lastProgressAt: 1300,
    });
    s.updateDispatchState('q1', {
        state: 'failed',
        terminalAt: 1400,
        lastError: 'wedged',
    });
    s.incrementVisibleEffect('q1');
    const before = s.getDispatch('q1');
    assert.equal(before.state, 'failed');
    assert.equal(before.visible_effect_count, 1);
    assert.equal(before.last_error, 'wedged');

    // Reset for replay with new epoch
    s.resetDispatchToQueued('q1', 5);
    const after = s.getDispatch('q1');
    assert.equal(after.state, 'queued');
    assert.equal(after.sending_at, null);
    assert.equal(after.activated_at, null);
    assert.equal(after.terminal_at, null);
    assert.equal(after.last_progress_at, null);
    assert.equal(after.last_error, null);
    assert.equal(after.epoch, 5);
    // Preserved fields
    assert.equal(after.payload, 'p');
    assert.equal(after.replay_cap, 2);
    assert.equal(after.visible_effect_count, 1, 'visible_effect_count must survive reset so canReplayDispatch still sees past effects');
    assert.equal(after.enqueued_at, 1000);
    s.close();
});

test('PR2: resetDispatchToQueued with null epoch clears epoch column', () => {
    const s = new DispatchStore(tempDbPath());
    s.insertDispatch({
        dispatchId: 'q2', source: 'scheduler', sourceId: null, chatId: null,
        payload: 'p', silenceMs: 1000, replayCap: 2, state: 'queued', epoch: 3,
        enqueuedAt: 1000,
    });
    s.resetDispatchToQueued('q2', null);
    const r = s.getDispatch('q2');
    assert.equal(r.epoch, null);
    s.close();
});
