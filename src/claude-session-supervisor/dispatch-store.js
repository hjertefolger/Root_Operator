/**
 * ClaudeSessionSupervisor - Dispatch Store
 *
 * SQLite-backed persistence for dispatches, effects, and incidents.
 *
 * Design doc: ~/.root-operator/workspace/design/claude-session-supervisor-v4.md
 *
 * Three tables:
 *   - dispatches: every prompt injected into Claude. State machine:
 *     queued -> sending -> active -> {completed | failed | abandoned}
 *   - effects: side effects produced by a dispatch (reply, memory_*, attachment,
 *     scheduler_tool, system_notice). Ledger for dedupe + reconcile-on-recovery.
 *     UNIQUE(dispatch_id, ordinal, kind).
 *   - incidents: structured log of state transitions and supervisor events.
 *
 * PR1 scope: schema + CRUD. No recovery/reconcile logic yet (PR3-4).
 */

const fs = require('fs');
const path = require('path');

let Database;
try {
    Database = require('better-sqlite3');
} catch (err) {
    Database = null;
}

class DispatchStore {
    constructor(dbPath) {
        if (!Database) {
            throw new Error('better-sqlite3 is not available - was it rebuilt for Electron?');
        }
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });

        this.db = new Database(dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');
        this.db.pragma('foreign_keys = ON');

        this._createSchema();
        this._prepareStatements();
    }

    _createSchema() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS dispatches (
                dispatch_id TEXT PRIMARY KEY,
                source TEXT NOT NULL,
                source_id TEXT,
                chat_id TEXT,
                payload TEXT NOT NULL,
                silence_ms INTEGER NOT NULL,
                replay_cap INTEGER NOT NULL,
                replay_count INTEGER NOT NULL DEFAULT 0,
                state TEXT NOT NULL,
                epoch INTEGER,
                enqueued_at INTEGER NOT NULL,
                sending_at INTEGER,
                activated_at INTEGER,
                terminal_at INTEGER,
                last_progress_at INTEGER,
                visible_effect_count INTEGER NOT NULL DEFAULT 0,
                last_error TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_dispatches_state ON dispatches(state, enqueued_at);
            CREATE INDEX IF NOT EXISTS idx_dispatches_epoch ON dispatches(epoch);

            CREATE TABLE IF NOT EXISTS effects (
                effect_id TEXT PRIMARY KEY,
                dispatch_id TEXT NOT NULL,
                ordinal INTEGER NOT NULL,
                kind TEXT NOT NULL,
                payload_hash TEXT,
                status TEXT NOT NULL,
                prepared_at INTEGER NOT NULL,
                committed_at INTEGER,
                external_ref TEXT,
                UNIQUE(dispatch_id, ordinal, kind)
            );

            CREATE INDEX IF NOT EXISTS idx_effects_dispatch ON effects(dispatch_id);
            CREATE INDEX IF NOT EXISTS idx_effects_status ON effects(status);

            CREATE TABLE IF NOT EXISTS incidents (
                incident_id INTEGER PRIMARY KEY AUTOINCREMENT,
                epoch INTEGER,
                kind TEXT NOT NULL,
                state_from TEXT,
                state_to TEXT,
                dispatch_id TEXT,
                details_json TEXT NOT NULL,
                occurred_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_incidents_occurred ON incidents(occurred_at);
            CREATE INDEX IF NOT EXISTS idx_incidents_epoch ON incidents(epoch);

            CREATE TABLE IF NOT EXISTS supervisor_state (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
        `);
    }

    _prepareStatements() {
        this._stmt = {
            insertDispatch: this.db.prepare(`
                INSERT INTO dispatches (
                    dispatch_id, source, source_id, chat_id, payload,
                    silence_ms, replay_cap, replay_count, state, epoch, enqueued_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `),
            updateDispatchState: this.db.prepare(`
                UPDATE dispatches
                SET state = ?,
                    sending_at = COALESCE(sending_at, ?),
                    activated_at = COALESCE(activated_at, ?),
                    terminal_at = ?,
                    last_progress_at = COALESCE(?, last_progress_at),
                    last_error = COALESCE(?, last_error),
                    epoch = COALESCE(?, epoch)
                WHERE dispatch_id = ?
            `),
            markProgress: this.db.prepare(`
                UPDATE dispatches SET last_progress_at = ? WHERE dispatch_id = ?
            `),
            incrementVisibleEffect: this.db.prepare(`
                UPDATE dispatches SET visible_effect_count = visible_effect_count + 1 WHERE dispatch_id = ?
            `),
            getDispatch: this.db.prepare(`
                SELECT * FROM dispatches WHERE dispatch_id = ?
            `),
            listOpenDispatches: this.db.prepare(`
                SELECT * FROM dispatches
                WHERE state IN ('queued', 'sending', 'active')
                ORDER BY enqueued_at ASC
            `),
            insertEffect: this.db.prepare(`
                INSERT INTO effects (
                    effect_id, dispatch_id, ordinal, kind, payload_hash,
                    status, prepared_at, external_ref
                ) VALUES (?, ?, ?, ?, ?, 'prepared', ?, ?)
            `),
            updateEffectCommitted: this.db.prepare(`
                UPDATE effects
                SET status = 'committed',
                    committed_at = ?,
                    external_ref = COALESCE(?, external_ref)
                WHERE effect_id = ?
            `),
            listPreparedEffects: this.db.prepare(`
                SELECT * FROM effects WHERE status = 'prepared' ORDER BY prepared_at ASC
            `),
            listEffectsForDispatch: this.db.prepare(`
                SELECT * FROM effects WHERE dispatch_id = ? ORDER BY ordinal ASC
            `),
            insertIncident: this.db.prepare(`
                INSERT INTO incidents (
                    epoch, kind, state_from, state_to, dispatch_id, details_json, occurred_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
            `),
            getStateValue: this.db.prepare(`
                SELECT value FROM supervisor_state WHERE key = ?
            `),
            upsertStateValue: this.db.prepare(`
                INSERT INTO supervisor_state (key, value) VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value
            `),
        };
    }

    insertDispatch({ dispatchId, source, sourceId, chatId, payload, silenceMs, replayCap, state, epoch, enqueuedAt }) {
        this._stmt.insertDispatch.run(
            dispatchId,
            source,
            sourceId ?? null,
            chatId ?? null,
            payload,
            silenceMs,
            replayCap,
            0,
            state,
            epoch ?? null,
            enqueuedAt
        );
    }

    updateDispatchState(dispatchId, {
        state,
        sendingAt = null,
        activatedAt = null,
        terminalAt = null,
        lastProgressAt = null,
        lastError = null,
        epoch = null,
    }) {
        this._stmt.updateDispatchState.run(
            state,
            sendingAt,
            activatedAt,
            terminalAt,
            lastProgressAt,
            lastError,
            epoch,
            dispatchId
        );
    }

    markProgress(dispatchId, ts) {
        this._stmt.markProgress.run(ts, dispatchId);
    }

    incrementVisibleEffect(dispatchId) {
        this._stmt.incrementVisibleEffect.run(dispatchId);
    }

    getDispatch(dispatchId) {
        return this._stmt.getDispatch.get(dispatchId);
    }

    listOpenDispatches() {
        return this._stmt.listOpenDispatches.all();
    }

    insertPreparedEffect({ effectId, dispatchId, ordinal, kind, payloadHash = null, preparedAt, externalRef = null }) {
        this._stmt.insertEffect.run(effectId, dispatchId, ordinal, kind, payloadHash, preparedAt, externalRef);
    }

    markEffectCommitted(effectId, committedAt, externalRef = null) {
        this._stmt.updateEffectCommitted.run(committedAt, externalRef, effectId);
    }

    listPreparedEffects() {
        return this._stmt.listPreparedEffects.all();
    }

    listEffectsForDispatch(dispatchId) {
        return this._stmt.listEffectsForDispatch.all(dispatchId);
    }

    insertIncident({ epoch = null, kind, stateFrom = null, stateTo = null, dispatchId = null, details = {}, occurredAt }) {
        this._stmt.insertIncident.run(
            epoch,
            kind,
            stateFrom,
            stateTo,
            dispatchId,
            JSON.stringify(details),
            occurredAt
        );
    }

    getStateValue(key, defaultValue = null) {
        const row = this._stmt.getStateValue.get(key);
        return row ? row.value : defaultValue;
    }

    setStateValue(key, value) {
        this._stmt.upsertStateValue.run(key, String(value));
    }

    close() {
        if (this.db && this.db.open) {
            this.db.close();
        }
    }

    _truncateForTests() {
        this.db.exec(`
            DELETE FROM dispatches;
            DELETE FROM effects;
            DELETE FROM incidents;
            DELETE FROM supervisor_state;
        `);
    }
}

module.exports = { DispatchStore };
