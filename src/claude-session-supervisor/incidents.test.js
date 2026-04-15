/**
 * Unit tests for incidents.js.
 * Runner: node --test src/claude-session-supervisor/incidents.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DispatchStore } = require('./dispatch-store');
const { IncidentLogger } = require('./incidents');

function fixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-incidents-test-'));
    const dbPath = path.join(dir, 'claude-supervisor.db');
    const jsonlPath = path.join(dir, 'supervisor-incidents.jsonl');
    const store = new DispatchStore(dbPath);
    let now = 1000;
    const clock = () => now;
    const logger = new IncidentLogger({ store, jsonlPath, clock });
    return { dir, dbPath, jsonlPath, store, logger, advance: (ms) => { now += ms; } };
}

test('record writes to both SQLite and JSONL with same timestamp', () => {
    const { store, logger, jsonlPath } = fixture();
    logger.record({
        kind: 'supervisor_started',
        stateFrom: 'stopped',
        stateTo: 'idle',
        epoch: 1,
        details: { reason: 'boot' },
    });

    // SQLite row
    const rows = store.db.prepare('SELECT * FROM incidents').all();
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.kind, 'supervisor_started');
    assert.equal(row.state_from, 'stopped');
    assert.equal(row.state_to, 'idle');
    assert.equal(row.epoch, 1);
    assert.equal(row.occurred_at, 1000);
    assert.deepEqual(JSON.parse(row.details_json), { reason: 'boot' });

    // JSONL line
    const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const json = JSON.parse(lines[0]);
    assert.equal(json.kind, 'supervisor_started');
    assert.equal(json.ts, 1000);
    assert.deepEqual(json.details, { reason: 'boot' });

    store.close();
});

test('record supports nulls for optional fields', () => {
    const { store, logger } = fixture();
    logger.record({ kind: 'orphan_killed' });
    const rows = store.db.prepare('SELECT * FROM incidents').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state_from, null);
    assert.equal(rows[0].state_to, null);
    assert.equal(rows[0].dispatch_id, null);
    assert.equal(rows[0].epoch, null);
    store.close();
});

test('multiple records preserve order in JSONL', () => {
    const { store, logger, jsonlPath, advance } = fixture();
    logger.record({ kind: 'a' });
    advance(10);
    logger.record({ kind: 'b' });
    advance(10);
    logger.record({ kind: 'c' });
    const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(lines.map(l => l.kind), ['a', 'b', 'c']);
    assert.deepEqual(lines.map(l => l.ts), [1000, 1010, 1020]);
    store.close();
});
