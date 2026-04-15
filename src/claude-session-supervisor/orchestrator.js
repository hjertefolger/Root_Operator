/**
 * ClaudeSessionSupervisor - Orchestrator (Public API)
 *
 * Owns the active-dispatch register, dispatch lifecycle, and hook-log tailing.
 * Exposes enqueue/awaitOutcome/getStatus/shutdown.
 *
 * PR1 scope: observe-only.
 *   - Scheduler (and, in PR2, channel + user) enqueue dispatches.
 *   - Supervisor sends via channelManager, records state transitions,
 *     tails epoch-scoped hook log, and resolves awaitOutcome promises
 *     on Stop / StopFailure / abandoned-timeout.
 *   - NO auto-kill, NO respawn, NO effect-ledger side-effect commits yet.
 *
 * PR1 known gap (documented in PR1_PLAN.md risk register):
 *   Channel + user messages still go through the direct
 *   submitChannelUserMessage -> channelManager.sendToChannel path and are
 *   invisible to the supervisor. If a user message is processed
 *   concurrently with a supervisor dispatch, Stop hooks can be mis-matched.
 *   In practice this is rare (scheduled jobs fire overnight when no one
 *   is chatting). PR2 closes the gap by routing all Claude-bound traffic
 *   through the supervisor.
 *
 * Design doc: ~/.root-operator/workspace/design/claude-session-supervisor-v4.md
 */

const fs = require('fs');
const crypto = require('crypto');
const EventEmitter = require('events');
const { STATES, DISPATCH_STATES, TERMINAL_DISPATCH_STATES,
        transitionSupervisor, transitionDispatch, replayCapForSource } = require('./policy');

const DEFAULT_SILENCE_MS = 5 * 60 * 1000; // 5 minutes
const SAFETY_NET_MULTIPLIER = 10;          // abandon after silence_ms * 10 with no Stop

class ClaudeSessionSupervisor extends EventEmitter {
    /**
     * @param {object} deps
     * @param {import('./dispatch-store').DispatchStore} deps.store
     * @param {import('./runtime').Runtime} deps.runtime
     * @param {import('./incidents').IncidentLogger} deps.incidents
     * @param {object} deps.channelManager must expose sendToChannel(chatId, content, userId)
     * @param {string} deps.hookLogPath absolute path to epoch-scoped hook log
     * @param {() => number} [deps.clock]
     * @param {string} [deps.defaultChatId] chat_id used for scheduler-origin dispatches
     */
    constructor({ store, runtime, incidents, channelManager, hookLogPath, clock, defaultChatId }) {
        super();
        if (!store) throw new Error('supervisor requires store');
        if (!runtime) throw new Error('supervisor requires runtime');
        if (!incidents) throw new Error('supervisor requires incidents');
        if (!channelManager) throw new Error('supervisor requires channelManager');
        if (!hookLogPath) throw new Error('supervisor requires hookLogPath');

        this.store = store;
        this.runtime = runtime;
        this.incidents = incidents;
        this.channelManager = channelManager;
        this.hookLogPath = hookLogPath;
        this.clock = clock || Date.now;
        this.defaultChatId = defaultChatId || '__supervisor__';

        this.state = STATES.STOPPED;
        this.epoch = runtime.currentEpoch;
        // activeDispatch carries its own safety timer (armed at activation, not
        // at awaitOutcome — queued dispatches that never activate cannot be
        // auto-abandoned). Shape: { dispatchId, startedAt, lastProgressAt, safetyTimer }
        this.activeDispatch = null;
        // pendingResolvers holds ARRAYS of { resolve, reject } per dispatchId so
        // multiple awaitOutcome() callers on the same dispatch all settle together.
        this.pendingResolvers = new Map();
        this.queue = []; // dispatchIds waiting for activeDispatch to clear

        // Per-spawn session token. main.js generates a UUID per Claude spawn
        // and passes it via ROOT_OPERATOR_SESSION_TOKEN. Hook records embed
        // it; supervisor rejects hooks whose token doesn't match the current
        // spawn. notifyClaudeExited validates the token before terminalizing
        // the active dispatch. Null until notifyClaudeSpawned() is called.
        this.currentSessionToken = null;
        // When true, _completeDispatch will NOT auto-activate the next queued
        // dispatch. Set by notifyClaudeExited; cleared by notifyClaudeSpawned.
        // Prevents activating a dispatch into a dead bridge between crash and
        // respawn.
        this._awaitingSpawn = false;

        this._tailer = null;
        this._shutdown = false;
    }

