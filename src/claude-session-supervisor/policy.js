/**
 * ClaudeSessionSupervisor - Policy (pure FSM)
 *
 * Pure functions for state transitions and replay policy decisions.
 * Zero side effects. Zero IO. Fully unit-testable.
 *
 * State machine (PR1 observe-only subset):
 *
 *   stopped -> starting -> verifying -> idle -> dispatching -> {idle | abandoned}
 *
 *   (PR1 does NOT implement suspect/probing/respawning/hardFailed. The
 *   transitions exist in the vocabulary so PR4 can add them without
 *   re-architecting.)
 *
 * Dispatch lifecycle (per-dispatch, runs in parallel to supervisor FSM):
 *
 *   queued -> sending -> active -> {completed | failed | abandoned}
 *
 * Design doc: ~/.root-operator/workspace/design/claude-session-supervisor-v4.md
 */

const STATES = Object.freeze({
    STOPPED: 'stopped',
    STARTING: 'starting',
    VERIFYING: 'verifying',
    IDLE: 'idle',
    DISPATCHING: 'dispatching',
    SUSPECT: 'suspect',
    PROBING: 'probing',
    RESPAWNING: 'respawning',
    HARD_FAILED: 'hardFailed',
});

const DISPATCH_STATES = Object.freeze({
    QUEUED: 'queued',
    SENDING: 'sending',
    ACTIVE: 'active',
    COMPLETED: 'completed',
    FAILED: 'failed',
    ABANDONED: 'abandoned',
});

const TERMINAL_DISPATCH_STATES = Object.freeze(new Set([
    DISPATCH_STATES.COMPLETED,
    DISPATCH_STATES.FAILED,
    DISPATCH_STATES.ABANDONED,
]));

/**
 * Allowed supervisor state transitions (PR1 subset).
 * Returns { ok: true, next } or { ok: false, reason }.
 */
function transitionSupervisor(current, event) {
    const T = STATES;

    switch (current) {
        case T.STOPPED:
            if (event === 'start') return { ok: true, next: T.STARTING };
            break;
        case T.STARTING:
            if (event === 'bridge_connected') return { ok: true, next: T.VERIFYING };
            if (event === 'startup_timeout') return { ok: true, next: T.HARD_FAILED };
            if (event === 'shutdown') return { ok: true, next: T.STOPPED };
            break;
        case T.VERIFYING:
            // PR1: we don't implement real _ping yet, but the transition exists
            // so the wiring through orchestrator.js is future-proof. PR1 treats
            // verifying as "done" the moment bridge connects (skip=true).
            if (event === 'verify_ok' || event === 'verify_skipped') return { ok: true, next: T.IDLE };
            if (event === 'verify_failed') return { ok: true, next: T.RESPAWNING };
            if (event === 'shutdown') return { ok: true, next: T.STOPPED };
            break;
        case T.IDLE:
            if (event === 'dispatch_activated') return { ok: true, next: T.DISPATCHING };
            if (event === 'shutdown') return { ok: true, next: T.STOPPED };
            break;
        case T.DISPATCHING:
            if (event === 'dispatch_terminal') return { ok: true, next: T.IDLE };
            if (event === 'silence_timeout') return { ok: true, next: T.SUSPECT };
            if (event === 'process_exit') return { ok: true, next: T.SUSPECT };
            if (event === 'shutdown') return { ok: true, next: T.STOPPED };
            break;
        case T.SUSPECT:
            if (event === 'kill_ordered') return { ok: true, next: T.RESPAWNING };
            if (event === 'process_already_dead') return { ok: true, next: T.RESPAWNING };
            if (event === 'shutdown') return { ok: true, next: T.STOPPED };
            break;
        case T.RESPAWNING:
            if (event === 'respawn_ok') return { ok: true, next: T.STARTING };
            if (event === 'intensity_exhausted') return { ok: true, next: T.HARD_FAILED };
            if (event === 'shutdown') return { ok: true, next: T.STOPPED };
            break;
        case T.HARD_FAILED:
            if (event === 'manual_reset') return { ok: true, next: T.STOPPED };
            break;
    }

    return { ok: false, reason: `no transition from ${current} on ${event}` };
}

