/**
 * Dynamic Memory - Hybrid search (vector + keyword + RRF + recency decay).
 *
 * Ported from Cortex (src/search.ts). Changes:
 *   - chatId replaces projectId (channel-scoped, no filesystem projects)
 *   - CommonJS
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

    const [vectorResults, keywordResults] = await Promise.all([
        Promise.resolve(searchByVector(db, queryEmbedding, chatId, limit * 2)),
        Promise.resolve(searchByKeyword(db, query, chatId, limit * 2)),
    ]);

    const combined = combineWithRRF(vectorResults, keywordResults);
    const withRecency = applyRecencyDecay(combined);

    return withRecency.sort((a, b) => b.score - a.score).slice(0, limit);
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

module.exports = {
    hybridSearch,
    combineWithRRF,
    applyRecencyDecay,
    VECTOR_WEIGHT,
    KEYWORD_WEIGHT,
    RECENCY_HALF_LIFE_DAYS,
    RRF_K,
};
