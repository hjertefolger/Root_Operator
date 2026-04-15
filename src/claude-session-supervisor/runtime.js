/**
 * ClaudeSessionSupervisor - Runtime
 *
 * Epoch management, epoch-scoped runtime files, orphan PID/socket cleanup.
 *
 * PR1 scope:
 *   - incrementEpoch() on each supervisor start
 *   - resolveEpochPaths(epoch) for hook + debug log paths
 *   - maintainLatestSymlinks(epoch) for backward compat tooling
 *   - cleanupOldEpochs() to cap runtime dir size
 *   - findAndKillOrphans() at startup
 *
 * PR1 does NOT spawn/kill Claude itself. That stays in main.js for now.
 * The runtime module owns the PID lifecycle tracking only.
 *
 * Design doc: ~/.root-operator/workspace/design/claude-session-supervisor-v4.md
 */

const fs = require('fs');
const path = require('path');

const RUNTIME_DIR = path.join(process.env.HOME || '', '.root-operator', 'runtime');
const PIDFILE_NAME = 'supervisor.pidfile';
const SOCKET_PATH_DEFAULT = '/tmp/root-operator-channel.sock';

const HOOK_BASENAME = 'claude-channel-hooks';
const DEBUG_BASENAME = 'claude-channel-debug';
const EPOCH_SUFFIX_MATCH = /\.e(\d+)\.(jsonl|log)$/;

const MAX_EPOCHS_KEPT = 3;

class Runtime {
    /**
     * @param {object} deps
     * @param {import('./dispatch-store').DispatchStore} deps.store
     * @param {string} [deps.runtimeDir] override runtime dir (tests)
     * @param {string} [deps.socketPath] override socket path (tests)
     * @param {() => void} [deps.onKillRequest] PR2: called by requestKill() to trigger
     *        main.js's killClaudeCode(). Runtime stays DI-pure (no direct main.js import).
     * @param {() => number|null} [deps.getClaudePid] PR2: optional probe returning the
     *        current Claude PID (or null if not running). Used to skip kill if the
     *        process already died on its own (crash path).
     */
    constructor({ store, runtimeDir = RUNTIME_DIR, socketPath = SOCKET_PATH_DEFAULT,
                  onKillRequest = null, getClaudePid = null } = {}) {
        if (!store) throw new Error('Runtime requires store');
        this.store = store;
        this.runtimeDir = runtimeDir;
        this.socketPath = socketPath;
        this.currentEpoch = null;
        this.onKillRequest = onKillRequest;
        this.getClaudePid = getClaudePid;

        fs.mkdirSync(this.runtimeDir, { recursive: true });
    }

    /**
     * PR2: ask main.js to kill the current Claude subprocess. Returns
     * { requested: true } if a kill was dispatched, { requested: false, reason }
     * otherwise (no callback wired, process already dead).
     */
    requestKill() {
        if (this.getClaudePid) {
            const pid = this.getClaudePid();
            if (!pid) return { requested: false, reason: 'process_already_dead' };
        }
        if (typeof this.onKillRequest !== 'function') {
            return { requested: false, reason: 'no_kill_callback' };
        }
        try {
            this.onKillRequest();
            return { requested: true };
        } catch (err) {
            return { requested: false, reason: err.message || 'kill_callback_threw' };
        }
    }

    /**
     * Read current epoch from supervisor_state, increment, persist, return new value.
     * Called once at supervisor startup.
     */
    incrementEpoch() {
        const current = parseInt(this.store.getStateValue('epoch', '0'), 10) || 0;
        const next = current + 1;
        this.store.setStateValue('epoch', next);
        this.currentEpoch = next;
        return next;
    }

    /**
     * Resolve runtime file paths for a given epoch.
     */
    resolveEpochPaths(epoch) {
        return {
            hookLog: path.join(this.runtimeDir, `${HOOK_BASENAME}.e${epoch}.jsonl`),
            debugLog: path.join(this.runtimeDir, `${DEBUG_BASENAME}.e${epoch}.log`),
        };
    }

    /**
     * Create empty runtime files for an epoch (idempotent).
     */
    ensureEpochFiles(epoch) {
        const { hookLog, debugLog } = this.resolveEpochPaths(epoch);
        for (const p of [hookLog, debugLog]) {
            if (!fs.existsSync(p)) {
                fs.writeFileSync(p, '');
            }
        }
        return { hookLog, debugLog };
    }