function transitionDispatch(current, event) {
    const D = DISPATCH_STATES;

    switch (current) {
        case D.QUEUED:
            if (event === 'send') return { ok: true, next: D.SENDING };
            if (event === 'abandon') return { ok: true, next: D.ABANDONED };
            break;
        case D.SENDING:
            if (event === 'activate') return { ok: true, next: D.ACTIVE };
            if (event === 'send_failed') return { ok: true, next: D.FAILED };
            if (event === 'abandon') return { ok: true, next: D.ABANDONED };
            break;
        case D.ACTIVE:
            if (event === 'stop') return { ok: true, next: D.COMPLETED };
            if (event === 'stop_failure') return { ok: true, next: D.FAILED };
            if (event === 'abandon') return { ok: true, next: D.ABANDONED };
            break;
    }

    return { ok: false, reason: `no transition from ${current} on ${event}` };
}

/**
 * Default replay caps per source. PR1 captures the policy even though
 * PR1 itself does not perform any replays (no wedge detection yet).
 */
function replayCapForSource(source) {
    switch (source) {
        case 'scheduler': return 2;
        case 'channel': return 1;
        case 'user': return 1;
        case 'probe': return 0;
        default: return 0;
    }
}

/**
 * Given a dispatch row and intended replay, decide whether replay is allowed.
 * PR1 exposes the policy; actual replay invocation is PR4.
 */
function canReplayDispatch(dispatch) {
    if (!dispatch) return { allowed: false, reason: 'no_dispatch' };
    if (dispatch.replay_count >= dispatch.replay_cap) {
        return { allowed: false, reason: 'replay_cap_exceeded' };
    }
    if (dispatch.source === 'probe') {
        return { allowed: false, reason: 'probe_no_replay' };
    }
    if (dispatch.source !== 'scheduler' && dispatch.visible_effect_count > 0) {
        return { allowed: false, reason: 'visible_effect_committed' };
    }
    return { allowed: true };
}

/**
 * Intensity budget helpers (PR2). Both must return false for a respawn to proceed.
 * `timestamps` is an array of past kill_ordered / process_exit epoch-millis values.
 *
 * Burst: 3 or more within the last 30s → exhausted (catches boot-wedge loops).
 * Window: 3 or more within the last 10min → exhausted (catches distributed flakes).
 *
 * Pure functions — callers pass `now` (defaults to Date.now) so tests can be deterministic.
 */
const INTENSITY_BURST_WINDOW_MS = 30 * 1000;
const INTENSITY_WINDOW_MS = 10 * 60 * 1000;
const INTENSITY_MAX = 3;

function _countWithin(timestamps, windowMs, now) {
    const cutoff = now - windowMs;
    let n = 0;
    for (const ts of timestamps) {
        if (ts > cutoff) n += 1;
    }
    return n;
}

function intensityBurst(timestamps, now = Date.now()) {
    return _countWithin(timestamps, INTENSITY_BURST_WINDOW_MS, now) >= INTENSITY_MAX;
}

function intensityWindow(timestamps, now = Date.now()) {
    return _countWithin(timestamps, INTENSITY_WINDOW_MS, now) >= INTENSITY_MAX;
}

function intensityExhausted(timestamps, now = Date.now()) {
    return intensityBurst(timestamps, now) || intensityWindow(timestamps, now);
}

module.exports = {
    STATES,
    DISPATCH_STATES,
    TERMINAL_DISPATCH_STATES,
    transitionSupervisor,
    transitionDispatch,
    replayCapForSource,
    canReplayDispatch,
    intensityBurst,
    intensityWindow,
    intensityExhausted,
    INTENSITY_BURST_WINDOW_MS,
    INTENSITY_WINDOW_MS,
    INTENSITY_MAX,
};
