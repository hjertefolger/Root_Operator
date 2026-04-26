/**
 * Dynamic Memory - Embedding pipeline (nomic-embed-text-v1.5, quantized ONNX).
 *
 * The pipeline runs in a worker thread (embedder-worker.js) so the synchronous
 * ONNX inference does NOT block the Electron main thread. This module is a
 * thin RPC client over a single long-lived worker.
 *
 * Public API matches the previous in-process version:
 *   - initEmbedder(modelBaseDir): spawns the worker and loads the model
 *   - isEmbedderReady()
 *   - embedPassage(text), embedQuery(text), embedBatch(texts, opts)
 *
 * Per-call timeout: each embed RPC is bounded by EMBED_TIMEOUT_MS so a stuck
 * inference cannot pin the caller forever. The main thread is non-blocking
 * either way (worker does the actual work) — the timeout protects against
 * pathological model states.
 */

const path = require('path');
const { Worker } = require('worker_threads');

const MODEL_ID = 'nomic-embed-text-v1.5';
const MODEL_OWNER = 'nomic-ai';
const EMBEDDING_DIM = 768;

const EMBED_TIMEOUT_MS = Number(process.env.RO_EMBED_TIMEOUT_MS) || 10_000;

let worker = null;
let workerReady = false;
let initPromise = null;
let nextRequestId = 1;
const pending = new Map();
// Generation counter — bumped on every spawn/replace. Lets event handlers
// drop stale 'error' / 'exit' events from a previous worker without
// clobbering a freshly-spawned replacement.
let workerGeneration = 0;

