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
        this.activeDispatch = null;     // { dispatchId, startedAt, lastProgressAt, sendingOrdinalBase }
        this.pendingResolvers = new Map(); // dispatchId -> { resolve, reject, timer }
        this.queue = [];                // dispatchIds waiting for activeDispatch to clear

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

        if (this.state === STATES.IDLE && !this.activeDispatch) {
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
            const silenceMs = row.silence_ms || DEFAULT_SILENCE_MS;
            const safetyMs = silenceMs * SAFETY_NET_MULTIPLIER;
            const timer = setTimeout(() => {
                this._abandonDispatch(dispatchId, 'safety_timeout_no_stop');
            }, safetyMs);
            if (timer.unref) timer.unref();
            this.pendingResolvers.set(dispatchId, { resolve, reject, timer });
        });
    }

    getStatus() {
        return {
            state: this.state,
            epoch: this.epoch,
            active_dispatch: this.activeDispatch ? { ...this.activeDispatch } : null,
            queue_depth: this.queue.length,
        };
    }

    async shutdown() {
        if (this._shutdown) return;
        this._shutdown = true;
        this._stopTailer();
        for (const [dispatchId, resolver] of this.pendingResolvers) {
            clearTimeout(resolver.timer);
            resolver.reject(new Error('supervisor shutdown'));
        }
        this.pendingResolvers.clear();
        this._transition('shutdown', { occurredAt: this.clock() });
    }

    _activateNext() {
        if (this.activeDispatch) return;
        let dispatchId = this.queue.shift();
        if (!dispatchId) {
            // look for any queued dispatch (covers the "enqueued while idle" path
            // since that one is activated immediately without touching this.queue)
            const open = this.store.listOpenDispatches().find(d => d.state === DISPATCH_STATES.QUEUED);
            if (!open) return;
            dispatchId = open.dispatch_id;
        }

        const row = this.store.getDispatch(dispatchId);
        if (!row) return;

        const now = this.clock();
        this.store.updateDispatchState(dispatchId, {
            state: DISPATCH_STATES.SENDING,
            sendingAt: now,
        });

        // Send via channelManager. PR1 uses the existing transport.
        // PR2 will remove ChannelManager's internal pending buffer so this is
        // the only path. PR3 converts bridge tools to request/response.
        try {
            this.channelManager.sendToChannel(
                row.chat_id || this.defaultChatId,
                row.payload,
                row.chat_id || this.defaultChatId
            );
        } catch (err) {
            this._completeDispatch(dispatchId, DISPATCH_STATES.FAILED, err.message);
            return;
        }

        const activateTs = this.clock();
        this.store.updateDispatchState(dispatchId, {
            state: DISPATCH_STATES.ACTIVE,
            activatedAt: activateTs,
            lastProgressAt: activateTs,
        });
        this.activeDispatch = {
            dispatchId,
            startedAt: activateTs,
            lastProgressAt: activateTs,
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
        this.store.updateDispatchState(dispatchId, {
            state: terminalState,
            terminalAt: now,
            lastError: error,
        });

        this.incidents.record({
            kind: `dispatch_${terminalState}`,
            dispatchId,
            epoch: this.epoch,
            stateFrom: DISPATCH_STATES.ACTIVE,
            stateTo: terminalState,
            details: { error },
        });

        const resolver = this.pendingResolvers.get(dispatchId);
        if (resolver) {
            clearTimeout(resolver.timer);
            resolver.resolve({ state: terminalState, error });
            this.pendingResolvers.delete(dispatchId);
        }

        if (this.activeDispatch && this.activeDispatch.dispatchId === dispatchId) {
            this.activeDispatch = null;
            this._transition('dispatch_terminal', { occurredAt: now });
            // Activate next queued dispatch if any
            this._activateNext();
        }
    }

    _abandonDispatch(dispatchId, reason) {
        const row = this.store.getDispatch(dispatchId);
        if (!row || TERMINAL_DISPATCH_STATES.has(row.state)) return;
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