    /**
     * Start the supervisor. Transitions through STARTING -> VERIFYING -> IDLE.
     * PR1: verify is skipped (verify_skipped event) since _ping tool is not in
     * the bridge yet — that's PR3.
     */
    async start() {
        const now = this.clock();
        this._transition('start', { occurredAt: now });
        this._transition('bridge_connected', { occurredAt: now });
        this._transition('verify_skipped', { occurredAt: now });

        this._startTailer();
        this.incidents.record({
            kind: 'supervisor_started',
            stateFrom: STATES.STOPPED,
            stateTo: STATES.IDLE,
            epoch: this.epoch,
            details: { hook_log_path: this.hookLogPath, pr1_observe_only: true },
        });
    }

    /**
     * Enqueue a prompt for Claude. Returns { dispatchId } immediately.
     * Use awaitOutcome(dispatchId) to get the terminal result.
     */
    enqueue({ source, sourceId = null, chatId = null, payload, silenceMs = DEFAULT_SILENCE_MS }) {
        if (this._shutdown) throw new Error('supervisor is shutting down');
        if (this.state === STATES.HARD_FAILED) throw new Error('supervisor is hardFailed');
        if (!source) throw new Error('enqueue requires source');
        if (!payload) throw new Error('enqueue requires payload');

        const dispatchId = crypto.randomUUID();
        const now = this.clock();

        this.store.insertDispatch({
            dispatchId,
            source,
            sourceId,
            chatId,
            payload,
            silenceMs,
            replayCap: replayCapForSource(source),
            state: DISPATCH_STATES.QUEUED,
            epoch: this.epoch,
            enqueuedAt: now,
        });

        this.incidents.record({
            kind: 'dispatch_enqueued',
            dispatchId,
            epoch: this.epoch,
            stateTo: DISPATCH_STATES.QUEUED,
            details: { source, source_id: sourceId, chat_id: chatId, silence_ms: silenceMs },
        });

        if (this.state === STATES.IDLE && !this.activeDispatch && !this._awaitingSpawn) {
            this._activateNext();
        } else {
            this.queue.push(dispatchId);
        }

        return { dispatchId };
    }

    /**
     * Returns a promise resolving when the dispatch reaches a terminal state.
     * Resolves with { state, error? }.
     */
    awaitOutcome(dispatchId) {
        const row = this.store.getDispatch(dispatchId);
        if (!row) {
            return Promise.reject(new Error(`unknown dispatch ${dispatchId}`));
        }
        if (TERMINAL_DISPATCH_STATES.has(row.state)) {
            return Promise.resolve({ state: row.state, error: row.last_error || null });
        }

        return new Promise((resolve, reject) => {
            const existing = this.pendingResolvers.get(dispatchId);
            if (existing) {
                existing.push({ resolve, reject });
            } else {
                this.pendingResolvers.set(dispatchId, [{ resolve, reject }]);
            }
            // No timer here: the safety-net timer is armed when the dispatch
            // transitions to ACTIVE in _activateNext(). Queued dispatches
            // cannot be auto-abandoned before they ever start.
        });
    }

    getStatus() {
        return {
            state: this.state,
            epoch: this.epoch,
            active_dispatch: this.activeDispatch ? { ...this.activeDispatch } : null,
            queue_depth: this.queue.length,
            session_token: this.currentSessionToken,
            awaiting_spawn: this._awaitingSpawn,
        };
    }

    /**
     * Called by main.js after a fresh Claude subprocess is spawned. Rotates
     * the session token used for hook-record validation, unblocks dispatch
     * activation after a crash, and promotes the next queued dispatch if
     * the supervisor is idle.
     */
    notifyClaudeSpawned(sessionToken) {
        if (!sessionToken) throw new Error('notifyClaudeSpawned requires a session token');
        const now = this.clock();
        this.currentSessionToken = sessionToken;
        this._awaitingSpawn = false;
        this.incidents.record({
            kind: 'claude_spawned',
            epoch: this.epoch,
            details: { session_token: sessionToken },
        });
        if (this.state === STATES.IDLE && !this.activeDispatch) {
            this._activateNext();
        }
    }

