/**
 * ROOT OPERATOR — PERSISTENT CRON SCHEDULER
 *
 * Manages scheduled jobs that survive Claude session rotation, context
 * compression, and app restarts. Jobs are persisted in electron-store
 * and fire prompts into Claude via channelManager.sendToChannel().
 *
 * Patterns adapted from a2n desktop cron implementation:
 * - Exponential error backoff with consecutive error tracking
 * - Stale run detection and cleanup on startup
 * - Job state machine (idle → running → completed/error)
 * - Serialized CRUD via async lock
 * - Event emission for UI observability
 */
const cron = require('node-cron');
const crypto = require('crypto');
const EventEmitter = require('events');

const MAX_JOBS = 50;
const MAX_PROMPT_SIZE = 50_000; // 50KB
const STUCK_RUN_MS = 2 * 60 * 60 * 1000; // 2 hours
const MIN_REFIRE_GAP_MS = 5_000; // 5 seconds between same job fires
const MAX_CONSECUTIVE_ERRORS = 10; // Disable after this many

// Exponential backoff schedule for erroring jobs (inspired by a2n)
const BACKOFF_SCHEDULE_MS = [
    30_000,          // 1st error  →  30s
    60_000,          // 2nd error  →  1 min
    5 * 60_000,      // 3rd error  →  5 min
    15 * 60_000,     // 4th error  → 15 min
    60 * 60_000,     // 5th+ error → 60 min
];

function errorBackoffMs(consecutiveErrors) {
    const idx = Math.min(consecutiveErrors - 1, BACKOFF_SCHEDULE_MS.length - 1);
    return BACKOFF_SCHEDULE_MS[Math.max(0, idx)];
}

// Default silence budgets for scheduler jobs when they hand a dispatch off
// to the supervisor. Long-running jobs like Night Lab routinely run 30+
// minutes without hook activity (big tool chains); shorter jobs should
// surface wedge faster. The jobSilenceFor() helper picks a budget.
const SUPERVISOR_SILENCE_MS = {
    'night lab': 30 * 60_000,
    'signal': 10 * 60_000,
    'sleep cycle': 5 * 60_000,
    default: 5 * 60_000,
};

function jobSilenceFor(job) {
    if (job && typeof job.silenceMs === 'number' && job.silenceMs > 0) {
        return job.silenceMs;
    }
    const name = (job && job.name ? String(job.name) : '').toLowerCase();
    for (const key of Object.keys(SUPERVISOR_SILENCE_MS)) {
        if (key !== 'default' && name.includes(key)) {
            return SUPERVISOR_SILENCE_MS[key];
        }
    }
    return SUPERVISOR_SILENCE_MS.default;
}

class Scheduler extends EventEmitter {
    /**
     * @param {object} store electron-store-like (get/set)
     * @param {object} channelManager legacy transport (still used for direct sends)
     * @param {import('./claude-session-supervisor/orchestrator').ClaudeSessionSupervisor} [supervisor]
     *        Optional. When provided, _fireJob routes scheduled prompts through
     *        the supervisor and marks lastRun/lastResult based on the real
     *        terminal outcome (Stop/StopFailure/abandoned) instead of
     *        socket-write-returned-true.
     */
    constructor(store, channelManager, supervisor = null) {
        super();
        this.store = store;
        this.channelManager = channelManager;
        this.supervisor = supervisor;
        this.timers = new Map(); // jobId -> cron task
        this._lock = Promise.resolve(); // Async queue lock for serialized CRUD
        this._lastFireTimes = new Map(); // jobId -> timestamp (refire gap)
    }

    /**
     * Load all persisted jobs, clean stale state, and start timers.
     */
    start() {
        const jobs = this._getJobs();
        let started = 0;
        let cleaned = 0;

        // Clean stale running state from previous crashes
        for (const job of jobs) {
            if (job.runningAt) {
                const staleMs = Date.now() - new Date(job.runningAt).getTime();
                if (staleMs > STUCK_RUN_MS || isNaN(staleMs)) {
                    job.runningAt = null;
                    cleaned++;
                }
            }
        }

        if (cleaned > 0) {
            this._saveJobs(jobs);
            console.log(`[Scheduler] Cleaned ${cleaned} stale running states`);
        }

        for (const job of jobs) {
            if (job.enabled) {
                this._startTimer(job);
                started++;
            }
        }

        if (jobs.length > 0) {
            console.log(`[Scheduler] Loaded ${jobs.length} jobs, started ${started}`);
        }
    }

    /**
     * Stop all running timers. Called on app quit.
     */
    stopAll() {
        for (const [, task] of this.timers) {
            task.stop();
        }
        this.timers.clear();
        this._lastFireTimes.clear();
        console.log('[Scheduler] All timers stopped');
    }

