/**
 * Dynamic Memory - Hybrid search (vector + keyword + RRF + recency decay + MMR).
 *
 * Ported from Cortex (src/search.ts). Changes:
 *   - chatId replaces projectId (channel-scoped, no filesystem projects)
 *   - CommonJS
 *   - Min-cosine floor on vector matches before fusion
 *   - MMR diversity selection at the end (content-based Jaccard)
 */

const { searchByVector, searchByKeyword } = require('./db');
const { embedQuery } = require('./embeddings');

// Weights for combining scores
const VECTOR_WEIGHT = 0.6;
const KEYWORD_WEIGHT = 0.4;

// Recency decay: 7-day half-life
const RECENCY_HALF_LIFE_DAYS = 7;

// RRF (Reciprocal Rank Fusion) constant
const RRF_K = 60;

// Minimum cosine similarity for a vector match to enter the fusion pool.
// Stops weakly-relevant hits from surviving via rank-based RRF alone.
const MIN_VECTOR_SIMILARITY = 0.25;

// MMR diversity: 1.0 = pure relevance, 0.0 = pure diversity.
// 0.7 gives relevance priority while breaking up near-duplicate fragments.
const MMR_LAMBDA = 0.7;

/**
 * Hybrid search.
 *
 * @param {Database} db  better-sqlite3 instance
 * @param {string} query plain-text query (will be embedded)
 * @param {object} opts
 *   chatId?: string|null (null = only NULL-chat rows, undefined = global)
 *   limit?: number (default 5)
 */
async function hybridSearch(db, query, opts = {}) {
    const { chatId, limit = 5 } = opts;

    const queryEmbedding = await embedQuery(query);

    const [vectorResultsRaw, keywordResults] = await Promise.all([
        Promise.resolve(searchByVector(db, queryEmbedding, chatId, limit * 2)),
        Promise.resolve(searchByKeyword(db, query, chatId, limit * 2)),
    ]);

    // Drop weakly-relevant vector hits before fusion.
    const vectorResults = vectorResultsRaw.filter(
        (r) => typeof r.score === 'number' && r.score >= MIN_VECTOR_SIMILARITY,
    );

    const combined = combineWithRRF(vectorResults, keywordResults);
    const withRecency = applyRecencyDecay(combined);
    const sorted = withRecency.sort((a, b) => b.score - a.score);

    return selectWithMMR(sorted, MMR_LAMBDA, limit);
}

/**
 * Reciprocal Rank Fusion - combine two ranked lists.
 */
function combineWithRRF(vectorResults, keywordResults) {
    const scores = new Map();

    vectorResults.forEach((result, rank) => {
        const rrfScore = VECTOR_WEIGHT / (RRF_K + rank + 1);
        if (!scores.has(result.id)) {
            scores.set(result.id, {
                rrfScore: 0,
                content: result.content,
                timestamp: result.timestamp,
                chatId: result.chatId,
                sources: new Set(),
            });
        }
        const entry = scores.get(result.id);
        entry.rrfScore += rrfScore;
        entry.sources.add('vector');
    });

    keywordResults.forEach((result, rank) => {
        const rrfScore = KEYWORD_WEIGHT / (RRF_K + rank + 1);
        if (!scores.has(result.id)) {
            scores.set(result.id, {
                rrfScore: 0,
                content: result.content,
                timestamp: result.timestamp,
                chatId: result.chatId,
                sources: new Set(),
            });
        }
        const entry = scores.get(result.id);
        entry.rrfScore += rrfScore;
        entry.sources.add('keyword');
    });

    return Array.from(scores.entries()).map(([id, data]) => {
        let source;
        if (data.sources.has('vector') && data.sources.has('keyword')) {
            source = 'hybrid';
        } else if (data.sources.has('vector')) {
            source = 'vector';
        } else {
            source = 'keyword';
        }
        return {
            id,
            score: data.rrfScore,
            content: data.content,
            source,
            timestamp: data.timestamp,
            chatId: data.chatId,
        };
    });
}

/**
 * Exponential recency decay with 7-day half-life, blended 70/30 with the
 * original score so very old but very relevant content still surfaces.
 */
function applyRecencyDecay(results) {
    const now = Date.now();
    const halfLifeMs = RECENCY_HALF_LIFE_DAYS * 24 * 60 * 60 * 1000;
    return results.map((result) => {
        const ageMs = now - result.timestamp.getTime();
        const decayFactor = Math.pow(0.5, ageMs / halfLifeMs);
        const decayedScore = result.score * (0.7 + 0.3 * decayFactor);
        return { ...result, score: decayedScore };
    });
}

/**
 * Maximal Marginal Relevance selection with content-based (Jaccard) similarity.
 *
 * Greedily picks the top-ranked item, then for each subsequent slot picks the
 * candidate that maximizes `lambda * relevance - (1 - lambda) * maxSimToSelected`.
 * Relevance is the normalized RRF-after-decay score so the two sides are
 * comparable; similarity uses word-set Jaccard, cheap and good enough for short
 * conversation fragments (no extra embedding round-trips).
 */
function selectWithMMR(candidates, lambda, limit) {
    if (!Array.isArray(candidates) || candidates.length === 0) return [];
    if (candidates.length <= 1) return candidates.slice(0, limit);
    if (!(limit > 0)) return [];

    const scores = candidates.map((c) => c.score);
    const maxScore = Math.max(...scores);
    const minScore = Math.min(...scores);
    const range = maxScore - minScore || 1;
    const normed = candidates.map((c) => ({
        ...c,
        _normScore: (c.score - minScore) / range,
    }));

    const selected = [normed[0]];
    const pool = normed.slice(1);

    while (selected.length < limit && pool.length) {
        let bestIdx = -1;
        let bestMmr = -Infinity;
        for (let i = 0; i < pool.length; i++) {
            const cand = pool[i];
            let maxSim = 0;
            for (const s of selected) {
                const sim = jaccardSimilarity(cand.content, s.content);
                if (sim > maxSim) maxSim = sim;
            }
            const mmr = lambda * cand._normScore - (1 - lambda) * maxSim;
            if (mmr > bestMmr) {
                bestMmr = mmr;
                bestIdx = i;
            }
        }
        if (bestIdx === -1) break;
        selected.push(pool[bestIdx]);
        pool.splice(bestIdx, 1);
    }

    return selected.map(({ _normScore, ...rest }) => rest);
}

function jaccardSimilarity(a, b) {
    const tokensA = tokenize(a);
    const tokensB = tokenize(b);
    if (!tokensA.size || !tokensB.size) return 0;
    let intersect = 0;
    for (const w of tokensA) {
        if (tokensB.has(w)) intersect++;
    }
    const union = tokensA.size + tokensB.size - intersect;
    return union ? intersect / union : 0;
}

function tokenize(text) {
    const words = String(text).toLowerCase().match(/\b[a-z0-9]+\b/g);
    return new Set(words || []);
}

module.exports = {
    hybridSearch,
    combineWithRRF,
    applyRecencyDecay,
    selectWithMMR,
    jaccardSimilarity,
    VECTOR_WEIGHT,
    KEYWORD_WEIGHT,
    RECENCY_HALF_LIFE_DAYS,
    RRF_K,
    MIN_VECTOR_SIMILARITY,
    MMR_LAMBDA,
};