    /**
     * Called by main.js from the claudeProcess 'exit' handler BEFORE scheduling
     * the respawn. Validates the dying session token matches the current one
     * (otherwise the notification is stale and ignored). On match: records the
     * incident, terminalizes any active dispatch as FAILED with reason
     * 'claude_exited', clears the session token, and blocks auto-activation
     * of queued dispatches until notifyClaudeSpawned() confirms a fresh
     * session.
     */
    notifyClaudeExited({ sessionToken, pid = null, exitCode = null, signal = null } = {}) {
        if (!sessionToken) {
            this.incidents.record({
                kind: 'claude_exit_notification_missing_token',
                epoch: this.epoch,
                details: { pid, exit_code: exitCode, signal },
            });
            return;
        }
        if (this.currentSessionToken && sessionToken !== this.currentSessionToken) {
            this.incidents.record({
                kind: 'claude_exited_stale_token',
                epoch: this.epoch,
                details: {
                    notified_token: sessionToken,
                    current_token: this.currentSessionToken,
                    pid, exit_code: exitCode, signal,
                },
            });
            return;
        }

        this.incidents.record({
            kind: 'claude_exited',
            epoch: this.epoch,
            dispatchId: this.activeDispatch ? this.activeDispatch.dispatchId : null,
            details: {
                session_token: sessionToken,
                pid, exit_code: exitCode, signal,
                had_active_dispatch: !!this.activeDispatch,
            },
        });

        // Block next-dispatch activation until a fresh spawn is confirmed.
        // This prevents racing a queued dispatch into a torn-down bridge and
        // prevents any old-session hook bytes that leak through from touching
        // a newly-promoted dispatch.
        this._awaitingSpawn = true;
        this.currentSessionToken = null;

        if (this.activeDispatch) {
            const dispatchId = this.activeDispatch.dispatchId;
            this._completeDispatch(dispatchId, DISPATCH_STATES.FAILED, 'claude_exited');
        }
    }

    async shutdown() {
        if (this._shutdown) return;
        this._shutdown = true;
        this._stopTailer();
        this._clearActiveSafetyTimer();
        for (const [, waiters] of this.pendingResolvers) {
            for (const w of waiters) w.reject(new Error('supervisor shutdown'));
        }
        this.pendingResolvers.clear();
        this._transition('shutdown', { occurredAt: this.clock() });
    }

    _activateNext() {
        if (this.activeDispatch) return;
        // Drain zombie ids: an id popped from the in-memory queue might have
        // been abandoned/shutdown before activation. Skip any that aren't
        // still in 'queued' state in the DB.
        let row = null;
        let dispatchId = null;
        while (true) {
            const candidate = this.queue.shift();
            if (candidate) {
                const r = this.store.getDispatch(candidate);
                if (r && r.state === DISPATCH_STATES.QUEUED) {
                    row = r;
                    dispatchId = candidate;
                    break;
                }
                continue;
            }
            // In-memory queue empty. Fall back to DB scan (covers "enqueued
            // while idle and activated immediately without touching queue").
            const open = this.store.listOpenDispatches().find(d => d.state === DISPATCH_STATES.QUEUED);
            if (!open) return;
            row = open;
            dispatchId = open.dispatch_id;
            break;
        }

        const now = this.clock();
        this.store.updateDispatchState(dispatchId, {
            state: DISPATCH_STATES.SENDING,
            sendingAt: now,
        });

        // Use the unbuffered variant so we never implicitly hand the payload
        // to ChannelManager's pendingMessages buffer. If the socket is down
        // (or drops mid-call), we get false and the payload is NOT queued.
        // This closes the buffered-then-flushed-to-a-different-session race
        // fully for PR1, without waiting for PR2's transport refactor.
        // Fallback to legacy sendToChannel for ChannelManager instances that
        // predate the unbuffered method (shouldn't happen in-tree, but keeps
        // external injections — e.g., tests mocking the interface — working).
        const send = typeof this.channelManager.sendToChannelUnbuffered === 'function'
            ? this.channelManager.sendToChannelUnbuffered.bind(this.channelManager)
            : this.channelManager.sendToChannel.bind(this.channelManager);

        let sent;
        try {
            sent = send(
                row.chat_id || this.defaultChatId,
                row.payload,
                row.chat_id || this.defaultChatId
            );
        } catch (err) {
            this._completeDispatch(dispatchId, DISPATCH_STATES.FAILED, err.message);
            return;
        }

        if (sent === false) {
            this._completeDispatch(dispatchId, DISPATCH_STATES.FAILED, 'bridge_unavailable');
            return;
        }

        const activateTs = this.clock();
        this.store.updateDispatchState(dispatchId, {
            state: DISPATCH_STATES.ACTIVE,
            activatedAt: activateTs,
            lastProgressAt: activateTs,
        });
        const silenceMs = row.silence_ms || DEFAULT_SILENCE_MS;
        const safetyMs = silenceMs * SAFETY_NET_MULTIPLIER;
        const safetyTimer = setTimeout(() => {
            this._abandonDispatch(dispatchId, 'safety_timeout_no_stop');
        }, safetyMs);
        if (safetyTimer.unref) safetyTimer.unref();
        this.activeDispatch = {
            dispatchId,
            startedAt: activateTs,
            lastProgressAt: activateTs,
            safetyTimer,
        };
        this._transition('dispatch_activated', { occurredAt: activateTs });
        this.incidents.record({
            kind: 'dispatch_activated',
            dispatchId,
            epoch: this.epoch,
            stateFrom: DISPATCH_STATES.SENDING,
            stateTo: DISPATCH_STATES.ACTIVE,
            details: { source: row.source },
        });
    }

