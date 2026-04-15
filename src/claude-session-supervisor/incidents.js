/**
 * ClaudeSessionSupervisor - Incident Logger
 *
 * Two-sink logging for supervisor state transitions:
 *   1. SQLite incidents table (via dispatch-store)
 *   2. Append-only JSONL at ~/.root-operator/runtime/supervisor-incidents.jsonl
 *
 * Design doc: ~/.root-operator/workspace/design/claude-session-supervisor-v4.md §N-v4
 */

const fs = require('fs');
const path = require('path');

class IncidentLogger {
    /**
     * @param {object} deps
     * @param {import('./dispatch-store').DispatchStore} deps.store
     * @param {string} deps.jsonlPath absolute path for the append-only JSONL
     * @param {() => number} [deps.clock] milliseconds-since-epoch provider (injectable for tests)
     */
    constructor({ store, jsonlPath, clock }) {
        if (!store) throw new Error('IncidentLogger requires store');
        if (!jsonlPath) throw new Error('IncidentLogger requires jsonlPath');

        this.store = store;
        this.jsonlPath = jsonlPath;
        this.clock = clock || Date.now;

        fs.mkdirSync(path.dirname(jsonlPath), { recursive: true });
    }

    /**
     * Record an incident. Writes to both SQLite and JSONL synchronously.
     * Failures to write JSONL are logged to console but do not throw —
     * the SQLite row is the authoritative record.
     */
    record({ kind, stateFrom = null, stateTo = null, dispatchId = null, epoch = null, details = {} }) {
        const occurredAt = this.clock();

        this.store.insertIncident({
            epoch,
            kind,
            stateFrom,
            stateTo,
            dispatchId,
            details,
            occurredAt,
        });

        const line = JSON.stringify({
            ts: occurredAt,
            epoch,
            kind,
            state_from: stateFrom,
            state_to: stateTo,
            dispatch_id: dispatchId,
            details,
        }) + '\n';

        try {
            fs.appendFileSync(this.jsonlPath, line);
        } catch (err) {
            console.error('[supervisor.incidents] failed to append JSONL:', err.message);
        }
    }
}

module.exports = { IncidentLogger };
