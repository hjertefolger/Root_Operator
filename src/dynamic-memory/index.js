/**
 * Dynamic Memory - Facade class consumed by main.js.
 *
 * Lifecycle:
 *   - constructor(workspaceDir, resourcesPath) - no heavy work.
 *   - init(store) - open DB. Ready as soon as DB is open; no user-visible toggle.
 *   - indexMessage(role, content, chatId) - chunk, dedup, embed, insert (always on when DB is open).
 *   - searchMemory(query, opts) - hybrid search, returns array of {id, content, timestamp, score}.
 *   - saveMemory(content, chatId) - intentional write, bypasses chunker.
 *   - updateMemoryById(id, content) - re-embed + update.
 *   - deleteMemoryById(id) - hard remove.
 *   - buildContextForSpawn(query, chatId, limit, beforeTimestamp) - hybrid search -> markdown block.
 *   - close() - close DB on app quit.
 *
 * The embedder is lazy: first operation after init triggers model load.
 * Long-term / multi-modal memory is delegated to UMIO (future); this layer
 * handles agent-facing recall of prior channel messages older than the
 * channel-history tail that is already in the system prompt.
 */

const path = require('path');
const fs = require('fs');

const { initDb, closeDb, contentExists, insertMemory, getMemory, deleteMemory, updateMemory, backupDb, validateDb, validateDbFile, attemptRecovery } = require('./db');
const embeddings = require('./embeddings');
const { extractChunks, shouldExclude, getContentValue } = require('./chunker');
const { hybridSearch } = require('./search');
const { buildMemoryBlock } = require('./prompt');

const PERF_ENABLED = process.env.NODE_ENV === 'development' || process.env.DYNAMIC_MEMORY_PERF === '1';
function perfLog(msg) {
    if (PERF_ENABLED) {
        try { console.error(`[MEMORY-PERF] ${msg}`); } catch (_) { /* ignore */ }
    }
}

class DynamicMemory {
    /**
     * @param {string} workspaceDir  Root Operator workspace dir (~/.root-operator/workspace).
     *                               DB is stored at <workspaceDir>/brain/memory.db.
     * @param {string} resourcesPath Electron resourcesPath (for packaged model lookup).
     */
    constructor(workspaceDir, resourcesPath) {
        this.workspaceDir = workspaceDir;
        this.resourcesPath = resourcesPath;
        this.db = null;
        this.dbPath = null;
        this._embedderReady = false;
        this._embedderInitPromise = null;
        this._logger = null;
    }

    setLogger(fn) {
        if (typeof fn === 'function') this._logger = fn;
    }

    _log(msg) {
        if (this._logger) {
            try { this._logger(msg); } catch (_) { /* ignore */ }
        }
    }

