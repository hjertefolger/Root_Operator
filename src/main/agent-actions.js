/**
 * ROOT OPERATOR — AGENT ACTIONS
 *
 * Handles the agent_* MCP tools by routing them to:
 *   — agent-avatar (for motion: moveTo / moveToCursor / park)
 *   — the Swift AX helper binary (for AX read/write/check)
 *
 * The Swift helper is shipped at src/main/native/ax-helper/ax-helper
 * (built from main.swift). When the app is bundled, the binary is
 * resolved relative to the app path; in dev it sits next to source.
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const HELPER_TIMEOUT_MS = 8000; // generous for first AX call

// Hard caps on AX write payloads. The AX channel can technically accept
// long strings but the user-visible blast radius scales with size.
const MAX_WRITE_TEXT_LENGTH = 8000; // characters

// Rate limit for AX writes. Prevents runaway loops (e.g. an LLM stuck in
// a write/observe cycle) from rapid-firing edits into the user's app.
const WRITE_INTERVAL_MIN_MS = 750;

function resolveHelperPath(deps) {
    const candidates = [];
    // Packaged build (electron-builder copies the binary into Resources/
    // via the extraResources entry).
    if (deps && deps.resourcesPath) {
        candidates.push(path.join(deps.resourcesPath, 'ax-helper'));
    }
    // Dev build — built by scripts/build-native-helpers.js.
    if (deps && deps.appPath) {
        candidates.push(path.join(deps.appPath, 'build/native/ax-helper'));
    }
    // Fallback for `swiftc` runs directly in the source tree.
    candidates.push(path.join(__dirname, 'native/ax-helper/ax-helper'));
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    return null;
}

function runHelper(deps, args) {
    const helperPath = resolveHelperPath(deps);
    if (!helperPath) {
        return Promise.resolve({
            error: 'helper_missing',
            detail: 'ax-helper binary not found; run src/main/native/ax-helper/build.sh',
        });
    }

    return new Promise((resolve) => {
        let resolved = false;
        let stdout = '';
        let stderr = '';
        let child;

        try {
            child = spawn(helperPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (err) {
            resolve({ error: 'spawn_failed', detail: err.message });
            return;
        }

        const timer = setTimeout(() => {
            if (resolved) return;
            resolved = true;
            try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
            resolve({ error: 'helper_timeout' });
        }, HELPER_TIMEOUT_MS);

        child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
        child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

        child.on('error', (err) => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            resolve({ error: 'spawn_error', detail: err.message });
        });

        child.on('close', (code) => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            if (code !== 0) {
                resolve({
                    error: 'helper_exit',
                    detail: `exit=${code} stderr=${stderr.trim()}`,
                });
                return;
            }
            try {
                const parsed = JSON.parse(stdout.trim());
                resolve(parsed);
            } catch (err) {
                resolve({
                    error: 'helper_bad_json',
                    detail: stdout.trim().slice(0, 200),
                });
            }
        });
    });
}

function formatRead(result) {
    if (result.error) {
        return `AX read failed: ${result.error}${result.detail ? ` (${result.detail})` : ''}`;
    }
    const lines = [];
    lines.push(`Element role: ${result.role || 'unknown'}`);
    if (result.frame) {
        lines.push(`Frame: x=${Math.round(result.frame.x)} y=${Math.round(result.frame.y)} w=${Math.round(result.frame.w)} h=${Math.round(result.frame.h)}`);
    }
    if (result.selectedText && result.selectedText.length > 0) {
        lines.push(`Selected text:\n${result.selectedText}`);
    }
    if (result.value !== undefined && result.value !== null) {
        lines.push(`Value:\n${result.value}`);
    } else if (!result.selectedText) {
        lines.push('Value: (empty)');
    }
    return lines.join('\n');
}

function formatWrite(result) {
    if (result.error) {
        return `AX write failed: ${result.error}${result.detail ? ` (${result.detail})` : ''}`;
    }
    if (result.ok) {
        return `Write succeeded (mode=${result.mode}).`;
    }
    return `Write returned unexpected: ${JSON.stringify(result).slice(0, 200)}`;
}

function init(deps) {
    if (!deps || !deps.getAgentAvatar || !deps.screen) {
        throw new Error('agent-actions.init requires getAgentAvatar, screen');
    }

    let lastWriteAt = 0;

    async function handle(req) {
        const tool = req.tool;
        const args = req.args || {};
        const avatar = deps.getAgentAvatar();

        try {
            switch (tool) {
                case 'agent_move_to_cursor': {
                    if (!avatar) return { result: 'Agent avatar not available.', isError: true };
                    const ox = Number(args.offset_x);
                    const oy = Number(args.offset_y);
                    const r = avatar.moveToCursor(
                        Number.isFinite(ox) ? ox : undefined,
                        Number.isFinite(oy) ? oy : undefined,
                    );
                    return {
                        result: `Moving to cursor → (${Math.round(r.to.x)}, ${Math.round(r.to.y)}).`,
                        isError: false,
                    };
                }

                case 'agent_move_to': {
                    if (!avatar) return { result: 'Agent avatar not available.', isError: true };
                    const x = Number(args.x);
                    const y = Number(args.y);
                    if (!Number.isFinite(x) || !Number.isFinite(y)) {
                        return { result: 'agent_move_to requires numeric x and y.', isError: true };
                    }
                    avatar.moveTo(x, y);
                    return {
                        result: `Moving to (${Math.round(x)}, ${Math.round(y)}).`,
                        isError: false,
                    };
                }

                case 'agent_park': {
                    if (!avatar) return { result: 'Agent avatar not available.', isError: true };
                    const r = avatar.park();
                    return {
                        result: `Parking at (${Math.round(r.to.x)}, ${Math.round(r.to.y)}).`,
                        isError: false,
                    };
                }

                case 'agent_check_ax': {
                    const r = await runHelper(deps, ['check']);
                    if (r.error) {
                        return { result: `AX check error: ${r.error}`, isError: true };
                    }
                    if (r.trusted) {
                        return { result: 'AX permission granted (trusted=true).', isError: false };
                    }
                    return {
                        result: 'AX permission NOT granted. Open System Settings → Privacy & Security → Accessibility and enable Root Operator.',
                        isError: true,
                    };
                }

                case 'agent_read_at_cursor': {
                    const cursor = deps.screen.getCursorScreenPoint();
                    const r = await runHelper(deps, ['read-at', String(cursor.x), String(cursor.y)]);
                    return { result: formatRead(r), isError: !!r.error && r.error !== 'no_text' };
                }

                case 'agent_read_focused': {
                    const r = await runHelper(deps, ['read-focused']);
                    return { result: formatRead(r), isError: !!r.error && r.error !== 'no_text' };
                }

                case 'agent_write_selection': {
                    const text = String(args.text || '');
                    const replaceAll = args.replace_all === true;
                    if (!text) {
                        return { result: 'agent_write_selection requires non-empty text.', isError: true };
                    }
                    if (text.length > MAX_WRITE_TEXT_LENGTH) {
                        return {
                            result: `Refusing write: text length ${text.length} exceeds limit ${MAX_WRITE_TEXT_LENGTH}.`,
                            isError: true,
                        };
                    }
                    const now = Date.now();
                    if (now - lastWriteAt < WRITE_INTERVAL_MIN_MS) {
                        const wait = WRITE_INTERVAL_MIN_MS - (now - lastWriteAt);
                        return {
                            result: `Rate limited: another write is allowed in ${wait}ms.`,
                            isError: true,
                        };
                    }
                    lastWriteAt = now;
                    const helperArgs = replaceAll
                        ? ['write-focused', '--replace-all', text]
                        : ['write-focused', text];
                    const r = await runHelper(deps, helperArgs);
                    return { result: formatWrite(r), isError: !r.ok };
                }

                default:
                    return { result: `Unknown agent tool: ${tool}`, isError: true };
            }
        } catch (err) {
            return { result: `Agent action error: ${err.message}`, isError: true };
        }
    }

    return { handle };
}

module.exports = {
    init,
    // Exposed for tests.
    __test: { resolveHelperPath, formatRead, formatWrite, runHelper },
};