    _clearActiveSafetyTimer() {
        if (this.activeDispatch && this.activeDispatch.safetyTimer) {
            clearTimeout(this.activeDispatch.safetyTimer);
            this.activeDispatch.safetyTimer = null;
        }
    }

    _startTailer() {
        if (this._tailer) return;
        let position = 0;
        try {
            position = fs.statSync(this.hookLogPath).size;
        } catch {
            position = 0;
        }
        let lineBuffer = '';

        const readMore = () => {
            if (this._shutdown) return;
            let stat;
            try { stat = fs.statSync(this.hookLogPath); } catch { return; }
            if (stat.size < position) {
                position = 0;
                lineBuffer = '';
            }
            if (stat.size === position) return;

            const fd = fs.openSync(this.hookLogPath, 'r');
            try {
                const buf = Buffer.alloc(stat.size - position);
                fs.readSync(fd, buf, 0, buf.length, position);
                position = stat.size;
                lineBuffer += buf.toString('utf8');
            } finally {
                fs.closeSync(fd);
            }

            const lines = lineBuffer.split('\n');
            lineBuffer = lines.pop() || '';
            for (const line of lines) {
                if (!line.trim()) continue;
                let hook;
                try { hook = JSON.parse(line); } catch { continue; }
                this._onHookEvent(hook);
            }
        };

        fs.watchFile(this.hookLogPath, { interval: 100 }, readMore);
        this._tailer = { stop: () => fs.unwatchFile(this.hookLogPath, readMore) };
    }

    _stopTailer() {
        if (!this._tailer) return;
        this._tailer.stop();
        this._tailer = null;
    }

    _onHookEvent(hook) {
        if (!this.activeDispatch) return;

        // Session-token gating: once a session is established, reject any hook
        // whose token doesn't match. This blocks late bytes from a crashed
        // session from falsely terminalizing a freshly-activated dispatch.
        //
        // Gate on field PRESENCE, not truthiness: the shipped hook script
        // always emits `sessionToken`, defaulting to '' if env propagation
        // breaks. A falsy-but-present token against a non-empty current
        // token must be rejected, otherwise a broken plumbing path would
        // silently re-open the exact race we are closing here. Truly absent
        // fields (legacy hook scripts, test fixtures that don't set the
        // field) are still accepted — the rollout window.
        if (this.currentSessionToken && 'sessionToken' in hook
                && hook.sessionToken !== this.currentSessionToken) {
            this.incidents.record({
                kind: 'stale_hook_rejected',
                epoch: this.epoch,
                dispatchId: this.activeDispatch.dispatchId,
                details: {
                    hook_token: hook.sessionToken,
                    current_token: this.currentSessionToken,
                    hook_event: hook.hookEventName || hook.hook_event_name,
                },
            });
            return;
        }

        const dispatchId = this.activeDispatch.dispatchId;
        const now = this.clock();
        const name = hook.hookEventName || hook.hook_event_name;

        this.store.markProgress(dispatchId, now);
        this.activeDispatch.lastProgressAt = now;

        if (name === 'PreToolUse' && hook.toolName === 'reply') {
            this.store.incrementVisibleEffect(dispatchId);
        }
        if (name === 'Stop') {
            this._completeDispatch(dispatchId, DISPATCH_STATES.COMPLETED, null);
        } else if (name === 'StopFailure') {
            this._completeDispatch(dispatchId, DISPATCH_STATES.FAILED, hook.error || hook.errorDetails || 'stop_failure');
        }
    }

