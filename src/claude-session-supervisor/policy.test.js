/**
 * Unit tests for policy.js (pure FSM).
 * Runner: node --test src/claude-session-supervisor/policy.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    STATES,
    DISPATCH_STATES,
    TERMINAL_DISPATCH_STATES,
    transitionSupervisor,
    transitionDispatch,
    replayCapForSource,
    canReplayDispatch,
} = require('./policy');

test('supervisor: stopped -> starting on start', () => {
    const r = transitionSupervisor(STATES.STOPPED, 'start');
    assert.equal(r.ok, true);
    assert.equal(r.next, STATES.STARTING);
});

test('supervisor: starting -> verifying on bridge_connected', () => {
    const r = transitionSupervisor(STATES.STARTING, 'bridge_connected');
    assert.equal(r.ok, true);
    assert.equal(r.next, STATES.VERIFYING);
});

test('supervisor: verifying -> idle on verify_skipped (PR1 path)', () => {
    const r = transitionSupervisor(STATES.VERIFYING, 'verify_skipped');
    assert.equal(r.ok, true);
    assert.equal(r.next, STATES.IDLE);
});

test('supervisor: idle -> dispatching on dispatch_activated', () => {
    const r = transitionSupervisor(STATES.IDLE, 'dispatch_activated');
    assert.equal(r.ok, true);
    assert.equal(r.next, STATES.DISPATCHING);
});

test('supervisor: dispatching -> idle on dispatch_terminal', () => {
    const r = transitionSupervisor(STATES.DISPATCHING, 'dispatch_terminal');
    assert.equal(r.ok, true);
    assert.equal(r.next, STATES.IDLE);
});

test('supervisor: starting -> hardFailed on startup_timeout', () => {
    const r = transitionSupervisor(STATES.STARTING, 'startup_timeout');
    assert.equal(r.ok, true);
    assert.equal(r.next, STATES.HARD_FAILED);
});

test('supervisor: hardFailed -> stopped on manual_reset', () => {
    const r = transitionSupervisor(STATES.HARD_FAILED, 'manual_reset');
    assert.equal(r.ok, true);
    assert.equal(r.next, STATES.STOPPED);
});

test('supervisor: invalid transition returns reason', () => {
    const r = transitionSupervisor(STATES.IDLE, 'bridge_connected');
    assert.equal(r.ok, false);
    assert.match(r.reason, /no transition/);
});

test('dispatch: queued -> sending on send', () => {
    assert.deepEqual(transitionDispatch(DISPATCH_STATES.QUEUED, 'send'),
        { ok: true, next: DISPATCH_STATES.SENDING });
});

test('dispatch: sending -> active on activate', () => {
    assert.deepEqual(transitionDispatch(DISPATCH_STATES.SENDING, 'activate'),
        { ok: true, next: DISPATCH_STATES.ACTIVE });
});

test('dispatch: active -> completed on stop', () => {
    assert.deepEqual(transitionDispatch(DISPATCH_STATES.ACTIVE, 'stop'),
        { ok: true, next: DISPATCH_STATES.COMPLETED });
});

test('dispatch: active -> failed on stop_failure', () => {
    assert.deepEqual(transitionDispatch(DISPATCH_STATES.ACTIVE, 'stop_failure'),
        { ok: true, next: DISPATCH_STATES.FAILED });
});

test('dispatch: any non-terminal -> abandoned on abandon', () => {
    for (const s of [DISPATCH_STATES.QUEUED, DISPATCH_STATES.SENDING, DISPATCH_STATES.ACTIVE]) {
        const r = transitionDispatch(s, 'abandon');
        assert.equal(r.ok, true);
        assert.equal(r.next, DISPATCH_STATES.ABANDONED);
    }
});

test('terminal dispatch states contains completed/failed/abandoned', () => {
    assert.equal(TERMINAL_DISPATCH_STATES.has(DISPATCH_STATES.COMPLETED), true);
    assert.equal(TERMINAL_DISPATCH_STATES.has(DISPATCH_STATES.FAILED), true);
    assert.equal(TERMINAL_DISPATCH_STATES.has(DISPATCH_STATES.ABANDONED), true);
    assert.equal(TERMINAL_DISPATCH_STATES.has(DISPATCH_STATES.ACTIVE), false);
});

test('replayCapForSource mapping', () => {
    assert.equal(replayCapForSource('scheduler'), 2);
    assert.equal(replayCapForSource('channel'), 1);
    assert.equal(replayCapForSource('user'), 1);
    assert.equal(replayCapForSource('probe'), 0);
    assert.equal(replayCapForSource('unknown_source'), 0);
});

test('canReplayDispatch: cap exhausted blocks', () => {
    const row = { source: 'scheduler', replay_count: 2, replay_cap: 2, visible_effect_count: 0 };
    assert.deepEqual(canReplayDispatch(row), { allowed: false, reason: 'replay_cap_exceeded' });
});

test('canReplayDispatch: probe never replays', () => {
    const row = { source: 'probe', replay_count: 0, replay_cap: 0, visible_effect_count: 0 };
    assert.match(canReplayDispatch(row).reason, /replay_cap_exceeded|probe_no_replay/);
});

test('canReplayDispatch: channel blocked after visible effect', () => {
    const row = { source: 'channel', replay_count: 0, replay_cap: 1, visible_effect_count: 1 };
    assert.deepEqual(canReplayDispatch(row), { allowed: false, reason: 'visible_effect_committed' });
});

test('canReplayDispatch: scheduler allowed after visible effect (if cap not exceeded)', () => {
    const row = { source: 'scheduler', replay_count: 0, replay_cap: 2, visible_effect_count: 1 };
    assert.deepEqual(canReplayDispatch(row), { allowed: true });
});

test('canReplayDispatch: user fresh and no effect is allowed', () => {
    const row = { source: 'user', replay_count: 0, replay_cap: 1, visible_effect_count: 0 };
    assert.deepEqual(canReplayDispatch(row), { allowed: true });
});
