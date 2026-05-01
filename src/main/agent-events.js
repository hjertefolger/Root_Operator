/**
 * ROOT OPERATOR — AGENT EVENTS
 *
 * Spawns the AX helper in `subscribe` mode and reads JSONL events on
 * stdout into a bounded ring buffer. Exposes a snapshot for the
 * `agent_recent_events` MCP tool. This is "passive awareness via poll":
 * the agent doesn't react in real time, but at any moment it can ask
 * what just happened on screen — focused window changes, selection
 * changes, value changes, app activations.
 *
 * Restart-on-exit: if the helper dies (AX permission revoked, helper
 * binary updated, etc.) we restart with exponential backoff capped at
 * 30s, so a permanently broken helper stops spamming the log.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const RING_BUFFER_DEFAULT = 50;
const RESTART_INITIAL_DELAY_MS = 500;
const RESTART_MAX_DELAY_MS = 30000;

function resolveHelperPath(deps) {
    // Explicit override (used by tests to force missing-helper paths
    // without false-positives from the source-tree fallback).
    if (deps && Object.prototype.hasOwnProperty.call(deps, 'helperPath')) {
        if (!deps.helperPath) return null;
        return fs.existsSync(deps.helperPath) ? deps.helperPath : null;
    }
    const candidates = [];
    if (deps && deps.resourcesPath) {
        candidates.push(path.join(deps.resourcesPath, 'ax-helper'));
    }
    if (deps && deps.appPath) {
        candidates.push(path.join(deps.appPath, 'build/native/ax-helper'));
    }
    candidates.push(path.join(__dirname, 'native/ax-helper/ax-helper'));
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    return null;
}

function init(deps) {
    if (!deps) {
        throw new Error('agent-events.init requires deps');
    }

    const bufferSize = Number.isFinite(deps.bufferSize) ? deps.bufferSize : RING_BUFFER_DEFAULT;
    const ring = []; // newest events appended at the end
    let child = null;
    let stopped = false;
    let restartTimer = null;
    let restartDelayMs = RESTART_INITIAL_DELAY_MS;
    let stdoutBuf = '';

    function logDebug(message) {
        if (typeof deps.logDebug === 'function') {
            deps.logDebug(message);
        }
    }

    function pushEvent(evt) {
        if (!evt || typeof evt !== 'object') return;
        ring.push(evt);
        while (ring.length > bufferSize) ring.shift();
    }

    function consumeLine(line) {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
            const parsed = JSON.parse(trimmed);
            pushEvent(parsed);
        } catch (err) {
            logDebug(`[AGENT-EVENTS] bad json: ${trimmed.slice(0, 120)}`);
        }
    }

    function onStdoutChunk(chunk) {
        stdoutBuf += chunk.toString('utf8');
        let nl;
        while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
            const line = stdoutBuf.slice(0, nl);
            stdoutBuf = stdoutBuf.slice(nl + 1);
            consumeLine(line);
        }
    }

    function clearRestartTimer() {
        if (restartTimer) {
            clearTimeout(restartTimer);
            restartTimer = null;
        }
    }

    function spawnHelper() {
        if (stopped) return;
        const helperPath = resolveHelperPath(deps);
        if (!helperPath) {
            pushEvent({ event: 'subscribe_helper_missing', ts: Date.now() / 1000 });
            return;
        }
        try {
            child = spawn(helperPath, ['subscribe'], { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (err) {
            pushEvent({ event: 'subscribe_spawn_failed', ts: Date.now() / 1000, detail: err.message });
            scheduleRestart();
            return;
        }
        stdoutBuf = '';
        child.stdout.on('data', onStdoutChunk);
        child.stderr.on('data', (chunk) => {
            logDebug(`[AGENT-EVENTS] stderr: ${chunk.toString().slice(0, 200)}`);
        });
        child.on('error', (err) => {
            logDebug(`[AGENT-EVENTS] child error: ${err && err.message}`);
        });
        child.on('close', (code, signal) => {
            child = null;
            // Drain any remaining buffered line.
            if (stdoutBuf.length > 0) {
                consumeLine(stdoutBuf);
                stdoutBuf = '';
            }
            if (stopped) return;
            // Reset backoff if the helper survived for a while; otherwise
            // grow it.
            scheduleRestart();
        });
        // Successful spawn — reset the backoff so a clean run benefits
        // from a fast retry next time something goes wrong.
        restartDelayMs = RESTART_INITIAL_DELAY_MS;
    }

    function scheduleRestart() {
        if (stopped) return;
        clearRestartTimer();
        const delay = restartDelayMs;
        restartDelayMs = Math.min(RESTART_MAX_DELAY_MS, delay * 2);
        restartTimer = setTimeout(() => {
            restartTimer = null;
            spawnHelper();
        }, delay);
        if (typeof restartTimer.unref === 'function') restartTimer.unref();
    }

    function start() {
        if (stopped) {
            stopped = false;
        }
        if (child) return;
        spawnHelper();
    }

    function stop() {
        stopped = true;
        clearRestartTimer();
        if (child) {
            try { child.kill('SIGTERM'); } catch (_) { /* ignore */ }
            child = null;
        }
    }

    function getEvents({ count, since_ms } = {}) {
        let events = ring.slice();
        if (Number.isFinite(since_ms) && since_ms > 0) {
            const cutoff = (Date.now() / 1000) - (since_ms / 1000);
            events = events.filter((e) => e && Number.isFinite(e.ts) && e.ts >= cutoff);
        }
        if (Number.isFinite(count) && count > 0) {
            events = events.slice(-count);
        }
        return events;
    }

    return {
        start,
        stop,
        getEvents,
        // Test seams
        __pushForTest: (evt) => pushEvent(evt),
        __consumeLineForTest: (line) => consumeLine(line),
        __ringForTest: () => ring.slice(),
    };
}

module.exports = {
    init,
    __test: { resolveHelperPath, RING_BUFFER_DEFAULT, RESTART_INITIAL_DELAY_MS, RESTART_MAX_DELAY_MS },
};
