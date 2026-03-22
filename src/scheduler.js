/**
 * ROOT OPERATOR — PERSISTENT CRON SCHEDULER
 *
 * Manages scheduled jobs that survive Claude session rotation, context
 * compression, and app restarts. Jobs are persisted in electron-store
 * and fire prompts into Claude via channelManager.sendToChannel().
 */
const cron = require('node-cron');
const crypto = require('crypto');

class Scheduler {
    constructor(store, channelManager) {
        this.store = store;
        this.channelManager = channelManager;
        this.timers = new Map(); // jobId -> cron task
    }

    /**
     * Load all persisted jobs and start their timers.
     */
    start() {
        const jobs = this._getJobs();
        let started = 0;
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
        for (const [id, task] of this.timers) {
            task.stop();
        }
        this.timers.clear();
        console.log('[Scheduler] All timers stopped');
    }

    /**
     * Create a new scheduled job.
     */
    addJob({ name, cronExpr, prompt, chatId }) {
        if (!cron.validate(cronExpr)) {
            throw new Error(`Invalid cron expression: ${cronExpr}`);
        }

        const job = {
            id: crypto.randomUUID(),
            name: name || 'Untitled job',
            cron: cronExpr,
            prompt,
            chatId: chatId || null,
            enabled: true,
            createdAt: new Date().toISOString(),
            lastRun: null,
            lastResult: null,
        };

        const jobs = this._getJobs();
        jobs.push(job);
        this._saveJobs(jobs);
        this._startTimer(job);

        console.log(`[Scheduler] Created job "${job.name}" (${job.id}) — ${job.cron}`);
        return job;
    }

    /**
     * Remove a job by ID.
     */
    removeJob(id) {
        this._stopTimer(id);
        const jobs = this._getJobs().filter(j => j.id !== id);
        this._saveJobs(jobs);
        console.log(`[Scheduler] Removed job ${id}`);
        return true;
    }

    /**
     * Enable or disable a job.
     */
    toggleJob(id, enabled) {
        const jobs = this._getJobs();
        const job = jobs.find(j => j.id === id);
        if (!job) throw new Error(`Job not found: ${id}`);

        job.enabled = enabled;
        this._saveJobs(jobs);

        if (enabled) {
            this._startTimer(job);
        } else {
            this._stopTimer(id);
        }

        console.log(`[Scheduler] Job "${job.name}" ${enabled ? 'enabled' : 'disabled'}`);
        return job;
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
            chatId: job.chatId,
            enabled: job.enabled,
            createdAt: job.createdAt,
            lastRun: job.lastRun,
            lastResult: job.lastResult,
        }));
    }

    /**
     * Fire a job: inject its prompt into Claude via the channel.
     */
    _fireJob(job) {
        if (!this.channelManager) {
            console.error(`[Scheduler] No channelManager — cannot fire job "${job.name}"`);
            this._updateJobResult(job.id, 'error');
            return;
        }

        const sent = this.channelManager.sendToChannel(
            '__scheduler__',
            `[Scheduled: ${job.name}]\n\n${job.prompt}`,
            '__scheduler__'
        );

        if (sent) {
            console.log(`[Scheduler] Fired job "${job.name}"`);
            this._updateJobResult(job.id, 'success');
        } else {
            console.error(`[Scheduler] Failed to send job "${job.name}" — bridge not connected`);
            this._updateJobResult(job.id, 'error');
        }
    }

    // --- Internal helpers ---

    _getJobs() {
        return this.store.get('scheduler-jobs', []);
    }

    _saveJobs(jobs) {
        this.store.set('scheduler-jobs', jobs);
    }

    _updateJobResult(id, result) {
        const jobs = this._getJobs();
        const job = jobs.find(j => j.id === id);
        if (job) {
            job.lastRun = new Date().toISOString();
            job.lastResult = result;
            this._saveJobs(jobs);
        }
    }

    _startTimer(job) {
        this._stopTimer(job.id); // Clear any existing timer

        const task = cron.schedule(job.cron, () => {
            this._fireJob(job);
        });

        this.timers.set(job.id, task);
    }

    _stopTimer(id) {
        const task = this.timers.get(id);
        if (task) {
            task.stop();
            this.timers.delete(id);
        }
    }
}

module.exports = { Scheduler };
