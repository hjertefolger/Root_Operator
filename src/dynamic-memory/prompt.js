/**
 * Dynamic Memory - Prompt block formatting.
 *
 * Takes ranked search results and turns them into a markdown-formatted
 * "Relevant Context from Memory" block that gets appended to the Claude Code
 * system prompt file just before spawn.
 */

const MAX_RESULTS = 5;
const MAX_CHARS_PER_RESULT = 300;

const HEADER = [
    '## Relevant Context from Memory',
    '',
    'The following fragments from past conversations may be relevant to the user\'s current request. Use them as background context when helpful; ignore them when not.',
    '',
].join('\n');

/**
 * Format search results as a markdown block suitable for system prompt
 * injection. Returns the rendered string or null if there is nothing to show.
 */
function buildMemoryBlock(results) {
    if (!Array.isArray(results) || results.length === 0) return null;

    const lines = [HEADER];

    const capped = results.slice(0, MAX_RESULTS);
    capped.forEach((r, idx) => {
        const when = formatTimeAgo(r.timestamp instanceof Date ? r.timestamp : new Date(r.timestamp));
        const raw = String(r.content || '').trim();
        const truncated = raw.length > MAX_CHARS_PER_RESULT
            ? raw.slice(0, MAX_CHARS_PER_RESULT).trimEnd() + '...'
            : raw;

        lines.push(`### Fragment ${idx + 1} (${when})`);
        lines.push('');
        lines.push(truncated);
        lines.push('');
    });

    return lines.join('\n').trim();
}

function formatTimeAgo(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return 'unknown time';
    const diff = Date.now() - date.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    return date.toLocaleDateString();
}

module.exports = {
    buildMemoryBlock,
    MAX_RESULTS,
    MAX_CHARS_PER_RESULT,
};
