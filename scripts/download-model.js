/**
 * Download the nomic-embed-text-v1.5 quantized ONNX model into
 * ./models/nomic-embed-text-v1.5/ for bundling with the packaged app.
 *
 * Run once during dev setup:
 *   node scripts/download-model.js
 *
 * Re-runs are idempotent — files already on disk are skipped.
 */

const fs = require('fs');
const path = require('path');

const MODEL_ID = 'nomic-ai/nomic-embed-text-v1.5';
const TARGET_DIR = path.join(__dirname, '..', 'models', 'nomic-embed-text-v1.5');

async function main() {
    // Ensure target dir
    fs.mkdirSync(TARGET_DIR, { recursive: true });

    console.log(`[download-model] Target: ${TARGET_DIR}`);
    console.log('[download-model] Loading @xenova/transformers (dynamic import)...');

    // ESM-only package — use dynamic import from CommonJS.
    const { env, pipeline } = await import('@xenova/transformers');

    // Point transformers.js cache at our target dir so the HF hub copy lands there.
    // This avoids double-copying from ~/.cache/huggingface/hub.
    env.cacheDir = path.join(__dirname, '..', 'models', '_cache');
    env.allowRemoteModels = true;
    env.allowLocalModels = true;

    console.log(`[download-model] Downloading ${MODEL_ID} (quantized)...`);
    // Instantiating the pipeline triggers download + caching.
    const pipe = await pipeline('feature-extraction', MODEL_ID, {
        quantized: true,
    });

    // Run a single inference to ensure the graph loads OK.
    const out = await pipe('search_document: test', { pooling: 'mean', normalize: true });
    const dim = out.data ? out.data.length : 0;
    console.log(`[download-model] Test embed OK, dim=${dim}`);

    // Now relocate the cached files into TARGET_DIR in the layout transformers.js
    // expects when env.localModelPath is set to the parent of the model dir.
    // Cached layout: {cacheDir}/{MODEL_ID}/{files}
    const cachedModelDir = path.join(env.cacheDir, MODEL_ID);
    if (!fs.existsSync(cachedModelDir)) {
        throw new Error(`Expected cached model at ${cachedModelDir} but it is missing.`);
    }

    copyDir(cachedModelDir, TARGET_DIR);

    // Verify the critical file exists where the plan expects.
    const quantOnnx = path.join(TARGET_DIR, 'onnx', 'model_quantized.onnx');
    if (!fs.existsSync(quantOnnx)) {
        throw new Error(`Missing required file after copy: ${quantOnnx}`);
    }
    const stat = fs.statSync(quantOnnx);
    console.log(`[download-model] OK: ${quantOnnx} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
}

function copyDir(src, dst) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, entry.name);
        const d = path.join(dst, entry.name);
        if (entry.isDirectory()) {
            copyDir(s, d);
        } else if (entry.isFile()) {
            // Skip if same size already present.
            if (fs.existsSync(d) && fs.statSync(d).size === fs.statSync(s).size) continue;
            fs.copyFileSync(s, d);
        }
    }
}

main().catch((err) => {
    console.error('[download-model] FAILED:', err);
    process.exit(1);
});