    async init(_store) {
        // store arg kept for backwards-compatibility with main-process wiring;
        // the feature used to persist an enabled flag here, but dynamic memory
        // is now always on whenever the DB is open.
        const brainDir = path.join(this.workspaceDir, 'brain');
        const backupsDir = path.join(brainDir, 'backups');
        const dbPath = path.join(brainDir, 'memory.db');
        this.dbPath = dbPath;

        try {
            fs.mkdirSync(brainDir, { recursive: true });
            fs.mkdirSync(backupsDir, { recursive: true });
        } catch (err) {
            this._log(`[MEMORY] Failed to create brain dirs: ${err.message}`);
        }

        // Reject symlinks for brain/ and memory.db — these are app-managed state;
        // symlinks here likely mean user misconfiguration or sync-tool weirdness.
        // Failing loud is safer than silently writing into an unexpected location.
        try {
            const brainStat = fs.lstatSync(brainDir);
            if (brainStat.isSymbolicLink()) {
                this._log(`[MEMORY] brain/ is a symlink — refusing to open DB. Path: ${brainDir}`);
                this.db = null;
                return;
            }
            if (fs.existsSync(dbPath)) {
                const dbStat = fs.lstatSync(dbPath);
                if (dbStat.isSymbolicLink()) {
                    this._log(`[MEMORY] memory.db is a symlink — refusing to open. Path: ${dbPath}`);
                    this.db = null;
                    return;
                }
            }
        } catch (err) {
            this._log(`[MEMORY] lstat check failed: ${err.message}`);
        }

        // Phase 1: pre-open probe. Tells us whether the on-disk file is a
        // real, structurally-valid SQLite DB BEFORE initDb() runs
        // `CREATE TABLE IF NOT EXISTS` on it. Critical for the zero-byte /
        // foreign-file cases: otherwise initDb auto-heals the file into an
        // empty schema, validateDb passes, and the user's memory is silently
        // lost when a valid backup would have restored it.
        const existedPreOpen = fs.existsSync(dbPath);
        const preOpenValidation = existedPreOpen ? validateDbFile(dbPath) : null;
        const preOpenValid = preOpenValidation ? preOpenValidation.valid : false;
        const preExistedButInvalid = existedPreOpen && !preOpenValid;

        if (preExistedButInvalid) {
            this._log(`[MEMORY] Pre-open validation failed: ${preOpenValidation.errors.join('; ')}`);
        }

        // Phase 2: open. May throw on hard failures (disk errors, bad header).
        let openErr = null;
        try {
            this.db = initDb(dbPath);
        } catch (err) {
            this.db = null;
            openErr = err;
            this._log(`[MEMORY] Failed to open DB: ${err.message}`);
        }

        // Phase 3: post-open validation.
        const postValidation = this.db ? validateDb(this.db) : null;
        const postOpenValid = postValidation ? postValidation.valid : false;

        // Distinguish in-place repair from auto-heal-into-empty:
        //   - in-place repair preserves existing rows (e.g. missing memories_fts
        //     was re-created but `memories` still has data) — trust the live DB.
        //   - auto-heal into empty schema (zero-byte file → fresh schema, no
        //     rows) — the user's memory is gone unless we restore from backup.
        let hasRows = false;
        if (this.db && postOpenValid) {
            try {
                hasRows = Number(this.db.prepare('SELECT COUNT(*) AS c FROM memories').get().c) > 0;
            } catch { hasRows = false; }
        }

        // Phase 4: recovery decision. Trigger recovery for ANY of:
        //   - open failed outright (hard error)
        //   - open succeeded but structural validation rejected the DB
        //   - pre-open file was invalid AND auto-heal left us with no rows
        //     (i.e. the original data is gone, only a backup can restore it)
        const shouldAttemptRecovery = !this.db
            || !postOpenValid
            || (preExistedButInvalid && !hasRows);

        if (shouldAttemptRecovery) {
            if (postValidation && !postValidation.valid) {
                this._log(`[MEMORY] Integrity check FAILED: ${postValidation.errors.join('; ')}`);
            }
            // Release the (maybe auto-healed) handle so recovery can overwrite
            // the main file.
            if (this.db) { closeDb(this.db); this.db = null; }

            const recovery = attemptRecovery(dbPath, backupsDir);
            if (recovery.recovered) {
                this._log(`[MEMORY] Recovered from backup ${path.basename(recovery.from)} after ${recovery.validationsTried} probe(s)`);
                try {
                    this.db = initDb(dbPath);
                    const post = validateDb(this.db);
                    if (!post.valid) {
                        this._log(`[MEMORY] Recovered DB still invalid: ${post.errors.join('; ')}`);
                        closeDb(this.db);
                        this.db = null;
                    } else {
                        const warn = post.warnings.length ? ` (warnings: ${post.warnings.join('; ')})` : '';
                        this._log(`[MEMORY] DB ready at ${dbPath} ${warn}`);
                    }
                } catch (err2) {
                    this.db = null;
                    this._log(`[MEMORY] Failed to reopen after recovery: ${err2.message}`);
                }
            } else if (preExistedButInvalid && !openErr && postOpenValid) {
                // Auto-heal fallback: pre-open invalid, but initDb DID produce
                // a structurally-valid empty DB. Prior memories are lost
                // (none to recover) but the feature can still run. Do NOT
                // enter this branch when postOpenValid is false — that means
                // the damage runs deeper than missing objects (e.g. integrity
                // failure), and reopening would just get the same broken DB.
                this._log(`[MEMORY] No valid backup available. Starting with fresh schema (prior memories lost). Tried ${recovery.validationsTried} backup(s).`);
                try {
                    this.db = initDb(dbPath);
                    const postFresh = validateDb(this.db);
                    if (!postFresh.valid) {
                        this._log(`[MEMORY] Fresh-schema reopen did not validate: ${postFresh.errors.join('; ')}`);
                        closeDb(this.db);
                        this.db = null;
                    } else {
                        this._log(`[MEMORY] DB ready at ${dbPath} (fresh schema)`);
                    }
                } catch (err3) {
                    this.db = null;
                    this._log(`[MEMORY] Failed to reopen with fresh schema: ${err3.message}`);
                }
            } else if (openErr) {
                this._log(`[MEMORY] Recovery failed after open error. Tried ${recovery.validationsTried} backup(s). Errors: ${recovery.errors.join('; ')}`);
            } else {
                this._log(`[MEMORY] Recovery failed. Tried ${recovery.validationsTried} backup(s). Errors: ${recovery.errors.join('; ')}`);
            }
        } else {
            // No recovery needed. Two sub-cases:
            //   - clean open (preOpenValid + postOpenValid): normal case
            //   - in-place auto-heal that preserved data (preExistedButInvalid
            //     + postOpenValid + hasRows): initDb restored missing objects
            //     without touching row data. Trust the live DB, skip recovery
            //     to avoid rolling back newer rows to an older backup.
            if (preExistedButInvalid && hasRows) {
                this._log(`[MEMORY] DB auto-healed in place (missing objects restored; ${postValidation.embeddingDimension ? `data preserved, dim=${postValidation.embeddingDimension}` : 'row data preserved'})`);

                // If memories_fts was among the objects recreated, it was
                // built empty — CREATE VIRTUAL TABLE IF NOT EXISTS does NOT
                // backfill an external-content FTS from existing memories
                // rows, and `SELECT COUNT(*) FROM memories_fts` on an
                // external-content FTS reads through to the content table
                // (so it equals memories' count even when the index is empty;
                // we cannot use it to detect the drift). Always rebuild on
                // this path — it's idempotent and the path is rare.
                try {
                    this.db.prepare("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')").run();
                    this._log(`[MEMORY] Rebuilt memories_fts after in-place repair`);
                } catch (err) {
                    this._log(`[MEMORY] FTS rebuild failed (non-fatal; keyword search will use LIKE fallback): ${err.message}`);
                }
            }
            const warn = postValidation.warnings.length ? ` (warnings: ${postValidation.warnings.join('; ')})` : '';
            this._log(`[MEMORY] DB ready at ${dbPath} ${warn}`);
        }

        // Backup rotation — only when the DB existed and was structurally
        // valid BEFORE we opened it. Protects the backup ring from two
        // failure modes: (a) snapshotting a freshly-auto-healed empty DB,
        // and (b) double-snapshotting a just-recovered-from-backup state.
        //
        // Before copying we checkpoint the WAL (TRUNCATE) so the main .db
        // file contains all committed pages. If another process is holding
        // a read lock the checkpoint can partially fail (busy > 0), leaving
        // pages in the WAL — in that case we skip the backup rather than
        // ship a stale one.
        if (this.db && preOpenValid) {
            try {
                const cp = this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
                if (cp && cp.busy > 0) {
                    this._log(`[MEMORY] Skipping backup — checkpoint busy (busy=${cp.busy}, log=${cp.log}, checkpointed=${cp.checkpointed})`);
                } else {
                    const backupPath = backupDb(dbPath, backupsDir, 3);
                    if (backupPath) this._log(`[MEMORY] Backup created: ${path.basename(backupPath)}`);
                }
            } catch (err) {
                this._log(`[MEMORY] Backup rotation failed (non-fatal): ${err.message}`);
            }
        } else if (this.db) {
            this._log(`[MEMORY] Skipping backup — pre-open state was missing or invalid`);
        }
    }

