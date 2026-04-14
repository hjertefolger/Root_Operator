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
 * memory: { content, embedding (Float32Array), chatId, sourceRole, timestamp (Date) }
 */
function insertMemory(db, memory) {
    const hash = hashContent(memory.content);

    const existing = db.prepare(`SELECT id FROM memories WHERE content_hash = ?`).get(hash);
    if (existing) {
        return { id: existing.id, isDuplicate: true };
    }

    const info = db
        .prepare(
            `INSERT INTO memories (content, content_hash, embedding, chat_id, source_role, timestamp)
             VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
            memory.content,
            hash,
            embeddingToBuffer(memory.embedding),
            memory.chatId == null ? null : memory.chatId,
            memory.sourceRole,
            (memory.timestamp instanceof Date ? memory.timestamp : new Date(memory.timestamp)).toISOString(),
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
    let sql = `SELECT id, content, embedding, chat_id, timestamp FROM memories`;
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
        SELECT m.id, m.content, m.chat_id, m.timestamp,
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
        SELECT id, content, chat_id, timestamp
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
        timestamp: new Date(row.timestamp),
        score: 1 - index * 0.1,
    }));
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
    hashContent,
    contentExists,
    insertMemory,
    searchByVector,
    searchByKeyword,
    cosineSimilarity,
};