function rejectAllPending(reason) {
    for (const [, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(reason);
    }
    pending.clear();
}

function spawnWorker() {
    const workerPath = path.join(__dirname, 'embedder-worker.js');
    const w = new Worker(workerPath);
    const generation = ++workerGeneration;
    // Don't keep the event loop alive just for this worker — let app-quit
    // cleanly tear down without us holding a ref. Explicit shutdown
    // (terminate or app-quit hook) still closes it deterministically.
    if (typeof w.unref === 'function') {
        w.unref();
    }

    w.on('message', (msg) => {
        if (!msg || typeof msg.id !== 'number') return;
        const entry = pending.get(msg.id);
        if (!entry) return;
        pending.delete(msg.id);
        clearTimeout(entry.timer);

        if (msg.type === 'init_ok' || msg.type === 'embed_ok') {
            entry.resolve(msg);
        } else {
            entry.reject(new Error(msg.message || 'Worker error'));
        }
    });

    const onTerminalEvent = (reason) => {
        // Only mutate global state if this event came from the CURRENT
        // worker. After a respawn, an old worker's lingering exit event
        // would otherwise nuke the new one.
        if (generation !== workerGeneration) return;
        rejectAllPending(reason);
        worker = null;
        workerReady = false;
    };

    w.on('error', (err) => onTerminalEvent(err));
    w.on('exit', (code) => onTerminalEvent(new Error(`Embedder worker exited (code=${code})`)));

    return w;
}

// Hard-reset the worker: terminate the current one, drop pending, force
// the next caller to respawn + re-init via initEmbedder. Used on timeout
// to recover from a wedged inference run.
async function resetWorker(reason) {
    const dying = worker;
    workerGeneration += 1; // Old worker's events become stale immediately.
    worker = null;
    workerReady = false;
    rejectAllPending(reason);
    if (dying) {
        try {
            await dying.terminate();
        } catch (_) {
            // best-effort
        }
    }
}

function rpc(message, timeoutMs) {
    return new Promise((resolve, reject) => {
        if (!worker) {
            reject(new Error('Embedder worker not running'));
            return;
        }
        const id = nextRequestId++;
        const timer = setTimeout(() => {
            if (!pending.has(id)) return;
            pending.delete(id);
            // A timeout means the worker is wedged on this call. Hard-reset
            // it so subsequent callers don't queue behind a stuck inference.
            const err = new Error(`Embedder RPC timed out after ${timeoutMs}ms (type=${message.type})`);
            resetWorker(err).catch(() => {});
            reject(err);
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        worker.postMessage({ id, ...message });
    });
}

async function initEmbedder(modelBaseDir) {
    if (workerReady) return;
    if (initPromise) return initPromise;

    initPromise = (async () => {
        if (!worker) {
            worker = spawnWorker();
        }
        // Init has its own (longer) timeout — model load can be slow on cold disk.
        await rpc({ type: 'init', baseDir: modelBaseDir }, 60_000);
        workerReady = true;
    })();

    try {
        await initPromise;
    } finally {
        initPromise = null;
    }
}

function isEmbedderReady() {
    return workerReady;
}

function getEmbeddingDim() {
    return EMBEDDING_DIM;
}

async function embedPassage(text) {
    if (!workerReady) throw new Error('Embedder not initialized - call initEmbedder(modelBaseDir) first');
    const reply = await rpc({ type: 'embed', kind: 'passage', text }, EMBED_TIMEOUT_MS);
    return reply.embedding;
}

async function embedQuery(text) {
    if (!workerReady) throw new Error('Embedder not initialized - call initEmbedder(modelBaseDir) first');
    const reply = await rpc({ type: 'embed', kind: 'query', text }, EMBED_TIMEOUT_MS);
    return reply.embedding;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function embedSingleWithRetry(text, kind, maxRetries = 3, baseDelayMs = 100) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const embedding = kind === 'query'
                ? await embedQuery(text)
                : await embedPassage(text);
            return { success: true, embedding };
        } catch (error) {
            if (attempt < maxRetries - 1) {
                await sleep(baseDelayMs * Math.pow(2, attempt));
            } else {
                return {
                    success: false,
                    error: error instanceof Error ? error.message : String(error),
                };
            }
        }
    }
    return { success: false, error: 'Max retries exceeded' };
}

async function embedBatch(texts, options = {}) {
    const {
        batchSize = 32,
        onProgress,
        isQuery = false,
        allowPartialResults = false,
        maxRetries = 3,
    } = options;

    if (!workerReady) throw new Error('Embedder not initialized - call initEmbedder(modelBaseDir) first');

    const results = [];
    const errors = [];
    const zero = new Float32Array(EMBEDDING_DIM);
    const kind = isQuery ? 'query' : 'passage';

    for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        for (let j = 0; j < batch.length; j++) {
            const globalIndex = i + j;
            const r = await embedSingleWithRetry(batch[j], kind, maxRetries);
            if (r.success) {
                results.push(r.embedding);
            } else {
                errors.push({ index: globalIndex, error: r.error });
                if (allowPartialResults) results.push(zero);
            }
        }
        if (onProgress) onProgress(Math.min(i + batchSize, texts.length), texts.length);
    }

    if (errors.length && !allowPartialResults) {
        throw new Error(`Embedding failed for text at index ${errors[0].index}: ${errors[0].error}`);
    }
    return results;
}

async function shutdownEmbedder() {
    if (!worker) return;
    // Match resetWorker() ordering: synchronously bump generation, clear
    // worker state, and reject pending BEFORE awaiting termination. This
    // ensures isEmbedderReady() flips false immediately and pending RPC
    // timers don't outlive shutdown (important when called fire-and-forget
    // during app-quit).
    const dying = worker;
    workerGeneration += 1;
    worker = null;
    workerReady = false;
    rejectAllPending(new Error('Embedder shut down'));
    try {
        await dying.terminate();
    } catch (_) {
        // best-effort
    }
}

module.exports = {
    initEmbedder,
    isEmbedderReady,
    getEmbeddingDim,
    embedPassage,
    embedQuery,
    embedBatch,
    shutdownEmbedder,
    MODEL_ID,
    EMBEDDING_DIM,
};