    /**
     * Ready means the DB is open and dynamic memory can accept reads/writes.
     * Dynamic memory is always on when ready — there is no user-visible toggle.
     */
    isReady() {
        return Boolean(this.db);
    }

    _modelBaseDir() {
        // Two layouts to support:
        //  - Dev: <repo>/models/nomic-embed-text-v1.5
        //  - Packaged: <resourcesPath>/nomic-embed-text-v1.5
        // embeddings.initEmbedder() auto-detects owner vs flat layout inside baseDir.
        // Packaged path: extraResources puts `nomic-embed-text-v1.5` at resourcesPath root.
        const packagedParent = this.resourcesPath || '';
        const devParent = path.join(__dirname, '..', '..', 'models');

        if (fs.existsSync(path.join(devParent, 'nomic-embed-text-v1.5'))) {
            return devParent;
        }
        if (fs.existsSync(path.join(packagedParent, 'nomic-embed-text-v1.5'))) {
            return packagedParent;
        }
        // Fall back to packaged parent; initEmbedder will surface a clear error.
        return packagedParent || devParent;
    }

    /**
     * Fire-and-forget embedder warmup. Safe to call any time after init().
     * Resolves immediately if disabled; swallows errors so a failed warmup
     * never crashes the caller. Subsequent enrichment calls benefit from
     * the already-hot model.
     */
    warmup() {
        if (!this.isReady()) return Promise.resolve();
        return this._ensureEmbedder().catch((err) => {
            this._log(`[MEMORY] warmup failed: ${err && err.message ? err.message : err}`);
        });
    }

