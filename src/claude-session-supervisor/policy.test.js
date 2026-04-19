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
    effectiveSilenceMs,
    MAX_EFFECTIVE_SILENCE_MS,
    intensityBurst,
    intensityWindow,
    intensityExhausted,
    INTENSITY_BURST_WINDOW_MS,
    INTENSITY_WINDOW_MS,
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
    assert.equal(replayCapForSource('scheduler'), 4);
    assert.equal(replayCapForSource('channel'), 1);
    assert.equal(replayCapForSource('user'), 1);
    assert.equal(replayCapForSource('probe'), 0);
    assert.equal(replayCapForSource('unknown_source'), 0);
});

test('canReplayDispatch: cap exhausted blocks', () => {
    const row = { source: 'scheduler', replay_count: 4, replay_cap: 4, visible_effect_count: 0 };
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

test('effectiveSilenceMs: doubles per replay, 30min base ladder', () => {
    const base = 30 * 60 * 1000;
    assert.equal(effectiveSilenceMs(base, 0), 30 * 60 * 1000);
    assert.equal(effectiveSilenceMs(base, 1), 60 * 60 * 1000);
    assert.equal(effectiveSilenceMs(base, 2), 120 * 60 * 1000);
    assert.equal(effectiveSilenceMs(base, 3), 240 * 60 * 1000);
    assert.equal(effectiveSilenceMs(base, 4), 480 * 60 * 1000);
});

test('effectiveSilenceMs: clamps at MAX_EFFECTIVE_SILENCE_MS', () => {
    const base = 30 * 60 * 1000;
    // replay_count 5 would be 960 min — ceiling caps at 8h
    assert.equal(effectiveSilenceMs(base, 5), MAX_EFFECTIVE_SILENCE_MS);
    assert.equal(effectiveSilenceMs(base, 99), MAX_EFFECTIVE_SILENCE_MS);
});

test('effectiveSilenceMs: sanitizes bad inputs', () => {
    assert.equal(effectiveSilenceMs(0, 3), 0);
    assert.equal(effectiveSilenceMs(-1000, 3), 0);
    assert.equal(effectiveSilenceMs(1000, -1), 1000);
    assert.equal(effectiveSilenceMs(1000, NaN), 1000);
    assert.equal(effectiveSilenceMs(1000, 1.7), 2000); // floor of 1.7 → 1
});

// PR2: wedge/recovery transitions

test('supervisor: dispatching -> suspect on silence_timeout', () => {
    const r = transitionSupervisor(STATES.DISPATCHING, 'silence_timeout');
    assert.equal(r.ok, true);
    assert.equal(r.next, STATES.SUSPECT);
});

test('supervisor: dispatching -> suspect on process_exit', () => {
    const r = transitionSupervisor(STATES.DISPATCHING, 'process_exit');
    assert.equal(r.ok, true);
    assert.equal(r.next, STATES.SUSPECT);
});

test('supervisor: suspect -> respawning on kill_ordered', () => {
    const r = transitionSupervisor(STATES.SUSPECT, 'kill_ordered');
    assert.equal(r.ok, true);
    assert.equal(r.next, STATES.RESPAWNING);
});

test('supervisor: suspect -> respawning on process_already_dead (crash case)', () => {
    const r = transitionSupervisor(STATES.SUSPECT, 'process_already_dead');
    assert.equal(r.ok, true);
    assert.equal(r.next, STATES.RESPAWNING);
});

test('supervisor: respawning -> hardFailed on intensity_exhausted', () => {
    const r = transitionSupervisor(STATES.RESPAWNING, 'intensity_exhausted');
    assert.equal(r.ok, true);
    assert.equal(r.next, STATES.HARD_FAILED);
});

test('supervisor: respawning -> starting on respawn_ok', () => {
    const r = transitionSupervisor(STATES.RESPAWNING, 'respawn_ok');
    assert.equal(r.ok, true);
    assert.equal(r.next, STATES.STARTING);
});

// Intensity budget

test('intensityBurst: 3 kills within 30s exhausts', () => {
    const now = 1_000_000_000;
    const timestamps = [now - 25_000, now - 15_000, now - 5_000];
    assert.equal(intensityBurst(timestamps, now), true);
});

test('intensityBurst: 3 kills spread beyond 30s does NOT exhaust burst', () => {
    const now = 1_000_000_000;
    const timestamps = [now - 45_000, now - 30_000, now - 5_000];
    assert.equal(intensityBurst(timestamps, now), false);
});

test('intensityWindow: 3 kills within 10min exhausts', () => {
    const now = 1_000_000_000;
    // spread across the window to NOT trip burst, but trip window
    const timestamps = [now - 400_000, now - 200_000, now - 60_000];
    assert.equal(intensityBurst(timestamps, now), false);
    assert.equal(intensityWindow(timestamps, now), true);
});

test('intensityWindow: 3 kills beyond 10min does NOT exhaust', () => {
    const now = 1_000_000_000;
    const timestamps = [now - 700_000, now - 650_000, now - 620_000];
    assert.equal(intensityWindow(timestamps, now), false);
});

test('intensityExhausted is burst OR window', () => {
    const now = 1_000_000_000;
    // only burst trips:
    assert.equal(intensityExhausted([now - 25_000, now - 15_000, now - 5_000], now), true);
    // only window trips:
    assert.equal(intensityExhausted([now - 400_000, now - 200_000, now - 60_000], now), true);
    // neither trips:
    assert.equal(intensityExhausted([now - 700_000, now - 650_000], now), false);
});

test('intensity: empty timestamps never exhausts', () => {
    assert.equal(intensityBurst([]), false);
    assert.equal(intensityWindow([]), false);
    assert.equal(intensityExhausted([]), false);
});

test('intensity: fewer than 3 timestamps never exhausts', () => {
    const now = 1_000_000_000;
    assert.equal(intensityExhausted([now - 1000, now - 2000], now), false);
});