    /**
     * Maintain the stable-name symlinks pointing to the current epoch files.
     * Keeps existing tooling (e.g. ~/.root-operator/runtime/claude-channel-hooks.jsonl
     * consumed by external scripts) working without changes.
     */
    maintainLatestSymlinks(epoch) {
        const { hookLog, debugLog } = this.resolveEpochPaths(epoch);
        const stableHook = path.join(this.runtimeDir, `${HOOK_BASENAME}.jsonl`);
        const stableDebug = path.join(this.runtimeDir, `${DEBUG_BASENAME}.log`);

        for (const [stable, target] of [[stableHook, hookLog], [stableDebug, debugLog]]) {
            try {
                if (fs.existsSync(stable) || fs.lstatSync(stable, { throwIfNoEntry: false })) {
                    fs.unlinkSync(stable);
                }
            } catch (err) {
                if (err.code !== 'ENOENT') {
                    console.error(`[supervisor.runtime] failed to unlink ${stable}:`, err.message);
                }
            }
            try {
                fs.symlinkSync(path.basename(target), stable);
            } catch (err) {
                console.error(`[supervisor.runtime] failed to symlink ${stable} -> ${target}:`, err.message);
            }
        }
    }

    /**
     * Remove epoch-suffixed files older than the last N epochs.
     * Keeps runtime dir size bounded.
     */
    cleanupOldEpochs({ keep = MAX_EPOCHS_KEPT } = {}) {
        let entries;
        try {
            entries = fs.readdirSync(this.runtimeDir);
        } catch {
            return { removed: [] };
        }

        const epochs = new Set();
        for (const name of entries) {
            const m = name.match(EPOCH_SUFFIX_MATCH);
            if (m) epochs.add(parseInt(m[1], 10));
        }
        if (epochs.size <= keep) return { removed: [] };

        const sorted = [...epochs].sort((a, b) => b - a);
        const toRemove = new Set(sorted.slice(keep));
        const removed = [];

        for (const name of entries) {
            const m = name.match(EPOCH_SUFFIX_MATCH);
            if (m && toRemove.has(parseInt(m[1], 10))) {
                const full = path.join(this.runtimeDir, name);
                try {
                    fs.unlinkSync(full);
                    removed.push(full);
                } catch (err) {
                    console.error(`[supervisor.runtime] failed to delete old epoch file ${full}:`, err.message);
                }
            }
        }
        return { removed };
    }

    pidfilePath() {
        return path.join(this.runtimeDir, PIDFILE_NAME);
    }

    /**
     * Returns the orphan PID (number) if a live process is recorded in the pidfile,
     * or null otherwise. Does not kill.
     */
    detectOrphanPid() {
        const pf = this.pidfilePath();
        if (!fs.existsSync(pf)) return null;

        let raw;
        try {
            raw = fs.readFileSync(pf, 'utf8').trim();
        } catch {
            return null;
        }
        const pid = parseInt(raw, 10);
        if (!pid || isNaN(pid)) return null;

        try {
            // kill(pid, 0) probes existence without signalling
            process.kill(pid, 0);
            return pid;
        } catch {
            return null;
        }
    }

    /**
     * Kill an orphan PID found via detectOrphanPid(). Sends SIGKILL.
     * Returns { killed: true } on success or { killed: false, reason } otherwise.
     */
    killOrphanPid(pid) {
        if (!pid) return { killed: false, reason: 'no_pid' };
        try {
            process.kill(pid, 'SIGKILL');
            return { killed: true };
        } catch (err) {
            if (err.code === 'ESRCH') return { killed: false, reason: 'already_dead' };
            return { killed: false, reason: err.code || err.message };
        }
    }

    /**
     * Remove a stale socket file from a prior session.
     */
    cleanupStaleSocket() {
        if (!fs.existsSync(this.socketPath)) {
            return { removed: false, reason: 'absent' };
        }
        try {
            fs.unlinkSync(this.socketPath);
            return { removed: true };
        } catch (err) {
            return { removed: false, reason: err.code || err.message };
        }
    }

    /**
     * Clear the pidfile. Called on clean shutdown.
     */
    clearPidfile() {
        const pf = this.pidfilePath();
        if (fs.existsSync(pf)) {
            try { fs.unlinkSync(pf); } catch { /* ignore */ }
        }
    }

    /**
     * Write the current Claude PID to the pidfile. Called by main.js after spawn.
     */
    recordPid(pid) {
        if (!pid) return;
        fs.writeFileSync(this.pidfilePath(), String(pid));
    }

    /**
     * Convenience: run all boot-time cleanup steps.
     * Returns a report of what happened, for incident logging.
     */
    bootCleanup() {
        const report = {
            orphan_pid: null,
            orphan_killed: false,
            stale_socket_removed: false,
            old_epochs_removed: [],
        };

        const pid = this.detectOrphanPid();
        if (pid) {
            report.orphan_pid = pid;
            const result = this.killOrphanPid(pid);
            report.orphan_killed = result.killed;
        }
        this.clearPidfile();

        const socketResult = this.cleanupStaleSocket();
        report.stale_socket_removed = socketResult.removed;

        const epochsResult = this.cleanupOldEpochs();
        report.old_epochs_removed = epochsResult.removed;

        return report;
    }
}

module.exports = {
    Runtime,
    HOOK_BASENAME,
    DEBUG_BASENAME,
    MAX_EPOCHS_KEPT,
};
