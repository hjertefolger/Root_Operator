/**
 * Dynamic Memory - SQLite (better-sqlite3) storage for message chunks + embeddings.
 *
 * Ported from Cortex (src/database.ts) but reduced in scope:
 *  - single `memories` table (no session_turns / session_summaries / session_progress)
 *  - project_id renamed to chat_id (channel-scoped, not filesystem-scoped)
 *  - FTS5 virtual table + triggers
 *  - hybrid search via vector (cosine) and keyword (FTS5 with LIKE fallback)
 *  - SHA256-truncated content_hash for dedup
 *
 * better-sqlite3 is synchronous and ships FTS5 in its bundled SQLite.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let Database;
try {
    Database = require('better-sqlite3');
} catch (err) {
    // Keep a lazy-load failure visible but non-fatal at require time so the rest
    // of main.js can still start. Actual DB operations will throw later.
    Database = null;
}

// ============================================================================
// Init
// ============================================================================

/**
 * Open (or create) the DB at the given path. Returns a better-sqlite3 Database.
 * Also ensures the containing directory exists.
 */
function initDb(dbPath) {
    if (!Database) {
        throw new Error('better-sqlite3 is not available - was it rebuilt for Electron?');
    }
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const db = new Database(dbPath);

    // Reasonable defaults for a desktop app on a local disk.
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');

    createSchema(db);
    return db;
}

function createSchema(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS memories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            content TEXT NOT NULL,
            content_hash TEXT NOT NULL UNIQUE,
            embedding BLOB NOT NULL,
            chat_id TEXT,
            source_role TEXT NOT NULL,
            timestamp TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_memories_chat_id ON memories(chat_id);
        CREATE INDEX IF NOT EXISTS idx_memories_timestamp ON memories(timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_memories_content_hash ON memories(content_hash);

        CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
            content,
            content='memories',
            content_rowid='id'
        );

        CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
            INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
        END;

        CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
            INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.id, old.content);
        END;

        CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
            INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.id, old.content);
            INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
        END;
    `);

    ensureExternalRefColumn(db);
}

/**
 * Idempotent migration: add `external_ref` column if absent, then ensure the
 * index exists regardless of whether we added the column this run.
 *
 * Safe against concurrent opens: wraps the check-and-ALTER in an IMMEDIATE
 * transaction so two processes serialize. Also tolerates the "duplicate
 * column" error defensively in case SQLite surfaces it through a race.
 */
function ensureExternalRefColumn(db) {
    const addColumnIfMissing = db.transaction(() => {
        const info = db.prepare("PRAGMA table_info('memories')").all();
        const has = info.some(col => col.name === 'external_ref');
        if (!has) {
            try {
                db.prepare("ALTER TABLE memories ADD COLUMN external_ref TEXT").run();
            } catch (err) {
                // Benign race: another process added the column between the
                // PRAGMA and the ALTER. Re-check and accept if resolved.
                if (!/duplicate column/i.test(err.message || '')) throw err;
                const recheck = db.prepare("PRAGMA table_info('memories')").all();
                if (!recheck.some(col => col.name === 'external_ref')) throw err;
            }
        }
    });
    addColumnIfMissing.immediate();
    // Always run the index creation — idempotent, and self-heals a DB that
    // got the column via a crash-interrupted earlier migration but never
    // got the index.
    db.prepare("CREATE INDEX IF NOT EXISTS idx_memories_external_ref ON memories(external_ref)").run();
}

// ============================================================================
// Hashing / embeddings blob helpers
// ============================================================================

function hashContent(content) {
    return crypto
        .createHash('sha256')
        .update(String(content).trim())
        .digest('hex')
        .substring(0, 16);
}

function embeddingToBuffer(embedding) {
    // Float32Array -> Buffer view over the same bytes
    return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

function bufferToEmbedding(buffer) {
    // Copy into a freshly-aligned Float32Array to avoid alignment issues with
    // Node Buffers returned by better-sqlite3.
    const bytes = Buffer.from(buffer); // copy
    const f32 = new Float32Array(bytes.byteLength / 4);
    for (let i = 0; i < f32.length; i++) {
        f32[i] = bytes.readFloatLE(i * 4);
    }
    return f32;
}

// ============================================================================
// Memory CRUD
// ============================================================================

function contentExists(db, content) {
    const hash = hashContent(content);
    const row = db.prepare(`SELECT 1 FROM memories WHERE content_hash = ? LIMIT 1`).get(hash);
    return Boolean(row);
}

/**
 * Insert a memory. Returns { id, isDuplicate }.
 * memory: { content, embedding (Float32Array), chatId, sourceRole, timestamp (Date), externalRef? }
 */
function insertMemory(db, memory) {
    const hash = hashContent(memory.content);

    const existing = db.prepare(`SELECT id FROM memories WHERE content_hash = ?`).get(hash);
    if (existing) {
        return { id: existing.id, isDuplicate: true };
    }

    const info = db
        .prepare(
            `INSERT INTO memories (content, content_hash, embedding, chat_id, source_role, timestamp, external_ref)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
            memory.content,
            hash,
            embeddingToBuffer(memory.embedding),
            memory.chatId == null ? null : memory.chatId,
            memory.sourceRole,
            (memory.timestamp instanceof Date ? memory.timestamp : new Date(memory.timestamp)).toISOString(),
            memory.externalRef || null,
        );

    return { id: Number(info.lastInsertRowid), isDuplicate: false };
}

