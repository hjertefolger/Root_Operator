/**
 * Dynamic Memory - Embedding pipeline (nomic-embed-text-v1.5, quantized ONNX).
 *
 * Ported from Cortex (src/embeddings.ts) with two changes:
 *   1. Converted to CommonJS.
 *   2. initEmbedder(modelPath) accepts an absolute path to the model DIR PARENT
 *      and sets env.localModelPath + env.allowRemoteModels = false so the model
 *      is loaded strictly from disk.
 */

const path = require('path');

const MODEL_ID = 'nomic-embed-text-v1.5';
const MODEL_OWNER = 'nomic-ai';
const EMBEDDING_DIM = 768;

const PASSAGE_PREFIX = 'search_document: ';
const QUERY_PREFIX = 'search_query: ';

let embedder = null;
let initPromise = null;
let pipelineFunc = null;
let transformersEnv = null;

async function loadTransformers() {
    if (pipelineFunc && transformersEnv) return { pipeline: pipelineFunc, env: transformersEnv };
    const transformers = await import('@huggingface/transformers');
    pipelineFunc = transformers.pipeline;
    transformersEnv = transformers.env;
    return { pipeline: pipelineFunc, env: transformersEnv };
}

/**
 * Initialize the embedding pipeline. Singleton.
 *
 * @param {string} modelBaseDir Absolute path to the directory that CONTAINS
 *   the model folder (i.e. set to ".../models" so it resolves to
 *   ".../models/<owner>/<name>"). Either layout accepted:
 *     - modelBaseDir/nomic-ai/nomic-embed-text-v1.5/...
 *     - modelBaseDir/nomic-embed-text-v1.5/...
 */
async function initEmbedder(modelBaseDir) {
    if (embedder) return embedder;
    if (initPromise) return initPromise;

    initPromise = (async () => {
        try {
            const { pipeline, env } = await loadTransformers();

            // Xenova looks up models via `${localModelPath}/${model_id}`,
            // where model_id is by default `${owner}/${name}`. Our downloader
            // saves files at `${modelBaseDir}/nomic-embed-text-v1.5`. Support
            // both layouts by picking a base + model_id combo that exists.
            const fs = require('fs');
            let baseDir = modelBaseDir;
            let effectiveModelId = `${MODEL_OWNER}/${MODEL_ID}`;

            const ownerLayout = path.join(baseDir, MODEL_OWNER, MODEL_ID);
            const flatLayout = path.join(baseDir, MODEL_ID);

            if (fs.existsSync(ownerLayout)) {
                effectiveModelId = `${MODEL_OWNER}/${MODEL_ID}`;
            } else if (fs.existsSync(flatLayout)) {
                effectiveModelId = MODEL_ID;
            } else {
                // Fall back to treating modelBaseDir as the parent.
                effectiveModelId = MODEL_ID;
            }

            env.localModelPath = baseDir;
            env.allowRemoteModels = false;
            env.allowLocalModels = true;
            // Disable auto-download for ORT models too.
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

function isEmbedderReady() {
    return embedder !== null;
}

function getEmbeddingDim() {
    return EMBEDDING_DIM;
}

async function embedPassage(text) {
    if (!embedder) throw new Error('Embedder not initialized - call initEmbedder(modelBaseDir) first');
    const output = await embedder(PASSAGE_PREFIX + text, { pooling: 'mean', normalize: true });
    return new Float32Array(output.data);
}

async function embedQuery(text) {
    if (!embedder) throw new Error('Embedder not initialized - call initEmbedder(modelBaseDir) first');
    const output = await embedder(QUERY_PREFIX + text, { pooling: 'mean', normalize: true });
    return new Float32Array(output.data);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function embedSingleWithRetry(pipe, text, maxRetries = 3, baseDelayMs = 100) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const output = await pipe(text, { pooling: 'mean', normalize: true });
            return { success: true, embedding: new Float32Array(output.data) };
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
    const prefix = isQuery ? QUERY_PREFIX : PASSAGE_PREFIX;

    if (!embedder) throw new Error('Embedder not initialized - call initEmbedder(modelBaseDir) first');

    const results = [];
    const errors = [];
    const zero = new Float32Array(EMBEDDING_DIM);

    for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        for (let j = 0; j < batch.length; j++) {
            const globalIndex = i + j;
            const r = await embedSingleWithRetry(embedder, prefix + batch[j], maxRetries);
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

module.exports = {
    initEmbedder,
    isEmbedderReady,
    getEmbeddingDim,
    embedPassage,
    embedQuery,
    embedBatch,
    MODEL_ID,
    EMBEDDING_DIM,
};
