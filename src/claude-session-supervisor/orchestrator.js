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
        transitionSupervisor, transitionDispatch, replayCapForSource,
        canReplayDispatch, effectiveSilenceMs, intensityExhausted } = require('./policy');

const DEFAULT_SILENCE_MS = 5 * 60 * 1000; // 5 minutes
const SAFETY_NET_MULTIPLIER = 10;          // abandon after silence_ms * 10 with no Stop
// PR2: recovery states during which hook events must NOT complete activeDispatch.
// Late Stop hooks from the dying old Claude (or the freshly booting new Claude
// before replay is re-sent) would otherwise spuriously terminate the replay.
const RECOVERY_STATES = new Set([STATES.SUSPECT, STATES.RESPAWNING, STATES.STARTING, STATES.VERIFYING]);
// PR2: respawn intensity timestamps (kill_ordered + process_exit_during_active)
// are persisted as a JSON array in supervisor_state under this key so the
// budget survives process restarts.
const INTENSITY_STATE_KEY = 'respawn_intensity_ring';
const INTENSITY_RING_MAX = 16;

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
    constructor({ store, runtime, incidents, channelManager, hookLogPath, clock, defaultChatId, enableProbe = false }) {
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
        this._enableProbe = enableProbe;

        this.state = STATES.STOPPED;
        this.epoch = runtime.currentEpoch;
        // activeDispatch carries its own safety timer (armed at activation, not
        // at awaitOutcome — queued dispatches that never activate cannot be
        // auto-abandoned). PR2 adds wedgeTimer and inRecovery flag.
        // Shape: { dispatchId, startedAt, lastProgressAt, safetyTimer, wedgeTimer, inRecovery }
        this.activeDispatch = null;
        // pendingResolvers holds ARRAYS of { resolve, reject } per dispatchId so
        // multiple awaitOutcome() callers on the same dispatch all settle together.
        this.pendingResolvers = new Map();
        this.queue = []; // dispatchIds waiting for activeDispatch to clear

        this._tailer = null;
        this._shutdown = false;

        // PR2: dispatch that needs to be replayed on the next bridge_ready.
        // Shape: { dispatchId, reason }.
        this._dispatchAwaitingReplay = null;
        // PR2: cached bridge_ready subscription so shutdown() can remove it.
        this._bridgeReadyHandler = null;
    }

    /**
     * Start the supervisor. Transitions through STARTING -> VERIFYING -> IDLE.
     * PR3: after reaching IDLE, a probe dispatch verifies Claude can complete
     * a turn end-to-end. The probe runs as a normal dispatch (source='probe')
     * and does NOT block external dispatches — it's observational. If the probe
     * completes, we log verify_ok. If it fails, we log verify_failed but the
     * system remains functional.
     */
    async start() {
        const now = this.clock();
        this._transition('start', { occurredAt: now });
        this._transition('bridge_connected', { occurredAt: now });
        this._transition('verify_skipped', { occurredAt: now });

        this._startTailer();
        this._subscribeBridgeReady();

        this.incidents.record({
            kind: 'supervisor_started',
            stateFrom: STATES.STOPPED,
            stateTo: this.state,
            epoch: this.epoch,
            details: { hook_log_path: this.hookLogPath, pr3_effect_ledger: true },
        });

        // Kill any surviving orphan Claude subprocess BEFORE reconciling
        // dispatch rows. If the previous main.js crashed but its pty-spawned
        // Claude child survived, that process could still be executing the
        // old dispatch. Terminalizing the DB row here while a live Claude
        // writes hook events for the same dispatch_id would either duplicate
        // scheduler side-effects (orphan completes + new replay runs) or
        // flip a successful run to abandoned (fresh supervisor sees the
        // old Claude as wedged and kills it). bootCleanup() also removes
        // stale sockets and prunes old epochs.
        // Capture bootCleanup result so _recoverOrphanedDispatches can see
        // whether the orphan status is safe. Four outcomes matter:
        //   (a) orphan found and killed → safe
        //   (b) orphan found but kill returned 'already_dead' (raced our
        //       own detect→kill window) → safe, orphan is gone either way
        //   (c) orphan found and kill failed for any other reason (EPERM,
        //       EACCES, stuck in D state) → UNSAFE, Claude may still be
        //       processing the old dispatch
        //   (d) no pidfile at all AND prior-epoch open dispatches exist →
        //       UNKNOWN. Happens on the first boot after upgrading from a
        //       build that never called recordPid(): there's no way to
        //       detect a surviving orphan. Treated the same as UNSAFE
        //       because it has the same blast radius.
        this._orphanStatusUnsafe = false;
        // Keep the legacy field name for any code that still reads it.
        this._orphanKillFailed = false;
        if (typeof this.runtime.bootCleanup === 'function') {
            try {
                const report = this.runtime.bootCleanup();
                if (report && (report.orphan_pid || report.stale_socket_removed
                    || (report.old_epochs_removed && report.old_epochs_removed.length > 0))) {
                    this.incidents.record({
                        kind: 'boot_cleanup',
                        epoch: this.epoch,
                        details: report,
                    });
                }
                const killFailedUnsafely = !!(report
                    && report.orphan_pid
                    && report.orphan_killed === false
                    && report.orphan_kill_reason !== 'already_dead');
                if (killFailedUnsafely) {
                    this._orphanStatusUnsafe = true;
                    this._orphanKillFailed = true;
                    this.incidents.record({
                        kind: 'boot_cleanup_kill_failed',
                        epoch: this.epoch,
                        details: {
                            orphan_pid: report.orphan_pid,
                            kill_reason: report.orphan_kill_reason,
                        },
                    });
                }
                // Unknown-status branch: either the pidfile is missing
                // entirely (first-upgrade boot) or the probe couldn't verify
                // it (corrupted content, unparseable PID, ps lookup failure,
                // empty file, etc.). Only elevate to UNSAFE when there are
                // prior-epoch non-terminal rows to protect — a clean fresh
                // install (no pidfile, no orphans) should still proceed.
                const pidfileMissing = !!(report && report.pidfile_present === false);
                const probeUncertain = !!(report && report.orphan_status_certain === false);
                if (pidfileMissing || probeUncertain) {
                    let priorEpochOpenExists = false;
                    try {
                        const open = this.store.listOpenDispatches();
                        priorEpochOpenExists = open.some(row =>
                            row
                            && (row.epoch || 0) < this.epoch
                            && !TERMINAL_DISPATCH_STATES.has(row.state));
                    } catch (_) {
                        priorEpochOpenExists = true; // be conservative
                    }
                    if (priorEpochOpenExists) {
                        this._orphanStatusUnsafe = true;
                        this.incidents.record({
                            kind: 'boot_cleanup_orphan_status_unknown',
                            epoch: this.epoch,
                            details: {
                                reason: probeUncertain
                                    ? `pidfile_probe_uncertain:${report.orphan_status_reason || 'unknown'}`
                                    : 'no_pidfile_with_prior_epoch_open_dispatches',
                            },
                        });
                    }
                }
            } catch (err) {
                this.incidents.record({
                    kind: 'boot_cleanup_error',
                    epoch: this.epoch,
                    details: { error: err && err.message ? err.message : String(err) },
                });
            }
        }

        // Recover any dispatches left non-terminal by a prior process. Their
        // in-memory state (timers, awaitOutcome resolvers, active context) died
        // with the previous supervisor, so they cannot be resumed cleanly.
        // Per-source/per-state policy (see _recoverOrphanedDispatches docs).
        // Runs AFTER bootCleanup so any surviving orphan Claude is already
        // dead, and BEFORE the probe so the probe is the first new dispatch.
        this._recoverOrphanedDispatches();

        // If orphan status is UNSAFE (kill failure, missing pidfile with
        // prior-epoch orphans, or uncertain probe) the old Claude may still
        // be alive and writing to the stable hook log. Any new dispatch we
        // accept would share that hook stream and could pick up stray
        // Stop/StopFailure events from the orphan, completing/failing fresh
        // work on hooks it never emitted. Transition to HARD_FAILED so
        // further enqueues throw rather than run under this ambiguity.
        // Operators must restart the host after resolving the orphan to
        // return the supervisor to service.
        if (this._orphanStatusUnsafe) {
            this._transition('orphan_unsafe', { occurredAt: this.clock() });
            this.incidents.record({
                kind: 'supervisor_hard_failed_orphan_unsafe',
                epoch: this.epoch,
                details: {
                    reason: 'orphan_status_unsafe',
                    note: 'restart required after confirming orphan Claude is terminated',
                },
            });
        }
        // NOTE: we deliberately do NOT drain re-queued dispatches here. On a
        // real boot main.js starts the supervisor BEFORE spawnClaudeCode, so
        // the channel bridge is still disconnected — calling _activateNext
        // would immediately fail each re-queued dispatch via
        // sendToChannelUnbuffered→false→'bridge_unavailable', which is the
        // exact failure recovery is trying to prevent. _onBridgeReady()
        // drains the queue once the bridge is live (see its drain block).

        // Probe is deferred to _onBridgeReady — see _fireStartupProbe().
        // Firing it here would enqueue while the channel bridge is still
        // down on cold boot, which triggers _activateNext and drains any
        // recovered orphans through a disconnected bridge (pass-7 P1).
    }

    /**
     * Fire the PR3 startup probe, but at most once per supervisor instance.
     * Purpose: verify the spawn by driving a full turn from enqueue → Stop
     * through the bridge. Must NOT fire during supervisor.start(), because
     * on cold boot the bridge isn't live yet and the probe's enqueue would
     * drain recovered orphans into a disconnected channel. Instead, called
     * from _onBridgeReady() the first time the bridge is actually up.
     */
    _fireStartupProbe() {
        if (!this._enableProbe) return;
        if (this._probeFired) return;
        this._probeFired = true;
        try {
            const { dispatchId } = this.enqueue({
                source: 'probe',
                payload: '[system] Verify spawn by calling _ping tool now.',
                silenceMs: 15000,
            });
            this.awaitOutcome(dispatchId).then((outcome) => {
                if (this._shutdown) return;
                this.incidents.record({
                    kind: outcome.state === 'completed' ? 'verify_ok' : 'verify_probe_failed',
                    epoch: this.epoch,
                    details: { outcome },
                });
            }).catch(() => { /* shutdown race — ignore */ });
        } catch (_) {
            // enqueue may fail if hardFailed/shutdown. Non-fatal.
        }
    }

    /**
     * PR2: called by main.js after its claudeProcess.on('exit') handler.
     * If there's an active dispatch, transition straight through SUSPECT to
     * RESPAWNING (process is already dead — skip kill_ordered) and mark the
     * dispatch as awaiting replay. Main.js's existing scheduleClaudeRestart
     * flow will bring a new Claude back; we'll replay on bridge_ready.
     */
    notifyClaudeExited(exitCode) {
        if (this._shutdown) return;
        if (!this.activeDispatch || this.state !== STATES.DISPATCHING) {
            // Clean exit with no active dispatch, or already in recovery. Nothing to do.
            return;
        }
        const dispatchId = this.activeDispatch.dispatchId;
        this.activeDispatch.inRecovery = true;
        // Clear the wedge timer but DELIBERATELY leave the safety-net timer
        // armed. If bridge_ready never arrives (e.g. cloudflared down, respawn
        // stuck) the dispatch still eventually abandons via the safety-net
        // path — prevents the "silent hang forever" failure mode that PR2 is
        // specifically built to eliminate.
        this._clearActiveWedgeTimer();
        this.incidents.record({
            kind: 'process_exit_during_active',
            dispatchId,
            epoch: this.epoch,
            stateFrom: this.state,
            details: { exit_code: exitCode === undefined ? null : exitCode },
        });
        this._transition('process_exit', { occurredAt: this.clock() });           // DISPATCHING -> SUSPECT
        this._recordIntensityTimestamp(this.clock());
        this._transition('process_already_dead', { occurredAt: this.clock() });  // SUSPECT -> RESPAWNING
        this._dispatchAwaitingReplay = { dispatchId, reason: 'process_exit' };
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
        };
    }

    async shutdown() {
        if (this._shutdown) return;
        this._shutdown = true;
        this._stopTailer();
        this._clearActiveSafetyTimer();
        this._clearActiveWedgeTimer();
        this._unsubscribeBridgeReady();
        // Terminalize any in-flight dispatch so it doesn't look permanently active
        if (this.activeDispatch) {
            const dispatchId = this.activeDispatch.dispatchId;
            try {
                this.store.updateDispatchState(dispatchId, {
                    state: DISPATCH_STATES.ABANDONED,
                    terminalAt: this.clock(),
                    lastError: 'shutdown_while_active',
                });
                this.incidents.record({
                    kind: 'dispatch_abandoned',
                    dispatchId,
                    epoch: this.epoch,
                    details: { error: 'shutdown_while_active' },
                    occurredAt: this.clock(),
                });
            } catch (_) { /* best-effort during shutdown */ }
            this.activeDispatch = null;
        }
        // Also terminalize ANY remaining non-terminal dispatches. Channel-mode
        // toggles with queued scheduler work would otherwise reject the
        // scheduler's awaitOutcome (clearing runningAt), leave the row
        // non-terminal in SQLite, and then next-boot recovery would re-queue
        // an orphan with no scheduler waiter to reconcile its outcome. We
        // deliberately do NOT filter by epoch here — the only supervisor
        // instance that could touch these rows is this one (teardownChannelMode
        // shuts the prior instance down before creating a new one), so sweeping
        // all open rows is safe and simpler than reasoning about epoch equality
        // when epoch is sometimes null.
        try {
            const open = this.store.listOpenDispatches();
            for (const row of open) {
                if (!row || !row.dispatch_id) continue;
                if (TERMINAL_DISPATCH_STATES.has(row.state)) continue;
                this.store.updateDispatchState(row.dispatch_id, {
                    state: DISPATCH_STATES.ABANDONED,
                    terminalAt: this.clock(),
                    lastError: 'shutdown_while_queued',
                });
                this.incidents.record({
                    kind: 'dispatch_abandoned',
                    dispatchId: row.dispatch_id,
                    epoch: this.epoch,
                    details: { error: 'shutdown_while_queued', prior_state: row.state },
                });
            }
        } catch (_) { /* best-effort during shutdown */ }
        this.queue = [];
        this._dispatchAwaitingReplay = null;
        for (const [, waiters] of this.pendingResolvers) {
            for (const w of waiters) w.reject(new Error('supervisor shutdown'));
        }
        this.pendingResolvers.clear();
        this._transition('shutdown', { occurredAt: this.clock() });
    }

    _activateNext() {
        if (this.activeDispatch) return;
        // Bridge-connectivity gate. If the ChannelManager exposes a
        // `.connected` flag and it's false, leave the queue alone —
        // _onBridgeReady() will call _activateNext() again once the bridge
        // is live. This prevents three distinct footguns:
        //   (1) cold-boot: supervisor.start() runs before spawnClaudeCode,
        //       so anything recovered into this.queue would be sent through
        //       a disconnected bridge and marked bridge_unavailable.
        //   (2) cron fires during startup: a scheduled job that triggers
        //       enqueue() before bridge_ready would drain the recovered
        //       queue ahead of itself.
        //   (3) bridge drops mid-session: new enqueues wait for reconnect
        //       instead of firing and failing.
        // Mocks/tests without a `.connected` property (undefined) behave as
        // before — always-available — and are not affected.
        if (this.channelManager && this.channelManager.connected === false) {
            return;
        }
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

        // PR3: tell the bridge which dispatch is now active so it can reset
        // its ordinal counter. Best-effort — if this fails, ordinals default
        // to the previous counter state (degraded but non-fatal).
        if (typeof this.channelManager.sendStructuredMessage === 'function') {
            this.channelManager.sendStructuredMessage({
                type: 'activate_dispatch',
                dispatch_id: dispatchId,
            });
        }

        const activateTs = this.clock();
        this.store.updateDispatchState(dispatchId, {
            state: DISPATCH_STATES.ACTIVE,
            activatedAt: activateTs,
            lastProgressAt: activateTs,
        });
        // Sanitize the caller-supplied silence budget. A negative or non-numeric
        // value would otherwise arm an immediate safety-net kill on activation
        // or re-arm a zero-ms wedge timer via _onHookEvent after progress.
        const baseSilenceMs = this._sanitizedBaseSilenceMs(row.silence_ms);
        // Safety net is bounded to the caller's (sanitized) base silence budget
        // so that exponential wedge backoff (effectiveSilenceMs below) cannot
        // stretch the no-Stop abandon window. Base × 10 stays stable across replays.
        const safetyMs = baseSilenceMs * SAFETY_NET_MULTIPLIER;
        const safetyTimer = setTimeout(() => {
            this._abandonDispatch(dispatchId, 'safety_timeout_no_stop');
        }, safetyMs);
        if (safetyTimer.unref) safetyTimer.unref();
        // Wedge timer uses the effective (backoff-scaled) silence. On replays
        // this doubles per attempt so an upstream outage doesn't burn the
        // whole replay budget inside the outage window.
        const wedgeSilenceMs = effectiveSilenceMs(baseSilenceMs, row.replay_count || 0);
        const wedgeTimer = setTimeout(() => {
            this._handleWedge(dispatchId, 'silence_timeout');
        }, wedgeSilenceMs);
        if (wedgeTimer.unref) wedgeTimer.unref();
        this.activeDispatch = {
            dispatchId,
            startedAt: activateTs,
            lastProgressAt: activateTs,
            safetyTimer,
            wedgeTimer,
            inRecovery: false,
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

    /**
     * Sanitize a caller-supplied silence_ms value. Shared by _activateNext()
     * and _onHookEvent() so every wedge/safety-net timer is armed from the
     * same finite-positive budget. A DB row with silence_ms = 0/null/NaN
     * (bad caller input, schema migration hole, or corrupted column) would
     * otherwise fire an immediate abandon on activation or a zero-ms wedge
     * on the first progress hook.
     */
    _sanitizedBaseSilenceMs(raw) {
        const n = Number(raw);
        return Number.isFinite(n) && n > 0 ? n : DEFAULT_SILENCE_MS;
    }

    _clearActiveSafetyTimer() {
        if (this.activeDispatch && this.activeDispatch.safetyTimer) {
            clearTimeout(this.activeDispatch.safetyTimer);
            this.activeDispatch.safetyTimer = null;
        }
    }

    _clearActiveWedgeTimer() {
        if (this.activeDispatch && this.activeDispatch.wedgeTimer) {
            clearTimeout(this.activeDispatch.wedgeTimer);
            this.activeDispatch.wedgeTimer = null;
        }
    }

    _armWedgeTimer(dispatchId, silenceMs) {
        if (!this.activeDispatch || this.activeDispatch.dispatchId !== dispatchId) return;
        this._clearActiveWedgeTimer();
        const t = setTimeout(() => this._handleWedge(dispatchId, 'silence_timeout'), silenceMs);
        if (t.unref) t.unref();
        this.activeDispatch.wedgeTimer = t;
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

        // PR2 hook guard: during recovery flight (between kill-ordered and
        // replay-re-sent) hook events from the dying old Claude or the booting
        // new Claude MUST NOT complete the dispatch. Progress tracking is also
        // suspended — lastProgressAt is meaningless while we're mid-recovery.
        if (this.activeDispatch.inRecovery || RECOVERY_STATES.has(this.state)) {
            return;
        }

        this.store.markProgress(dispatchId, now);
        this.activeDispatch.lastProgressAt = now;
        // Progress resets the wedge timer. Recompute effective silence from
        // the immutable base and current replay_count so post-replay timers
        // stay on the same backoff ladder used at activation. Sanitize base
        // via the same helper as _activateNext() so a bad silence_ms column
        // value can't re-arm at 0 ms after the first progress hook.
        const row = this.store.getDispatch(dispatchId);
        if (row) {
            const baseSilenceMs = this._sanitizedBaseSilenceMs(row.silence_ms);
            const wedgeSilenceMs = effectiveSilenceMs(baseSilenceMs, row.replay_count || 0);
            this._armWedgeTimer(dispatchId, wedgeSilenceMs);
        }

        // PR3: visible_effect_count is now incremented by the effect-ledger
        // path in main.js handleReplyRequest(). The old hook-based increment
        // was removed to prevent double-counting (Codex finding #4).
        if (name === 'Stop') {
            this._completeDispatch(dispatchId, DISPATCH_STATES.COMPLETED, null);
        } else if (name === 'StopFailure') {
            this._completeDispatch(dispatchId, DISPATCH_STATES.FAILED, hook.error || hook.errorDetails || 'stop_failure');
        }
    }

    /**
     * PR2: dispatch was active and Claude has gone silent for silence_ms.
     * Transition DISPATCHING -> SUSPECT, mark the dispatch inRecovery so late
     * hooks are ignored, and ask the runtime to kill the subprocess. Main.js's
     * existing exit handler will respawn; the bridge_ready event drives replay.
     */
    _handleWedge(dispatchId, reason) {
        if (this._shutdown) return;
        if (!this.activeDispatch || this.activeDispatch.dispatchId !== dispatchId) return;
        if (this.activeDispatch.inRecovery) return; // already handled
        this.activeDispatch.inRecovery = true;
        // NOTE: we deliberately leave the safety-net timer armed. If kill+respawn+replay
        // fails to produce a Stop hook before silenceMs * SAFETY_NET_MULTIPLIER, the
        // dispatch is still abandoned via the safety-net path (see _activateNext) and
        // the scheduler's awaitOutcome() eventually resolves as ABANDONED rather than
        // hanging forever.
        this._clearActiveWedgeTimer();

        const now = this.clock();
        this.incidents.record({
            kind: 'wedge_detected',
            dispatchId,
            epoch: this.epoch,
            stateFrom: this.state,
            details: { reason, last_progress_at: this.activeDispatch.lastProgressAt },
        });
        this._transition('silence_timeout', { occurredAt: now }); // DISPATCHING -> SUSPECT

        const killResult = typeof this.runtime.requestKill === 'function'
            ? this.runtime.requestKill()
            : { requested: false, reason: 'runtime_has_no_requestKill' };

        this.incidents.record({
            kind: killResult.requested ? 'kill_ordered' : 'kill_skipped',
            dispatchId,
            epoch: this.epoch,
            stateFrom: STATES.SUSPECT,
            details: { reason: reason, kill_result: killResult },
        });

        if (killResult.requested) {
            this._recordIntensityTimestamp(now);
            this._transition('kill_ordered', { occurredAt: now }); // SUSPECT -> RESPAWNING
        } else {
            // Either runtime doesn't support kill (edge case) or the process
            // was already dead. Treat both as process_already_dead — main.js's
            // restart path will eventually bring a new Claude. Record the
            // recovery event against the intensity ring so tight crash loops
            // through this branch still trip intensity_exhausted (prior bug:
            // only the kill_ordered branch bumped the counter).
            this._recordIntensityTimestamp(now);
            this._transition('process_already_dead', { occurredAt: now }); // SUSPECT -> RESPAWNING
        }

        this._dispatchAwaitingReplay = { dispatchId, reason };
    }

    _recordIntensityTimestamp(ts) {
        const ring = this._loadIntensityRing();
        ring.push(ts);
        // Keep the ring bounded — we only need enough history for the 10-min window.
        const trimmed = ring.slice(-INTENSITY_RING_MAX);
        this.store.setStateValue(INTENSITY_STATE_KEY, JSON.stringify(trimmed));
    }

    _loadIntensityRing() {
        const raw = this.store.getStateValue(INTENSITY_STATE_KEY, '[]');
        try {
            const arr = JSON.parse(raw);
            return Array.isArray(arr) ? arr : [];
        } catch {
            return [];
        }
    }

    _subscribeBridgeReady() {
        if (!this.channelManager || typeof this.channelManager.on !== 'function') return;
        if (this._bridgeReadyHandler) return;
        this._bridgeReadyHandler = () => this._onBridgeReady();
        this.channelManager.on('bridge_ready', this._bridgeReadyHandler);
    }

    _unsubscribeBridgeReady() {
        if (!this.channelManager || typeof this.channelManager.off !== 'function') return;
        if (!this._bridgeReadyHandler) return;
        this.channelManager.off('bridge_ready', this._bridgeReadyHandler);
        this._bridgeReadyHandler = null;
    }

    /**
     * PR2: triggered when channel-bridge.cjs emits its post-mcp.connect() ready
     * envelope. If a dispatch was left in flight by a wedge or crash, attempt
     * the replay FIRST (while still in RESPAWNING) so intensity_exhausted and
     * replay-cap decisions happen from the right state. Only after the replay
     * resolution do we walk the supervisor back to IDLE (if applicable).
     */
    _onBridgeReady() {
        if (this._shutdown) return;

        // 1. Replay decision (if any) while still in RESPAWNING state.
        if (this._dispatchAwaitingReplay) {
            const { dispatchId, reason } = this._dispatchAwaitingReplay;
            this._dispatchAwaitingReplay = null;
            this._retryActiveDispatch(dispatchId, reason);
            // _retryActiveDispatch handles all state transitions out of RESPAWNING:
            //   - allowed: activates next (state via _activateNext → DISPATCHING)
            //   - cap/effect blocked: _completeDispatch transitions back to IDLE
            //   - intensity exhausted: transitions to HARD_FAILED
            return;
        }

        // 2. Normal/fast path (no wedge): RESPAWNING -> STARTING -> VERIFYING -> IDLE.
        if (this.state === STATES.RESPAWNING) {
            this._transition('respawn_ok', { occurredAt: this.clock() });
        }
        if (this.state === STATES.STARTING) {
            this._transition('bridge_connected', { occurredAt: this.clock() });
        }
        if (this.state === STATES.VERIFYING) {
            this._transition('verify_skipped', { occurredAt: this.clock() });
        }

        // 3. Drain any dispatches that waited while the bridge was offline.
        // Includes two populations:
        //   (a) recovery-adopted prior-epoch orphans pushed onto this.queue
        //   (b) fresh enqueues made while channelManager.connected===false
        //       that took the IDLE branch in enqueue() but were blocked by
        //       _activateNext's connectivity gate — those rows are in the
        //       DB as QUEUED but not on this.queue, so we can't rely on
        //       this.queue.length here. _activateNext()'s empty-queue
        //       fallback scans the DB for queued rows and handles this case.
        if (this.state === STATES.IDLE && !this.activeDispatch) {
            this._activateNext();
        }

        // 4. First-bridge-ready: fire the startup probe. Deferred from
        // supervisor.start() so the probe's enqueue doesn't drain any
        // recovered orphan queue through a disconnected bridge on cold boot.
        this._fireStartupProbe();
    }

    _retryActiveDispatch(dispatchId, reason) {
        const row = this.store.getDispatch(dispatchId);
        if (!row) {
            // Dispatch vanished (e.g., manual admin cleanup). Nothing to do.
            return;
        }
        if (TERMINAL_DISPATCH_STATES.has(row.state)) {
            // Dispatch was already completed by some other path (e.g., the
            // abandon-safety-net timer fired before bridge_ready). Honour that.
            return;
        }

        // Intensity budget check. Uses policy.intensityExhausted (burst OR window).
        const now = this.clock();
        const ring = this._loadIntensityRing();
        if (intensityExhausted(ring, now)) {
            this.incidents.record({
                kind: 'intensity_exhausted',
                dispatchId,
                epoch: this.epoch,
                stateFrom: this.state,
                details: { reason, intensity_count: ring.length, ring: ring.slice(-5) },
            });
            this._transition('intensity_exhausted', { occurredAt: now }); // RESPAWNING/IDLE -> HARD_FAILED
            this._emitSystemNotice(dispatchId, 'intensity_exhausted');
            this._completeDispatch(dispatchId, DISPATCH_STATES.FAILED, 'intensity_exhausted');
            return;
        }

        // Replay eligibility (cap, probe, visible-effect guard).
        const verdict = canReplayDispatch(row);
        if (!verdict.allowed) {
            this.incidents.record({
                kind: 'replay_not_allowed',
                dispatchId,
                epoch: this.epoch,
                details: { wedge_reason: reason, verdict_reason: verdict.reason },
            });
            this._emitSystemNotice(dispatchId, verdict.reason);
            this._completeDispatch(dispatchId, DISPATCH_STATES.FAILED, `replay_not_allowed:${verdict.reason}`);
            return;
        }

        // Same-dispatch replay: bump replay_count, reset lifecycle columns,
        // re-queue so _activateNext() re-sends the payload. Keeps the same
        // dispatchId intact so the scheduler's awaitOutcome() still resolves
        // on the original id.
        this.store.incrementReplayCount(dispatchId);
        this.store.resetDispatchToQueued(dispatchId, this.epoch);
        this.incidents.record({
            kind: 'dispatch_replay_started',
            dispatchId,
            epoch: this.epoch,
            details: {
                wedge_reason: reason,
                replay_count_after: (row.replay_count || 0) + 1,
                replay_cap: row.replay_cap,
            },
        });

        // Walk the supervisor back to IDLE so _activateNext() can legitimately
        // transition IDLE -> DISPATCHING. Use the existing PR1 sequence:
        //   RESPAWNING -> STARTING -> VERIFYING -> IDLE.
        const now2 = this.clock();
        if (this.state === STATES.RESPAWNING) this._transition('respawn_ok', { occurredAt: now2 });
        if (this.state === STATES.STARTING) this._transition('bridge_connected', { occurredAt: now2 });
        if (this.state === STATES.VERIFYING) this._transition('verify_skipped', { occurredAt: now2 });

        // Critical: the old activeDispatch's safety-net timer is STILL armed.
        // If we don't clear it, it will fire during the replay attempt and
        // abandon the dispatch we just re-activated. Clear before nulling.
        this._clearActiveSafetyTimer();
        this._clearActiveWedgeTimer();
        this.activeDispatch = null;
        this.queue.unshift(dispatchId); // replay goes in FRONT of any newer queued work
        this._activateNext();
    }

    _emitSystemNotice(dispatchId, reason) {
        const row = this.store.getDispatch(dispatchId);
        const chatId = row && row.chat_id;
        if (!chatId) {
            // Scheduler jobs without a chat_id: log-only, no delivery attempt.
            this.incidents.record({
                kind: 'system_notice_logged_only',
                dispatchId,
                epoch: this.epoch,
                details: { reason, chat_id: null },
            });
            return;
        }

        const text = `[system notice] Scheduled task could not be delivered. Reason: ${reason}. See logs for details.`;
        let delivered = false;
        let failureReason = null;
        try {
            const fn = typeof this.channelManager.sendToChannelUnbuffered === 'function'
                ? this.channelManager.sendToChannelUnbuffered.bind(this.channelManager)
                : this.channelManager.sendToChannel.bind(this.channelManager);
            const result = fn(chatId, text, chatId);
            // Unbuffered send returns false when the bridge is down. Treat as
            // failure so the incident record reflects reality — otherwise we'd
            // lie about emitting a notice that never reached the device.
            if (result === false) {
                failureReason = 'bridge_unavailable_on_notice';
            } else {
                delivered = true;
            }
        } catch (err) {
            failureReason = err.message || String(err);
        }

        this.incidents.record({
            kind: delivered ? 'system_notice_emitted' : 'system_notice_failed',
            dispatchId,
            epoch: this.epoch,
            details: { reason, chat_id: chatId, failure_reason: failureReason },
        });
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
            // PR2: also clear the wedge timer. Without this, every completed
            // dispatch would leave a stale setTimeout alive until silence_ms
            // elapsed. Harmless thanks to the activeDispatch guard inside
            // _handleWedge, but a real timer leak.
            this._clearActiveWedgeTimer();
            this.activeDispatch = null;
            // HARD_FAILED is terminal for the supervisor itself — no transition
            // applies. Skip to avoid a spurious invalid_transition incident.
            if (this.state !== STATES.HARD_FAILED) {
                this._transition('dispatch_terminal', { occurredAt: now });
            }
        }

        // PR2: once we're HARD_FAILED, the intensity budget has been blown
        // and any queued work should NOT auto-activate. Callers who want to
        // revive the supervisor go through an explicit manual_reset path.
        if (this.state === STATES.HARD_FAILED) {
            return;
        }

        // Always try to activate the next queued dispatch — whether this one
        // was pre-activation (e.g. bridge_unavailable) or fully active. Without
        // this, a pre-activation failure would leave the rest of the queue
        // stalled until the next external enqueue arrived.
        // _activateNext() no-ops if activeDispatch is still set, so it is
        // safe to call unconditionally.
        this._activateNext();
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
     * Post-start crash recovery.
     *
     * If the previous process died mid-dispatch, the row survives in SQLite
     * but none of the in-memory state does — no active subprocess, no wedge
     * or safety timer, no awaitOutcome resolver. Scoped to prior-epoch rows
     * (row.epoch < this.epoch) so current-epoch work is never touched, and
     * guarded by _recoveryDone so a repeated start() is a no-op.
     *
     * Per-state policy:
     *
     *   SENDING / ACTIVE (any source)
     *     → ABANDONED with reason 'orphaned_by_restart'. These rows either
     *       hit the bridge or were in the middle of it. Side-effect state
     *       is ambiguous — replay could double-commit.
     *
     *   QUEUED, source = 'channel' | 'user' | 'scheduler'
     *     → re-adopted into the current epoch (via resetDispatchToQueued)
     *       and pushed onto this.queue. Actual activation is deferred to
     *       _onBridgeReady so we don't fire-and-fail against a disconnected
     *       bridge on cold boot. Queued rows never touched Claude, so there
     *       is no side-effect ambiguity. Source matters for retry policy
     *       *elsewhere* (replay_cap, scheduler stuck-run guard), not here.
     *       Scheduler runNow() payloads go through this path too — they
     *       have no cron retry, so dropping them would silently lose a
     *       user-triggered one-off.
     *
     *   QUEUED, probe
     *     → ABANDONED. Probes are liveness tests; re-arming the OLD probe
     *       is meaningless when supervisor.start() already issues a fresh
     *       probe for this epoch.
     *
     *   QUEUED, unknown source
     *     → ABANDONED (no semantics to preserve).
     */
    _recoverOrphanedDispatches() {
        if (this._recoveryDone) return;
        this._recoveryDone = true;

        let open;
        try {
            open = this.store.listOpenDispatches();
        } catch (err) {
            this.incidents.record({
                kind: 'recovery_error',
                epoch: this.epoch,
                details: { error: err && err.message ? err.message : String(err) },
            });
            return;
        }
        if (!open || open.length === 0) return;

        const currentEpoch = this.epoch;
        const abandoned = [];
        const requeued = [];
        // If the orphan status is unsafe (kill failed for a real reason, or
        // we have no pidfile on a boot with prior-epoch open dispatches), we
        // can't safely replay queued orphans — an old Claude may still be
        // processing them. Collapse the policy to abandon-all and tag with
        // a distinct reason so operators can see why.
        const unsafe = !!this._orphanStatusUnsafe;
        const REQUEUE_SOURCES = unsafe
            ? new Set()
            : new Set(['channel', 'user', 'scheduler']);
        const abandonReason = unsafe
            ? 'orphan_status_unsafe_abandon_all'
            : 'orphaned_by_restart';

        for (const row of open) {
            if (!row || !row.dispatch_id) continue;
            if (TERMINAL_DISPATCH_STATES.has(row.state)) continue;
            if ((row.epoch || 0) >= currentEpoch) continue;

            const isReplayableQueued =
                row.state === DISPATCH_STATES.QUEUED && REQUEUE_SOURCES.has(row.source);

            try {
                if (isReplayableQueued) {
                    // Re-adopt into current epoch; next tick of _activateNext()
                    // will pick it up and send it normally.
                    this.store.resetDispatchToQueued(row.dispatch_id, currentEpoch);
                    this.queue.push(row.dispatch_id);
                    this.incidents.record({
                        kind: 'dispatch_requeued_on_recovery',
                        dispatchId: row.dispatch_id,
                        epoch: currentEpoch,
                        stateFrom: row.state,
                        stateTo: DISPATCH_STATES.QUEUED,
                        details: {
                            source: row.source,
                            prior_epoch: row.epoch || 0,
                        },
                    });
                    requeued.push(row.dispatch_id);
                } else {
                    this.store.updateDispatchState(row.dispatch_id, {
                        state: DISPATCH_STATES.ABANDONED,
                        terminalAt: this.clock(),
                        lastError: abandonReason,
                    });
                    this.incidents.record({
                        kind: 'dispatch_abandoned',
                        dispatchId: row.dispatch_id,
                        epoch: currentEpoch,
                        stateFrom: row.state,
                        stateTo: DISPATCH_STATES.ABANDONED,
                        details: {
                            error: abandonReason,
                            prior_state: row.state,
                            prior_source: row.source,
                            prior_epoch: row.epoch || 0,
                            prior_replay_count: row.replay_count || 0,
                        },
                    });
                    abandoned.push(row.dispatch_id);
                }
            } catch (err) {
                this.incidents.record({
                    kind: 'recovery_error',
                    dispatchId: row.dispatch_id,
                    epoch: currentEpoch,
                    details: {
                        error: err && err.message ? err.message : String(err),
                        prior_state: row.state,
                        prior_source: row.source,
                        prior_epoch: row.epoch || 0,
                    },
                });
            }
        }

        if (abandoned.length > 0 || requeued.length > 0) {
            this.incidents.record({
                kind: 'recovery_summary',
                epoch: currentEpoch,
                details: {
                    abandoned_count: abandoned.length,
                    requeued_count: requeued.length,
                    dispatch_ids: abandoned.slice(0, 16),
                    requeued_ids: requeued.slice(0, 16),
                },
            });
        }
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
