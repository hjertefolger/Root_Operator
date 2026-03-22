/**
 * ROOT OPERATOR — WORKSPACE MANAGER
 *
 * Manages the agent workspace directory with identity files (IDENTITY.md,
 * SOUL.md, AGENTS.md, USER.md, BOOTSTRAP.md). Seeds templates on first run
 * and builds the system prompt append file for Claude Code.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const WORKSPACE_DIR = path.join(os.homedir(), '.root-operator', 'workspace');
const STATE_FILE = path.join(WORKSPACE_DIR, '.state.json');
// In packaged app, workspace-templates may be inside asar — use unpacked path
const _baseDir = __dirname.replace('app.asar', 'app.asar.unpacked');
const TEMPLATES_DIR = path.join(_baseDir, '..', 'workspace-templates');

const IDENTITY_FILES = ['IDENTITY.md', 'SOUL.md', 'AGENTS.md', 'USER.md'];
const BOOTSTRAP_FILE = 'BOOTSTRAP.md';

const MAX_CHARS_PER_FILE = 20_000;
const MAX_TOTAL_CHARS = 150_000;

/**
 * Ensure workspace exists. Seed template files on first run.
 * Returns { workspaceDir, isFirstRun }.
 */
function ensureWorkspace() {
    const memoryDir = path.join(WORKSPACE_DIR, 'memory');

    // Create directories
    fs.mkdirSync(memoryDir, { recursive: true });

    const state = _readState();
    const isFirstRun = !state.onboardedAt;

    // Seed template files that don't exist yet
    const filesToSeed = isFirstRun
        ? [...IDENTITY_FILES, BOOTSTRAP_FILE]
        : IDENTITY_FILES;

    for (const filename of filesToSeed) {
        const dest = path.join(WORKSPACE_DIR, filename);
        if (!fs.existsSync(dest)) {
            const template = path.join(TEMPLATES_DIR, filename);
            if (fs.existsSync(template)) {
                fs.copyFileSync(template, dest);
                console.log(`[Workspace] Seeded ${filename}`);
            }
        }
    }

    if (isFirstRun) {
        _writeState({ ...state, seededAt: new Date().toISOString() });
        console.log('[Workspace] First run — workspace seeded');
    }

    return { workspaceDir: WORKSPACE_DIR, isFirstRun };
}

/**
 * Build the system prompt append content from workspace files.
 * Returns the combined content string.
 */
function buildSystemPromptAppend() {
    const lines = [];

    lines.push('# Root Operator Context');
    lines.push('');
    lines.push('The following identity and context files have been loaded from your workspace.');
    lines.push('If SOUL.md is present, embody its persona and tone in all interactions.');
    lines.push('');
    lines.push('## Workspace');
    lines.push(`Working directory: ${WORKSPACE_DIR}`);
    lines.push('You can read and write files here for persistent memory and context.');
    lines.push('');

    // Determine which files to load
    const hasBootstrap = fs.existsSync(path.join(WORKSPACE_DIR, BOOTSTRAP_FILE));
    const filesToLoad = hasBootstrap
        ? [...IDENTITY_FILES, BOOTSTRAP_FILE]
        : IDENTITY_FILES;

    // Also load MEMORY.md if it exists
    const memoryPath = path.join(WORKSPACE_DIR, 'MEMORY.md');
    if (fs.existsSync(memoryPath)) {
        filesToLoad.push('MEMORY.md');
    }

    let remaining = MAX_TOTAL_CHARS;

    for (const filename of filesToLoad) {
        if (remaining <= 0) break;

        const filepath = path.join(WORKSPACE_DIR, filename);
        if (!fs.existsSync(filepath)) continue;

        try {
            let content = fs.readFileSync(filepath, 'utf-8');
            const budget = Math.min(MAX_CHARS_PER_FILE, remaining);

            if (content.length > budget) {
                content = content.slice(0, budget) + '\n...(truncated)...';
            }

            remaining -= content.length;

            lines.push(`## ${filename}`);
            lines.push('');
            lines.push(content);
            lines.push('');
        } catch (err) {
            console.error(`[Workspace] Failed to read ${filename}: ${err.message}`);
        }
    }

    return lines.join('\n');
}

/**
 * Write the system prompt append file to a temp location.
 * Returns the file path.
 */
function writeSystemPromptFile() {
    const content = buildSystemPromptAppend();
    const tmpDir = path.join(os.tmpdir(), 'root-operator');
    fs.mkdirSync(tmpDir, { recursive: true });

    const filepath = path.join(tmpDir, 'system-prompt-append.md');
    fs.writeFileSync(filepath, content, 'utf-8');

    console.log(`[Workspace] System prompt append written (${content.length} chars)`);
    return filepath;
}

/**
 * Mark the workspace as onboarded (bootstrap complete).
 */
function markOnboarded() {
    const state = _readState();
    state.onboardedAt = new Date().toISOString();
    _writeState(state);
    console.log('[Workspace] Marked as onboarded');
}

/**
 * Check if bootstrap is pending (first run not yet completed).
 */
function isBootstrapPending() {
    return fs.existsSync(path.join(WORKSPACE_DIR, BOOTSTRAP_FILE));
}

/**
 * Get the workspace directory path.
 */
function getWorkspaceDir() {
    return WORKSPACE_DIR;
}

// --- Internal helpers ---

function _readState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
        }
    } catch {}
    return {};
}

function _writeState(state) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

module.exports = {
    ensureWorkspace,
    buildSystemPromptAppend,
    writeSystemPromptFile,
    markOnboarded,
    isBootstrapPending,
    getWorkspaceDir,
    WORKSPACE_DIR,
};