    async _ensureEmbedder() {
        if (this._embedderReady) return;
        if (this._embedderInitPromise) return this._embedderInitPromise;
        const baseDir = this._modelBaseDir();
        this._log(`[MEMORY] Initializing embedder (baseDir=${baseDir})`);
        const _perfT0 = Date.now();
        this._embedderInitPromise = (async () => {
            await embeddings.initEmbedder(baseDir);
            this._embedderReady = true;
            this._log('[MEMORY] Embedder ready');
            perfLog(`embedder cold_load=${Date.now() - _perfT0}ms`);
        })();
        try {
            await this._embedderInitPromise;
        } finally {
            this._embedderInitPromise = null;
        }
    }

    /**
     * Index a message (user or assistant). Chunks -> dedup -> embed -> insert.
     * Re-checks isReady() after each async step so a mid-operation DB close
     * wastes minimal work.
     */
    async indexMessage(role, content, chatId, { externalRef } = {}) {
        if (!this.isReady()) return;
        if (typeof content !== 'string' || !content.trim()) return;

        const effectiveRole = role === 'user' ? 'user' : 'assistant';

        // Cheap pre-filter on the whole message.
        if (shouldExclude(content) && getContentValue(content) === 0) {
            return;
        }

        const chunks = extractChunks(content, effectiveRole);
        if (!chunks.length) return;

        const _perfT0 = Date.now();
        let _perfEmbedTotal = 0;
        let _perfEmbedCount = 0;
        let _perfInsertTotal = 0;

        // Ensure embedder is ready (lazy load on first call).
        try {
            await this._ensureEmbedder();
        } catch (err) {
            this._log(`[MEMORY] Embedder init failed: ${err.message}`);
            return;
        }
        if (!this.isReady()) return;

        const ts = new Date();
        for (const chunk of chunks) {
            if (!this.isReady()) return;

            // Dedup cheap first.
            try {
                if (contentExists(this.db, chunk)) continue;
            } catch (err) {
                this._log(`[MEMORY] contentExists failed: ${err.message}`);
                continue;
            }

            // Skip content that is almost certainly noise even after chunking.
            if (shouldExclude(chunk) && getContentValue(chunk) === 0) continue;

            const _perfEmbedStart = Date.now();
            let embedding;
            try {
                embedding = await embeddings.embedPassage(chunk);
            } catch (err) {
                this._log(`[MEMORY] embedPassage failed: ${err.message}`);
                continue;
            }
            _perfEmbedTotal += Date.now() - _perfEmbedStart;
            _perfEmbedCount += 1;
            if (!this.isReady()) return;

            const _perfInsertStart = Date.now();
            try {
                insertMemory(this.db, {
                    content: chunk,
                    embedding,
                    chatId: chatId || null,
                    sourceRole: effectiveRole,
                    timestamp: ts,
                    externalRef: externalRef || null,
                });
            } catch (err) {
                // UNIQUE constraint on content_hash is the backstop for races.
                if (!/UNIQUE/i.test(err.message)) {
                    this._log(`[MEMORY] insertMemory failed: ${err.message}`);
                }
            }
            _perfInsertTotal += Date.now() - _perfInsertStart;
        }
        perfLog(`indexMessage role=${effectiveRole} chunks=${chunks.length} embed_total=${_perfEmbedTotal}ms embed_count=${_perfEmbedCount} insert_total=${_perfInsertTotal}ms total=${Date.now() - _perfT0}ms`);
    }