// ============================================================================
// Vector similarity
// ============================================================================

function cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    if (!denom) return 0;
    return dot / denom;
}

/**
 * Brute-force cosine similarity search.
 * chatId: string => match exactly, null => only rows with NULL chat_id,
 * undefined => no filter.
 */
function searchByVector(db, queryEmbedding, chatId, limit = 10) {
    let sql = `SELECT id, content, embedding, chat_id, source_role, timestamp FROM memories`;
    const params = [];
    if (chatId !== undefined) {
        if (chatId === null) {
            sql += ` WHERE chat_id IS NULL`;
        } else {
            sql += ` WHERE chat_id = ?`;
            params.push(chatId);
        }
    }

    const rows = db.prepare(sql).all(...params);
    if (!rows.length) return [];

    const scored = rows.map((row) => {
        const embedding = bufferToEmbedding(row.embedding);
        const similarity = cosineSimilarity(queryEmbedding, embedding);
        return {
            id: row.id,
            content: row.content,
            score: similarity,
            timestamp: new Date(row.timestamp),
            chatId: row.chat_id,
            sourceRole: row.source_role,
        };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
}

// ============================================================================
// Keyword search (FTS5 preferred, LIKE fallback)
// ============================================================================

function searchByKeyword(db, query, chatId, limit = 10) {
    const cleanQuery = String(query).replace(/['"]/g, '').trim();
    if (!cleanQuery) return [];

    try {
        return searchByFts5(db, cleanQuery, chatId, limit);
    } catch {
        return searchByLike(db, cleanQuery, chatId, limit);
    }
}

function searchByFts5(db, query, chatId, limit) {
    // Sanitize FTS5 query: tokenize, drop symbols, OR the tokens.
    const tokens = query
        .split(/\s+/)
        .map((t) => t.replace(/[^a-zA-Z0-9_]/g, ''))
        .filter((t) => t.length >= 2);
    if (!tokens.length) return [];
    const ftsQuery = tokens.map((t) => `"${t}"`).join(' OR ');

    let sql = `
        SELECT m.id, m.content, m.chat_id, m.source_role, m.timestamp,
               bm25(memories_fts) as rank
        FROM memories_fts f
        JOIN memories m ON f.rowid = m.id
        WHERE memories_fts MATCH ?
    `;
    const params = [ftsQuery];

    if (chatId !== undefined) {
        if (chatId === null) {
            sql += ` AND m.chat_id IS NULL`;
        } else {
            sql += ` AND m.chat_id = ?`;
            params.push(chatId);
        }
    }

    sql += ` ORDER BY rank LIMIT ?`;
    params.push(limit);

    const rows = db.prepare(sql).all(...params);
    return rows.map((row) => ({
        id: row.id,
        content: row.content,
        chatId: row.chat_id,
        sourceRole: row.source_role,
        timestamp: new Date(row.timestamp),
        score: Math.abs(row.rank), // BM25 returns negative scores
    }));
}

function searchByLike(db, query, chatId, limit) {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];

    const conditions = words.map(() => `LOWER(content) LIKE ?`);
    const params = words.map((w) => `%${w}%`);

    let sql = `
        SELECT id, content, chat_id, source_role, timestamp
        FROM memories
        WHERE ${conditions.join(' AND ')}
    `;

    if (chatId !== undefined) {
        if (chatId === null) {
            sql += ` AND chat_id IS NULL`;
        } else {
            sql += ` AND chat_id = ?`;
            params.push(chatId);
        }
    }

    sql += ` ORDER BY timestamp DESC LIMIT ?`;
    params.push(limit);

    const rows = db.prepare(sql).all(...params);
    return rows.map((row, index) => ({
        id: row.id,
        content: row.content,
        chatId: row.chat_id,
        sourceRole: row.source_role,
        timestamp: new Date(row.timestamp),
        score: 1 - index * 0.1,
    }));
}

// ============================================================================
// Integrity validation + recovery
// ============================================================================

const REQUIRED_TABLES = ['memories', 'memories_fts'];
const EXPECTED_EMBEDDING_DIM = 768;

function getBackupFiles(backupsDir) {
    if (!fs.existsSync(backupsDir)) return [];
    try {
        return fs
            .readdirSync(backupsDir)
            .filter((f) => /^memory-\d{8}-\d{6}\.db\.bak$/.test(f))
            .map((f) => {
                const full = path.join(backupsDir, f);
                return { path: full, mtime: fs.statSync(full).mtimeMs };
            })
            .sort((a, b) => b.mtime - a.mtime)
            .map((e) => e.path);
    } catch {
        return [];
    }
}

/**
 * Validate an open DB handle. Non-destructive.
 *
 * Returns: {
 *   valid: bool,
 *   errors: string[],    // blocking issues → DB is unsafe to use
 *   warnings: string[],  // soft issues → DB is usable but worth knowing
 *   tables: string[],
 *   integrityCheck: bool,
 *   fts5Available: bool,
 *   embeddingDimension: number|null  // null when no rows indexed yet
 * }
 */
function validateDb(db) {
    const result = {
        valid: true,
        errors: [],
        warnings: [],
        tables: [],
        integrityCheck: false,
        fts5Available: false,
        embeddingDimension: null,
    };

    try {
        const rows = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all();
        result.tables = rows.map((r) => r.name);
        for (const t of REQUIRED_TABLES) {
            if (!result.tables.includes(t)) {
                result.errors.push(`missing table: ${t}`);
                result.valid = false;
            }
        }
    } catch (err) {
        result.errors.push(`table query failed: ${err.message}`);
        result.valid = false;
    }

    try {
        const status = db.pragma('integrity_check', { simple: true });
        result.integrityCheck = status === 'ok';
        if (!result.integrityCheck) {
            result.errors.push(`integrity_check: ${status}`);
            result.valid = false;
        }
    } catch (err) {
        result.errors.push(`integrity_check threw: ${err.message}`);
        result.valid = false;
    }

    try {
        db.prepare(`SELECT 1 FROM memories_fts LIMIT 1`).get();
        result.fts5Available = true;
    } catch {
        result.fts5Available = false;
        result.warnings.push('memories_fts not queryable — keyword search will use LIKE fallback');
    }

    try {
        const row = db.prepare(`SELECT embedding FROM memories LIMIT 1`).get();
        if (row && row.embedding) {
            result.embeddingDimension = row.embedding.length / 4; // Float32 = 4 bytes
            if (result.embeddingDimension !== EXPECTED_EMBEDDING_DIM) {
                result.warnings.push(`embedding_dim=${result.embeddingDimension}, expected ${EXPECTED_EMBEDDING_DIM}`);
            }
        }
    } catch {
        // No rows yet → nothing to validate. Fresh DB is fine.
    }

    return result;
}

/**
 * Open a DB file read-only, run validateDb, close. Returns the validation
 * result without mutating the file. Useful for "should I back this up?"
 * checks before the main handle is opened.
 */
function validateDbFile(dbPath) {
    const invalidShell = (err) => ({
        valid: false,
        errors: [err],
        warnings: [],
        tables: [],
        integrityCheck: false,
        fts5Available: false,
        embeddingDimension: null,
    });
    if (!Database) return invalidShell('better-sqlite3 unavailable');
    let probe = null;
    try {
        probe = new Database(dbPath, { readonly: true, fileMustExist: true });
        const result = validateDb(probe);
        probe.close();
        return result;
    } catch (err) {
        if (probe) { try { probe.close(); } catch { /* ignore */ } }
        return invalidShell(`open failed: ${err.message}`);
    }
}

/**
 * Try to restore the DB at dbPath from the newest valid backup in backupsDir.
 * Walks newest-first, opens each backup read-only, runs validateDb, and copies
 * the first valid one over dbPath.
 *
 * CALLERS MUST close any open handle on dbPath before calling this.
 *
 * Returns: { recovered, from: backupPath|null, validationsTried, errors: string[] }
 */
function attemptRecovery(dbPath, backupsDir) {
    const result = { recovered: false, from: null, validationsTried: 0, errors: [] };
    if (!Database) {
        result.errors.push('better-sqlite3 unavailable');
        return result;
    }

    const backups = getBackupFiles(backupsDir);
    if (!backups.length) {
        result.errors.push('no backups available');
        return result;
    }

    for (const backupPath of backups) {
        result.validationsTried += 1;
        let probe = null;
        try {
            probe = new Database(backupPath, { readonly: true, fileMustExist: true });
            const v = validateDb(probe);
            probe.close();
            probe = null;

            if (v.valid) {
                // Clean stale WAL/SHM sidecars from the live-but-corrupt state
                // BEFORE overwriting the main file. Otherwise the next open in
                // WAL mode replays the old journal against the restored main,
                // silently undoing the restore or reintroducing corruption.
                for (const suffix of ['-wal', '-shm']) {
                    try { fs.unlinkSync(dbPath + suffix); } catch { /* ok if missing */ }
                }
                fs.copyFileSync(backupPath, dbPath);
                result.recovered = true;
                result.from = backupPath;
                return result;
            }
            result.errors.push(`${path.basename(backupPath)}: ${v.errors.join('; ')}`);
        } catch (err) {
            result.errors.push(`${path.basename(backupPath)}: ${err.message}`);
            if (probe) { try { probe.close(); } catch { /* ignore */ } }
        }
    }
    return result;
}

// ============================================================================
// Backup rotation
// ============================================================================

/**
 * Copy the DB file to <backupsDir>/memory-YYYYMMDD-HHMMSS.db.bak, then prune
 * to keep only the last `maxBackups` files. Returns the new backup path, or
 * null if the source DB did not exist.
 *
 * This uses a plain file copy — safe to call when no writer holds the DB
 * exclusively (WAL mode tolerates readers). For our usage we call it at app
 * start BEFORE initDb opens the file, so there is no contention.
 *
 * SCOPE: covers the "restart after bad write / power loss" corruption class.
 * Does NOT cover bulk rewrites mid-session. v1 has no bulk-rewrite operations
 * (writes are single-chunk, append-only). If future work adds re-indexing or
 * mass migration, call backupDb() at the start of that operation too.
 */
function backupDb(dbPath, backupsDir, maxBackups = 3) {
    if (!fs.existsSync(dbPath)) return null;
    fs.mkdirSync(backupsDir, { recursive: true });

    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp =
        `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
        `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const backupPath = path.join(backupsDir, `memory-${stamp}.db.bak`);

    fs.copyFileSync(dbPath, backupPath);

    // Prune oldest, keep only maxBackups.
    try {
        const files = fs
            .readdirSync(backupsDir)
            .filter((f) => /^memory-\d{8}-\d{6}\.db\.bak$/.test(f))
            .map((f) => ({ f, mtime: fs.statSync(path.join(backupsDir, f)).mtimeMs }))
            .sort((a, b) => b.mtime - a.mtime); // newest first

        for (const { f } of files.slice(maxBackups)) {
            try { fs.unlinkSync(path.join(backupsDir, f)); } catch { /* ignore */ }
        }
    } catch { /* ignore rotation errors — backup itself succeeded */ }

    return backupPath;
}

// ============================================================================
// Close
// ============================================================================

function closeDb(db) {
    if (db && db.open) {
        try { db.close(); } catch (err) { /* ignore */ }
    }
}

module.exports = {
    initDb,
    closeDb,
    backupDb,
    hashContent,
    contentExists,
    insertMemory,
    searchByVector,
    searchByKeyword,
    cosineSimilarity,
    validateDb,
    validateDbFile,
    attemptRecovery,
    getBackupFiles,
};