    _completeDispatch(dispatchId, terminalState, error) {
        const now = this.clock();
        const row = this.store.getDispatch(dispatchId);
        if (row && TERMINAL_DISPATCH_STATES.has(row.state)) {
            // Idempotent: never double-complete. Still notify any late awaiters.
            this._settleResolvers(dispatchId, row.state, row.last_error);
            return;
        }

        this.store.updateDispatchState(dispatchId, {
            state: terminalState,
            terminalAt: now,
            lastError: error,
        });

        this.incidents.record({
            kind: `dispatch_${terminalState}`,
            dispatchId,
            epoch: this.epoch,
            stateFrom: row ? row.state : null,
            stateTo: terminalState,
            details: { error },
        });

        this._settleResolvers(dispatchId, terminalState, error);

        if (this.activeDispatch && this.activeDispatch.dispatchId === dispatchId) {
            this._clearActiveSafetyTimer();
            this.activeDispatch = null;
            this._transition('dispatch_terminal', { occurredAt: now });
        }

        // Always try to activate the next queued dispatch — whether this one
        // was pre-activation (e.g. bridge_unavailable) or fully active. Without
        // this, a pre-activation failure would leave the rest of the queue
        // stalled until the next external enqueue arrived.
        // _activateNext() no-ops if activeDispatch is still set, so it is
        // safe to call unconditionally.
        //
        // Exception: when _awaitingSpawn is set, we just crashed and are
        // waiting for a fresh Claude. Activating the next queued dispatch now
        // would racing into a torn-down bridge. notifyClaudeSpawned() will
        // call _activateNext() once the new session is confirmed.
        if (!this._awaitingSpawn) {
            this._activateNext();
        }
    }

    _settleResolvers(dispatchId, terminalState, error) {
        const waiters = this.pendingResolvers.get(dispatchId);
        if (!waiters) return;
        this.pendingResolvers.delete(dispatchId);
        for (const w of waiters) {
            w.resolve({ state: terminalState, error: error || null });
        }
    }

    _abandonDispatch(dispatchId, reason) {
        const row = this.store.getDispatch(dispatchId);
        if (!row || TERMINAL_DISPATCH_STATES.has(row.state)) return;
        // Defensive: if the dispatch is still queued in memory, drop it so
        // _activateNext() can't promote it after abandon.
        this.queue = this.queue.filter(id => id !== dispatchId);
        this._completeDispatch(dispatchId, DISPATCH_STATES.ABANDONED, reason);
    }

    /**
     * Transition supervisor-level state machine. Records an incident on success.
     * Transitions are validated via policy.transitionSupervisor.
     */
    _transition(event, { occurredAt }) {
        const result = transitionSupervisor(this.state, event);
        if (!result.ok) {
            // Non-fatal: log but keep going. Unexpected transitions get surfaced
            // via incidents so they show up in ops review.
            this.incidents.record({
                kind: 'invalid_transition',
                stateFrom: this.state,
                epoch: this.epoch,
                details: { event, reason: result.reason },
            });
            return false;
        }
        const prev = this.state;
        this.state = result.next;
        if (prev !== result.next) {
            this.incidents.record({
                kind: 'supervisor_state',
                stateFrom: prev,
                stateTo: result.next,
                epoch: this.epoch,
                details: { event },
            });
        }
        return true;
    }
}

/**
 * Factory function matching the design doc's `createSupervisor(deps)` shape.
 */
function createSupervisor(deps) {
    return new ClaudeSessionSupervisor(deps);
}

module.exports = {
    ClaudeSessionSupervisor,
    createSupervisor,
    DEFAULT_SILENCE_MS,
    SAFETY_NET_MULTIPLIER,
};
