/**
 * Tests for the external_ref column migration on dynamic-memory/db.js.
 * Verifies:
 *   - Migration is idempotent.
 *   - Existing rows survive and remain queryable.
 *   - New inserts can write external_ref.
 *   - Running initDb on a db that already has the column is a no-op.
 *
 * Runner: node --test --test-force-exit src/claude-session-supervisor/schema-migration.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { initDb } = require('../dynamic-memory/db');

function tempDbPath() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-schema-test-'));
    return path.join(dir, 'memory.db');
}

test('initDb on a fresh DB creates external_ref column', () => {
    const p = tempDbPath();
    const db = initDb(p);
    const cols = db.prepare("PRAGMA table_info('memories')").all().map(c => c.name);
    assert.ok(cols.includes('external_ref'), `columns: ${cols.join(',')}`);
    db.close();
});

test('migration preserves pre-existing rows (simulates upgrade)', () => {
    const p = tempDbPath();
    // Hand-create the legacy schema (without external_ref) and seed rows.
    const legacy = new Database(p);
    const legacySchema = [
        "CREATE TABLE memories (",
        "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
        "  content TEXT NOT NULL,",
        "  content_hash TEXT NOT NULL UNIQUE,",
        "  embedding BLOB NOT NULL,",
        "  chat_id TEXT,",
        "  source_role TEXT NOT NULL,",
        "  timestamp TEXT NOT NULL,",
        "  created_at TEXT DEFAULT CURRENT_TIMESTAMP",
        ")",
    ].join('\n');
    legacy.prepare(legacySchema).run();
    legacy.prepare("INSERT INTO memories (content, content_hash, embedding, source_role, timestamp) VALUES (?, ?, ?, ?, ?)")
        .run('hello', 'hash1', Buffer.alloc(4), 'user', '2026-01-01T00:00:00Z');
    legacy.close();

    // Re-open via initDb — should add column without data loss.
    const db = initDb(p);
    const cols = db.prepare("PRAGMA table_info('memories')").all().map(c => c.name);
    assert.ok(cols.includes('external_ref'));

    const row = db.prepare('SELECT id, content, external_ref FROM memories').get();
    assert.equal(row.content, 'hello');
    assert.equal(row.external_ref, null);
    db.close();
});

test('migration is idempotent (running initDb again is a no-op)', () => {
    const p = tempDbPath();
    const db1 = initDb(p);
    db1.close();
    const db2 = initDb(p); // must not throw duplicate column name
    const cols = db2.prepare("PRAGMA table_info('memories')").all().map(c => c.name);
    const count = cols.filter(c => c === 'external_ref').length;
    assert.equal(count, 1);
    db2.close();
});

test('can insert with external_ref after migration', () => {
    const p = tempDbPath();
    const db = initDb(p);
    db.prepare("INSERT INTO memories (content, content_hash, embedding, source_role, timestamp, external_ref) VALUES (?, ?, ?, ?, ?, ?)")
        .run('x', 'hashX', Buffer.alloc(4), 'user', '2026-01-01T00:00:00Z', 'reply:d1:0');
    const row = db.prepare('SELECT external_ref FROM memories WHERE content_hash = ?').get('hashX');
    assert.equal(row.external_ref, 'reply:d1:0');
    db.close();
});

test('external_ref index exists', () => {
    const p = tempDbPath();
    const db = initDb(p);
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='memories'").all().map(r => r.name);
    assert.ok(indexes.includes('idx_memories_external_ref'), `got indexes: ${indexes.join(',')}`);
    db.close();
});