    /**
     * Search for relevant past chunks and format them as a markdown block.
     * Returns a string or null if nothing relevant found / feature disabled.
     */
    async buildContextForSpawn(query, chatId, limit = 5, beforeTimestamp = null) {
        if (!this.isReady()) return null;
        if (typeof query !== 'string' || query.trim().length < 3) return null;

        const _perfT0 = Date.now();

        try {
            await this._ensureEmbedder();
        } catch (err) {
            this._log(`[MEMORY] Embedder init failed (buildContext): ${err.message}`);
            return null;
        }
        if (!this.isReady()) return null;

        let results = [];
        const _perfSearchStart = Date.now();
        try {
            results = await hybridSearch(this.db, query, { chatId, limit, beforeTimestamp });
        } catch (err) {
            this._log(`[MEMORY] hybridSearch failed: ${err.message}`);
            return null;
        }
        const _perfSearchMs = Date.now() - _perfSearchStart;
        if (!results.length) {
            perfLog(`buildContextForSpawn total=${Date.now() - _perfT0}ms search=${_perfSearchMs}ms results=0 query_len=${query.length} block_len=0`);
            return null;
        }

        const block = buildMemoryBlock(results);
        perfLog(`buildContextForSpawn total=${Date.now() - _perfT0}ms search=${_perfSearchMs}ms results=${results.length} query_len=${query.length} block_len=${block ? block.length : 0}`);
        return block;
    }

    /**
     * Agent-facing search. Returns raw result rows (not formatted as a
     * markdown block) so tool callers can render ids alongside content.
     *
     * @returns {Promise<Array<{id:number, content:string, timestamp:Date, score:number, chatId:string|null, sourceRole:string}>>}
     */
    async searchMemory(query, { chatId = undefined, limit = 5, beforeTimestamp = null } = {}) {
        if (!this.isReady()) return [];
        if (typeof query !== 'string' || query.trim().length < 3) return [];

        try {
            await this._ensureEmbedder();
        } catch (err) {
            this._log(`[MEMORY] Embedder init failed (searchMemory): ${err.message}`);
            return [];
        }
        if (!this.isReady()) return [];

        try {
            return await hybridSearch(this.db, query, { chatId, limit, beforeTimestamp });
        } catch (err) {
            this._log(`[MEMORY] searchMemory failed: ${err.message}`);
            return [];
        }
    }

    /**
     * Intentional write. Bypasses the chunker — the full content is stored
     * as-is. Dedups on content-hash (returns the existing id if already
     * stored).
     */
    async saveMemory(content, { chatId = null } = {}) {
        if (!this.isReady()) throw new Error('dynamic memory not ready');
        if (typeof content !== 'string' || !content.trim()) {
            throw new Error('content must be a non-empty string');
        }

        await this._ensureEmbedder();
        if (!this.isReady()) throw new Error('dynamic memory not ready');

        const embedding = await embeddings.embedPassage(content);
        const { id, isDuplicate } = insertMemory(this.db, {
            content,
            embedding,
            chatId,
            sourceRole: 'manual',
            timestamp: new Date(),
        });
        return { id, isDuplicate };
    }

    /**
     * Update a memory's content. Re-embeds. Returns true if a row was updated.
     */
    async updateMemoryById(id, newContent) {
        if (!this.isReady()) throw new Error('dynamic memory not ready');
        if (typeof newContent !== 'string' || !newContent.trim()) {
            throw new Error('newContent must be a non-empty string');
        }

        await this._ensureEmbedder();
        if (!this.isReady()) throw new Error('dynamic memory not ready');

        const embedding = await embeddings.embedPassage(newContent);
        return updateMemory(this.db, id, newContent, embedding);
    }

    /**
     * Hard delete. Returns true if a row was removed.
     */
    deleteMemoryById(id) {
        if (!this.isReady()) throw new Error('dynamic memory not ready');
        return deleteMemory(this.db, id);
    }

    /**
     * Fetch a single memory row by id (no embedding payload).
     */
    getMemoryById(id) {
        if (!this.isReady()) return null;
        return getMemory(this.db, id);
    }

    /**
     * Non-destructive validation of the live DB handle. Returns the full
     * result object from validateDb, or a stub with errors=['db not open']
     * when the DB is unavailable. Safe to call any time after init().
     */
    healthCheck() {
        if (!this.db) {
            return {
                valid: false,
                errors: ['db not open'],
                warnings: [],
                tables: [],
                integrityCheck: false,
                fts5Available: false,
                embeddingDimension: null,
            };
        }
        return validateDb(this.db);
    }

    close() {
        try {
            closeDb(this.db);
        } catch (_) { /* ignore */ }
        this.db = null;
    }
}

module.exports = { DynamicMemory };
