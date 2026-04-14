/**
 * Dynamic Memory - Content filtering & chunk extraction.
 *
 * Ported verbatim from Cortex (src/archive.ts) in CommonJS form.
 * Only the functions we need here: shouldExclude, getContentValue, extractChunks.
 */

// ============================================================================
// Configuration - Optimized for Nomic Embed v1.5
// ============================================================================

const MIN_CONTENT_LENGTH = 75;  // Adjusted to capture code snippets
const OPTIMAL_CHUNK_SIZE = 400; // Target chunk size for best retrieval
const MAX_CHUNK_SIZE = 600;     // Upper bound before splitting

// Patterns to exclude (noise, acknowledgments, tool outputs)
const EXCLUDED_PATTERNS = [
    /^(ok|okay|done|yes|no|sure|thanks|thank you|got it|understood|alright)\.?$/i,
    /^(hello|hi|hey|bye|goodbye)\.?$/i,
    /^y(es)?$/i,
    /^n(o)?$/i,
    /^\d+$/,        // Just numbers
    /^[.!?]+$/,     // Just punctuation
    /^\[Cortex\]/,  // Carry-over from Cortex status messages
    /^Running:/i,   // Tool execution outputs
];

// Content patterns that indicate HIGH-VALUE information (weighted higher)
const HIGH_VALUE_PATTERNS = [
    // Decisions and rationale
    /decided to|chose to|went with|opted for/i,
    /because|since|therefore|the reason/i,
    /trade-?off|pros? and cons?|alternative/i,

    // Architecture and design
    /architect|design|pattern|approach|strategy/i,
    /structure|schema|interface|contract/i,

    // Key outcomes
    /implemented|completed|fixed|resolved|solved/i,
    /created|added|updated|modified|refactored/i,
    /the solution|the fix|the approach/i,

    // Important context
    /important|critical|note that|keep in mind/i,
    /caveat|limitation|constraint|requirement/i,
    /blocker|issue|problem|error|bug/i,
];

// Content patterns that indicate STANDARD value
const VALUABLE_PATTERNS = [
    /function\s+\w+/i,
    /class\s+\w+/i,
    /interface\s+\w+/i,
    /import\s+/,
    /export\s+/,
    /const\s+\w+\s*=/,
    /let\s+\w+\s*=/,
    /def\s+\w+/,
    /however|although|while|whereas/i,
    /should|must|need to|have to/i,
    /config|setting|option|parameter/i,
];

// ============================================================================
// Content Filtering
// ============================================================================

function shouldExclude(content) {
    const trimmed = String(content).trim();

    if (trimmed.length < MIN_CONTENT_LENGTH) {
        return true;
    }

    for (const pattern of EXCLUDED_PATTERNS) {
        if (pattern.test(trimmed)) {
            return true;
        }
    }

    return false;
}

/**
 * 0 = not valuable, 1 = standard value, 2 = high value
 */
function getContentValue(content) {
    const text = String(content);

    if (text.includes('```')) {
        return 1;
    }

    for (const pattern of HIGH_VALUE_PATTERNS) {
        if (pattern.test(text)) {
            return 2;
        }
    }

    for (const pattern of VALUABLE_PATTERNS) {
        if (pattern.test(text)) {
            return 1;
        }
    }

    const words = text.split(/\s+/).length;
    if (words >= 15) {
        return 1;
    }

    return 0;
}

// ============================================================================
// Chunk Extraction
// ============================================================================

function extractChunks(content, role = 'assistant') {
    const chunks = [];

    // 1. Preserve code blocks by replacing them with placeholders
    const codeBlockMatches = [];
    const placeholderPrefix = '___CORTEX_CODE_BLOCK_';

    const protectedContent = String(content).replace(/```[\s\S]*?```/g, (match) => {
        codeBlockMatches.push(match);
        return `${placeholderPrefix}${codeBlockMatches.length - 1}___`;
    });

    // 2. Split by paragraphs
    const paragraphs = protectedContent.split(/\n\n+/);

    for (const para of paragraphs) {
        let text = para.trim();

        // 3. Restore code blocks
        if (text.includes(placeholderPrefix)) {
            text = text.replace(new RegExp(`${placeholderPrefix}(\\d+)___`, 'g'), (_, index) => {
                return codeBlockMatches[parseInt(index, 10)];
            });
        }

        const trimmed = text.trim();

        if (trimmed.length < MIN_CONTENT_LENGTH) {
            continue;
        }

        if (trimmed.length <= MAX_CHUNK_SIZE) {
            chunks.push(trimmed);
            continue;
        }

        // For longer paragraphs, use semantic splitting by sentences.
        const sentences = trimmed.split(/(?<=[.!?])\s+/);
        let currentChunk = '';

        for (const sentence of sentences) {
            const potentialLength = currentChunk.length + (currentChunk ? 1 : 0) + sentence.length;

            if (potentialLength > MAX_CHUNK_SIZE && currentChunk.length >= MIN_CONTENT_LENGTH) {
                chunks.push(currentChunk.trim());
                currentChunk = sentence;
            } else if (currentChunk.length >= OPTIMAL_CHUNK_SIZE && sentence.length > 100) {
                chunks.push(currentChunk.trim());
                currentChunk = sentence;
            } else {
                currentChunk += (currentChunk ? ' ' : '') + sentence;
            }
        }

        if (currentChunk.length >= MIN_CONTENT_LENGTH) {
            chunks.push(currentChunk.trim());
        }
    }

    // For user messages, prefix with context marker for better retrieval.
    if (role === 'user' && chunks.length > 0) {
        return chunks.map((chunk) => `[User request] ${chunk}`);
    }

    return chunks;
}

module.exports = {
    MIN_CONTENT_LENGTH,
    OPTIMAL_CHUNK_SIZE,
    MAX_CHUNK_SIZE,
    shouldExclude,
    getContentValue,
    extractChunks,
};
