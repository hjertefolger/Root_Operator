/**
 * Dynamic Memory - Facade class consumed by main.js.
 *
 * Lifecycle:
 *   - constructor(userDataPath, resourcesPath) - no heavy work.
 *   - init(store) - open DB, set enabled flag from electron-store.
 *   - indexMessage(role, content, chatId) - chunk, dedup, embed, insert.
 *   - buildContextForSpawn(query, chatId, limit) - hybrid search -> markdown block.
 *   - close() - close DB on app quit.
 *
 * The embedder is lazy: first indexMessage() after enable triggers model load.
 * Every public async method re-checks `this._enabled` to cheaply abort work
 * after a mid-operation toggle off.
 */

const path = require('path');
const fs = require('fs');

const { initDb, closeDb, contentExists, insertMemory } = require('./db');
const embeddings = require('./embeddings');
const { extractChunks, shouldExclude, getContentValue } = require('./chunker');
const { hybridSearch } = require('./search');
const { buildMemoryBlock } = require('./prompt');

const STORE_KEY = 'dynamicMemory.enabled';

class DynamicMemory {
    constructor(userDataPath, resourcesPath) {
        this.userDataPath = userDataPath;
        this.resourcesPath = resourcesPath;
        this.db = null;
        this.store = null;
        this._enabled = false;
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

    async init(store) {
        this.store = store;
        try {
            this._enabled = Boolean(store && store.get(STORE_KEY, false));
        } catch (_) {
            this._enabled = false;
        }

        const dbPath = path.join(this.userDataPath, 'dynamic-memory', 'memory.db');
        try {
            this.db = initDb(dbPath);
            this._log(`[MEMORY] DB ready at ${dbPath} (enabled=${this._enabled})`);
        } catch (err) {
            this.db = null;
            this._log(`[MEMORY] Failed to open DB: ${err.message}`);
        }
    }

    isEnabled() {
        return Boolean(this._enabled && this.db);
    }

    setEnabled(value) {
        const next = Boolean(value);
        this._enabled = next;
        if (this.store) {
            try { this.store.set(STORE_KEY, next); } catch (_) { /* ignore */ }
        }
        this._log(`[MEMORY] setEnabled(${next})`);
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

    async _ensureEmbedder() {
        if (this._embedderReady) return;
        if (this._embedderInitPromise) return this._embedderInitPromise;
        const baseDir = this._modelBaseDir();
        this._log(`[MEMORY] Initializing embedder (baseDir=${baseDir})`);
        this._embedderInitPromise = (async () => {
            await embeddings.initEmbedder(baseDir);
            this._embedderReady = true;
            this._log('[MEMORY] Embedder ready');
        })();
        try {
            await this._embedderInitPromise;
        } finally {
            this._embedderInitPromise = null;
        }
    }

    /**
     * Index a message (user or assistant). Chunks -> dedup -> embed -> insert.
     * Re-checks this._enabled after each async step so mid-operation disable
     * wastes minimal work.
     */
    async indexMessage(role, content, chatId) {
        if (!this.isEnabled()) return;
        if (typeof content !== 'string' || !content.trim()) return;

        const effectiveRole = role === 'user' ? 'user' : 'assistant';

        // Cheap pre-filter on the whole message.
        if (shouldExclude(content) && getContentValue(content) === 0) {
            return;
        }

        const chunks = extractChunks(content, effectiveRole);
        if (!chunks.length) return;

        // Ensure embedder is ready (lazy load on first call).
        try {
            await this._ensureEmbedder();
        } catch (err) {
            this._log(`[MEMORY] Embedder init failed: ${err.message}`);
            return;
        }
        if (!this.isEnabled()) return;

        const ts = new Date();
        for (const chunk of chunks) {
            if (!this.isEnabled()) return;

            // Dedup cheap first.
            try {
                if (contentExists(this.db, chunk)) continue;
            } catch (err) {
                this._log(`[MEMORY] contentExists failed: ${err.message}`);
                continue;
            }

            // Skip content that is almost certainly noise even after chunking.
            if (shouldExclude(chunk) && getContentValue(chunk) === 0) continue;

            let embedding;
            try {
                embedding = await embeddings.embedPassage(chunk);
            } catch (err) {
                this._log(`[MEMORY] embedPassage failed: ${err.message}`);
                continue;
            }
            if (!this.isEnabled()) return;

            try {
                insertMemory(this.db, {
                    content: chunk,
                    embedding,
                    chatId: chatId || null,
                    sourceRole: effectiveRole,
                    timestamp: ts,
                });
            } catch (err) {
                // UNIQUE constraint on content_hash is the backstop for races.
                if (!/UNIQUE/i.test(err.message)) {
                    this._log(`[MEMORY] insertMemory failed: ${err.message}`);
                }
            }
        }
    }

    /**
     * Search for relevant past chunks and format them as a markdown block.
     * Returns a string or null if nothing relevant found / feature disabled.
     */
    async buildContextForSpawn(query, chatId, limit = 5) {
        if (!this.isEnabled()) return null;
        if (typeof query !== 'string' || query.trim().length < 3) return null;

        try {
            await this._ensureEmbedder();
        } catch (err) {
            this._log(`[MEMORY] Embedder init failed (buildContext): ${err.message}`);
            return null;
        }
        if (!this.isEnabled()) return null;

        let results = [];
        try {
            results = await hybridSearch(this.db, query, { chatId, limit });
        } catch (err) {
            this._log(`[MEMORY] hybridSearch failed: ${err.message}`);
            return null;
        }
        if (!results.length) return null;

        return buildMemoryBlock(results);
    }

    close() {
        try {
            closeDb(this.db);
        } catch (_) { /* ignore */ }
        this.db = null;
    }
}

module.exports = { DynamicMemory };