    /**
     * Create a new scheduled job.
     */
    async addJob({ name, cronExpr, prompt, chatId }) {
        return this._withLock(() => {
            // Validate cron expression
            if (!cron.validate(cronExpr)) {
                throw new Error(`Invalid cron expression: ${cronExpr}`);
            }

            // Validate name
            if (!name || typeof name !== 'string' || name.trim().length === 0) {
                throw new Error('Job name is required');
            }

            // Validate prompt
            if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
                throw new Error('Prompt is required');
            }

            if (prompt.length > MAX_PROMPT_SIZE) {
                throw new Error(`Prompt too large (${prompt.length} chars, max ${MAX_PROMPT_SIZE})`);
            }

            // Check job limit
            const jobs = this._getJobs();
            if (jobs.length >= MAX_JOBS) {
                throw new Error(`Maximum ${MAX_JOBS} jobs reached. Delete a job first.`);
            }

            // Duplicate detection (same name + same cron = likely duplicate)
            const duplicate = jobs.find(j => j.name === name.trim() && j.cron === cronExpr);
            if (duplicate) {
                throw new Error(`A job named "${name}" with schedule "${cronExpr}" already exists (${duplicate.id})`);
            }

            const job = {
                id: crypto.randomUUID(),
                name: name.trim(),
                cron: cronExpr,
                prompt,
                chatId: chatId || null,
                enabled: true,
                createdAt: new Date().toISOString(),
                lastRun: null,
                lastResult: null,
                lastError: null,
                lastDurationMs: null,
                consecutiveErrors: 0,
                runningAt: null,
            };

            jobs.push(job);
            this._saveJobs(jobs);
            this._startTimer(job);

            this._emit('added', job);
            console.log(`[Scheduler] Created job "${job.name}" (${job.id}) — ${job.cron}`);
            return job;
        });
    }

    /**
     * Remove a job by ID.
     */
    async removeJob(id) {
        return this._withLock(() => {
            const jobs = this._getJobs();
            const job = jobs.find(j => j.id === id);
            if (!job) throw new Error(`Job not found: ${id}`);

            this._stopTimer(id);
            const filtered = jobs.filter(j => j.id !== id);
            this._saveJobs(filtered);

            this._emit('removed', job);
            console.log(`[Scheduler] Removed job "${job.name}" (${id})`);
            return true;
        });
    }

    /**
     * Enable or disable a job.
     */
    async toggleJob(id, enabled) {
        return this._withLock(() => {
            const jobs = this._getJobs();
            const job = jobs.find(j => j.id === id);
            if (!job) throw new Error(`Job not found: ${id}`);

            job.enabled = enabled;

            // Reset error state when re-enabling
            if (enabled) {
                job.consecutiveErrors = 0;
                job.lastError = null;
            }

            this._saveJobs(jobs);

            if (enabled) {
                this._startTimer(job);
            } else {
                this._stopTimer(id);
            }

            this._emit('toggled', job);
            console.log(`[Scheduler] Job "${job.name}" ${enabled ? 'enabled' : 'disabled'}`);
            return job;
        });
    }

    /**
     * Manually trigger a job immediately (regardless of schedule).
     */
    async runNow(id) {
        const jobs = this._getJobs();
        const job = jobs.find(j => j.id === id);
        if (!job) throw new Error(`Job not found: ${id}`);

        console.log(`[Scheduler] Manual trigger: "${job.name}"`);
        await this._fireJob(job);
        return true;
    }

    /**
     * List all jobs with their current state.
     */
    listJobs() {
        return this._getJobs().map(job => ({
            id: job.id,
            name: job.name,
            cron: job.cron,
            prompt: job.prompt.length > 120 ? job.prompt.substring(0, 120) + '...' : job.prompt,
            fullPromptLength: job.prompt.length,
            chatId: job.chatId,
            enabled: job.enabled,
            createdAt: job.createdAt,
            lastRun: job.lastRun,
            lastResult: job.lastResult,
            lastError: job.lastError,
            lastDurationMs: job.lastDurationMs,
            consecutiveErrors: job.consecutiveErrors,
            running: !!job.runningAt,
        }));
    }

    /**
     * Fire a job: inject its prompt into Claude via the channel.
     */
    async _fireJob(job) {
        // Refire gap protection
        const lastFire = this._lastFireTimes.get(job.id);
        if (lastFire && Date.now() - lastFire < MIN_REFIRE_GAP_MS) {
            console.log(`[Scheduler] Skipping "${job.name}" — too soon since last fire`);
            return;
        }

        // Check if already running (stuck run protection)
        if (job.runningAt) {
            const runningMs = Date.now() - new Date(job.runningAt).getTime();
            if (runningMs < STUCK_RUN_MS) {
                console.log(`[Scheduler] Skipping "${job.name}" — still running (${Math.round(runningMs / 1000)}s)`);
                return;
            }
            // Stale run — clear it and proceed
            console.log(`[Scheduler] Clearing stale run for "${job.name}" (${Math.round(runningMs / 1000)}s)`);
        }

        // Error backoff check
        if (job.consecutiveErrors > 0 && job.lastRun) {
            const backoff = errorBackoffMs(job.consecutiveErrors);
            const elapsed = Date.now() - new Date(job.lastRun).getTime();
            if (elapsed < backoff) {
                return; // Still in backoff window, silently skip
            }
        }

        // Auto-disable after too many consecutive errors
        if (job.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            console.error(`[Scheduler] Auto-disabling "${job.name}" after ${MAX_CONSECUTIVE_ERRORS} consecutive errors`);
            await this.toggleJob(job.id, false);
            return;
        }

        const startedAt = Date.now();
        this._lastFireTimes.set(job.id, startedAt);

        // Mark as running
        this._updateJobField(job.id, { runningAt: new Date().toISOString() });
        this._emit('started', job);

        const payload = `[Scheduled: ${job.name}]\n\n${job.prompt}`;

        if (this.supervisor) {
            // PR1 observe-only: supervisor takes ownership of the dispatch
            // lifecycle and resolves awaitOutcome() only when Claude emits
            // Stop / StopFailure / abandoned. This replaces the previous
            // "socket write returned true = success" lie that caused the
            // 2026-04-15 overnight silent-failure incident.
            let dispatchId;
            try {
                ({ dispatchId } = this.supervisor.enqueue({
                    source: 'scheduler',
                    sourceId: job.id,
                    payload,
                    silenceMs: jobSilenceFor(job),
                }));
            } catch (err) {
                console.error(`[Scheduler] supervisor.enqueue failed for "${job.name}": ${err.message}`);
                this._completeJob(job.id, 'error', `supervisor_enqueue: ${err.message}`, startedAt);
                return;
            }

            console.log(`[Scheduler] Dispatched "${job.name}" as ${dispatchId}`);

            try {
                const outcome = await this.supervisor.awaitOutcome(dispatchId);
                if (outcome.state === 'completed') {
                    this._completeJob(job.id, 'success', null, startedAt);
                } else {
                    this._completeJob(job.id, 'error', `${outcome.state}: ${outcome.error || 'unknown'}`, startedAt);
                }
            } catch (err) {
                this._completeJob(job.id, 'error', `supervisor_await: ${err.message}`, startedAt);
            }
            return;
        }

        // Legacy path (no supervisor wired yet): behavior unchanged — send and
        // trust the boolean return. Remove this branch in PR2 when supervisor
        // is mandatory.
        if (!this.channelManager) {
            console.error(`[Scheduler] No channelManager — cannot fire "${job.name}"`);
            this._completeJob(job.id, 'error', 'No channel manager available', startedAt);
            return;
        }

        const sent = this.channelManager.sendToChannel('__scheduler__', payload, '__scheduler__');

        if (sent) {
            console.log(`[Scheduler] Fired "${job.name}"`);
            this._completeJob(job.id, 'success', null, startedAt);
        } else {
            console.error(`[Scheduler] Failed to send "${job.name}" — bridge not connected`);
            this._completeJob(job.id, 'error', 'Bridge not connected', startedAt);
        }
    }

    // --- Internal helpers ---

    _getJobs() {
        const jobs = this.store.get('scheduler-jobs', []);
        // Filter out corrupted entries
        return jobs.filter(j => j && typeof j === 'object' && j.id);
    }

    _saveJobs(jobs) {
        this.store.set('scheduler-jobs', jobs);
    }

    _updateJobField(id, fields) {
        const jobs = this._getJobs();
        const job = jobs.find(j => j.id === id);
        if (job) {
            Object.assign(job, fields);
            this._saveJobs(jobs);
        }
    }

    _completeJob(id, result, error, startedAt) {
        const jobs = this._getJobs();
        const job = jobs.find(j => j.id === id);
        if (job) {
            job.lastRun = new Date().toISOString();
            job.lastResult = result;
            job.lastError = error || null;
            job.lastDurationMs = startedAt ? Date.now() - startedAt : null;
            job.runningAt = null;

            if (result === 'error') {
                job.consecutiveErrors = (job.consecutiveErrors || 0) + 1;
            } else {
                job.consecutiveErrors = 0;
            }

            this._saveJobs(jobs);
            this._emit('completed', job);
        }
    }

    _startTimer(job) {
        this._stopTimer(job.id);

        try {
            const task = cron.schedule(job.cron, () => {
                this._fireJob(job).catch(err => {
                    console.error(`[Scheduler] Unhandled error firing "${job.name}": ${err.message}`);
                });
            });

            this.timers.set(job.id, task);
        } catch (err) {
            console.error(`[Scheduler] Failed to start timer for "${job.name}": ${err.message}`);
        }
    }

    _stopTimer(id) {
        const task = this.timers.get(id);
        if (task) {
            task.stop();
            this.timers.delete(id);
        }
    }

    _emit(action, job) {
        try {
            this.emit('job', { action, jobId: job.id, name: job.name, ts: new Date().toISOString() });
        } catch {
            // Swallow event handler errors
        }
    }

    /**
     * Async lock: serializes CRUD operations to prevent race conditions.
     */
    _withLock(fn) {
        const next = this._lock.then(() => fn());
        this._lock = next.catch(() => {}); // Don't let errors break the chain
        return next;
    }
}

module.exports = { Scheduler, jobSilenceFor };
