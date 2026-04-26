/**
 * Dynamic Memory - Embedder worker thread.
 *
 * Hosts the @huggingface/transformers + onnxruntime-node pipeline so the
 * (synchronous) ONNX inference runs OFF the Electron main thread. The main
 * thread RPCs in via parentPort.postMessage and gets embeddings back without
 * blocking the UI / WebSocket heartbeats / channel-bridge IPC.
 *
 * Protocol (all messages have a numeric `id` for request/response matching):
 *
 *   In  { id, type: 'init', baseDir }
 *   Out { id, type: 'init_ok' } | { id, type: 'init_err', message }
 *
 *   In  { id, type: 'embed', kind: 'passage'|'query', text }
 *   Out { id, type: 'embed_ok', embedding (Float32Array) }
 *       | { id, type: 'embed_err', message }
 */

const path = require('path');
const fs = require('fs');
const { parentPort } = require('worker_threads');

const MODEL_ID = 'nomic-embed-text-v1.5';
const MODEL_OWNER = 'nomic-ai';
const PASSAGE_PREFIX = 'search_document: ';
const QUERY_PREFIX = 'search_query: ';

let embedder = null;
let initPromise = null;

async function initEmbedder(modelBaseDir) {
    if (embedder) return embedder;
    if (initPromise) return initPromise;

    initPromise = (async () => {
        try {
            const transformers = await import('@huggingface/transformers');
            const { pipeline, env } = transformers;

            let baseDir = modelBaseDir;
            let effectiveModelId = `${MODEL_OWNER}/${MODEL_ID}`;

            const ownerLayout = path.join(baseDir, MODEL_OWNER, MODEL_ID);
            const flatLayout = path.join(baseDir, MODEL_ID);

            if (fs.existsSync(ownerLayout)) {
                effectiveModelId = `${MODEL_OWNER}/${MODEL_ID}`;
            } else if (fs.existsSync(flatLayout)) {
                effectiveModelId = MODEL_ID;
            } else {
                effectiveModelId = MODEL_ID;
            }

            env.localModelPath = baseDir;
            env.allowRemoteModels = false;
            env.allowLocalModels = true;
            if (env.backends && env.backends.onnx) {
                env.backends.onnx.wasm = env.backends.onnx.wasm || {};
            }

            embedder = await pipeline('feature-extraction', effectiveModelId, {
                dtype: 'q8',
            });
            return embedder;
        } catch (error) {
            initPromise = null;
            throw error;
        }
    })();

    return initPromise;
}

async function embed(text, kind) {
    if (!embedder) throw new Error('Embedder not initialized');
    const prefix = kind === 'query' ? QUERY_PREFIX : PASSAGE_PREFIX;
    const output = await embedder(prefix + text, { pooling: 'mean', normalize: true });
    return new Float32Array(output.data);
}

parentPort.on('message', async (msg) => {
    if (!msg || typeof msg.id !== 'number') return;

    if (msg.type === 'init') {
        try {
            await initEmbedder(msg.baseDir);
            parentPort.postMessage({ id: msg.id, type: 'init_ok' });
        } catch (error) {
            parentPort.postMessage({
                id: msg.id,
                type: 'init_err',
                message: error && error.message ? error.message : String(error),
            });
        }
        return;
    }

    if (msg.type === 'embed') {
        try {
            const embedding = await embed(msg.text, msg.kind);
            parentPort.postMessage(
                { id: msg.id, type: 'embed_ok', embedding },
                [embedding.buffer],
            );
        } catch (error) {
            parentPort.postMessage({
                id: msg.id,
                type: 'embed_err',
                message: error && error.message ? error.message : String(error),
            });
        }
        return;
    }
});
