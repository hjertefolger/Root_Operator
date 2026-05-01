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

// Same idea for AX presses. A button-press loop has the same blast
// radius as a write loop — could click "Delete" repeatedly on a list,
// drain a queue, send messages. Keep button presses paced.
const PRESS_INTERVAL_MIN_MS = 750;

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

function formatTree(node, depth, lines) {
    if (depth > 8) return;
    const indent = '  '.repeat(depth);
    const parts = [node.role];
    if (node.subrole) parts.push(`(${node.subrole})`);
    if (node.label) parts.push(`"${node.label}"`);
    if (node.value && (!node.label || node.value !== node.label)) {
        parts.push(`= ${JSON.stringify(node.value).slice(0, 80)}`);
    }
    if (node.frame) {
        parts.push(`[${Math.round(node.frame.x)},${Math.round(node.frame.y)} ${Math.round(node.frame.w)}x${Math.round(node.frame.h)}]`);
    }
    lines.push(`${indent}${parts.join(' ')}`);
    if (Array.isArray(node.children)) {
        for (const child of node.children) {
            formatTree(child, depth + 1, lines);
        }
    }
    if (node.truncated) {
        lines.push(`${indent}  …(truncated)`);
    }
}

function formatReadWindow(result) {
    if (result.error) {
        return `Read window failed: ${result.error}${result.detail ? ` (${result.detail})` : ''}`;
    }
    const header = result.app
        ? `Active app: ${result.app}${result.bundle_id ? ` (${result.bundle_id})` : ''} — ${result.node_count} nodes\n`
        : `${result.node_count} nodes\n`;
    const lines = [];
    if (result.tree) formatTree(result.tree, 0, lines);
    return header + lines.join('\n');
}

// Validate the optional disambiguation args (`index`, `near_x`, `near_y`)
// shared by agent_find_element and agent_press_named, and turn them
// into the corresponding ax-helper argv tail. Codex flagged the silent
// coercion paths (fractional index, half-specified near, null → 0) as
// MED — explicit validation here returns a structured error to the
// caller instead of letting a malformed arg silently default the press.
function buildDisambiguationArgs(args, toolName) {
    const out = [];

    if (args.index !== undefined && args.index !== null) {
        const idxRaw = args.index;
        const idx = typeof idxRaw === 'number' ? idxRaw : Number(idxRaw);
        if (!Number.isFinite(idx) || !Number.isInteger(idx) || idx < 0) {
            return {
                error: `${toolName}: index must be a non-negative integer (got ${JSON.stringify(idxRaw)}).`,
                args: out,
            };
        }
        out.push('--index', String(idx));
    }

    const nxProvided = args.near_x !== undefined && args.near_x !== null;
    const nyProvided = args.near_y !== undefined && args.near_y !== null;
    if (nxProvided !== nyProvided) {
        return {
            error: `${toolName}: near_x and near_y must be provided together.`,
            args: out,
        };
    }
    if (nxProvided && nyProvided) {
        const nx = typeof args.near_x === 'number' ? args.near_x : Number(args.near_x);
        const ny = typeof args.near_y === 'number' ? args.near_y : Number(args.near_y);
        if (!Number.isFinite(nx) || !Number.isFinite(ny)) {
            return {
                error: `${toolName}: near_x and near_y must be finite numbers.`,
                args: out,
            };
        }
        out.push('--near', `${nx},${ny}`);
    }

    return { args: out };
}

function formatMatchSuffix(result) {
    const total = Number(result.match_count);
    if (!Number.isFinite(total) || total <= 1) return '';
    const idx = Number.isFinite(Number(result.match_index)) ? Number(result.match_index) : 0;
    return ` (match ${idx + 1} of ${total} — pass index or near_x/near_y to pick a different one)`;
}

function formatFind(result) {
    if (result.error) {
        const searched = result.searched ? ` (searched ${result.searched} nodes)` : '';
        const matched = Number.isFinite(Number(result.match_count)) && Number(result.match_count) > 0
            ? ` — ${result.match_count} match(es) but index out of range`
            : '';
        return `Find failed: ${result.error}${searched}${matched}`;
    }
    if (result.found) {
        const label = result.label ? ` labeled "${result.label}"` : '';
        const where = result.frame
            ? ` at [${Math.round(result.frame.x)},${Math.round(result.frame.y)} ${Math.round(result.frame.w)}x${Math.round(result.frame.h)}]`
            : '';
        return `Found ${result.role}${label}${where}${formatMatchSuffix(result)}`;
    }
    return `Find returned unexpected: ${JSON.stringify(result).slice(0, 200)}`;
}

function formatPress(result) {
    if (result.error) {
        return `Press failed: ${result.error}${result.detail ? ` (${result.detail})` : ''}${formatMatchSuffix(result)}`;
    }
    if (result.ok) {
        const label = result.label ? ` "${result.label}"` : '';
        return `Pressed ${result.role}${label}.${formatMatchSuffix(result)}`;
    }
    return `Press returned unexpected: ${JSON.stringify(result).slice(0, 200)}`;
}

function formatEventLine(evt) {
    if (!evt || typeof evt !== 'object') return '';
    const tsIso = Number.isFinite(evt.ts)
        ? new Date(evt.ts * 1000).toISOString().slice(11, 19)
        : '--:--:--';
    const parts = [tsIso, evt.event || 'unknown'];
    if (evt.app) parts.push(`app=${evt.app}`);
    if (evt.role) parts.push(`role=${evt.role}`);
    if (evt.label) parts.push(`label="${evt.label}"`);
    if (evt.selected_text) {
        parts.push(`selected=${JSON.stringify(evt.selected_text).slice(0, 80)}`);
    } else if (evt.value) {
        parts.push(`value=${JSON.stringify(evt.value).slice(0, 80)}`);
    }
    return parts.join(' · ');
}

function formatEvents(events) {
    if (!Array.isArray(events) || events.length === 0) {
        return 'No recent events.';
    }
    return events.map(formatEventLine).join('\n');
}

// Travel the agent body to the frame center of an AX result so every
// action is visibly grounded — the user sees the dot land where the
// agent just acted (read, find, press, write). Pairs with maybeHalo
// at the call site: halo flashes around the element, dot dwells
// beside it. No-op when avatar is missing or the frame is degenerate.
// Pure module-level function so tests can call it directly.
function maybeTravelToFrame(avatar, result) {
    if (!avatar || typeof avatar.moveTo !== 'function') return;
    if (!result || !result.frame) return;
    const f = result.frame;
    if (!Number.isFinite(f.x) || !Number.isFinite(f.y)
        || !Number.isFinite(f.w) || !Number.isFinite(f.h)) return;
    const cx = f.x + f.w / 2;
    const cy = f.y + f.h / 2;
    try { avatar.moveTo(cx, cy); } catch (_) { /* best-effort */ }
}

function init(deps) {
    if (!deps || !deps.getAgentAvatar || !deps.screen) {
        throw new Error('agent-actions.init requires getAgentAvatar, screen');
    }

    let lastWriteAt = 0;
    let lastPressAt = 0;

    // Pulse the halo around the AX element identified by the helper's
    // structured frame, if the halo overlay is wired and the frame is
    // valid. Best-effort — never throw, never block the action result.
    function maybeHalo(result) {
        if (!result || !result.frame) return;
        if (typeof deps.getAgentHalo !== 'function') return;
        const halo = deps.getAgentHalo();
        if (!halo || typeof halo.show !== 'function') return;
        try {
            halo.show({
                x: result.frame.x,
                y: result.frame.y,
                w: result.frame.w,
                h: result.frame.h,
            });
        } catch (_) { /* swallow halo errors — purely decorative */ }
    }

    // Halo + travel together — every successful AX action where we have
    // a frame should make the dot legible at the action site.
    function showActionAt(avatar, result) {
        maybeHalo(result);
        maybeTravelToFrame(avatar, result);
    }

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
                    if (!r.error || r.error === 'no_text') showActionAt(avatar, r);
                    return { result: formatRead(r), isError: !!r.error && r.error !== 'no_text' };
                }

                case 'agent_read_focused': {
                    const r = await runHelper(deps, ['read-focused']);
                    if (!r.error || r.error === 'no_text') showActionAt(avatar, r);
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
                    // Resolve the target via the user's cursor position
                    // rather than system focus. The Presence bubble owns
                    // focus while the user is typing into it, so writing
                    // through `write-focused` reliably fails. The Swift
                    // helper now restores focus on the cursor-resolved
                    // element before the write.
                    const cursor = deps.screen.getCursorScreenPoint();
                    const helperArgs = replaceAll
                        ? ['write-at', String(cursor.x), String(cursor.y), '--replace-all', text]
                        : ['write-at', String(cursor.x), String(cursor.y), text];
                    const r = await runHelper(deps, helperArgs);
                    if (r.ok) showActionAt(avatar, r);
                    return { result: formatWrite(r), isError: !r.ok };
                }

                case 'agent_read_window': {
                    const r = await runHelper(deps, ['read-window']);
                    return { result: formatReadWindow(r), isError: !!r.error };
                }

                case 'agent_find_element': {
                    const label = String(args.label || '').trim();
                    if (!label) {
                        return { result: 'agent_find_element requires a non-empty label.', isError: true };
                    }
                    const disambig = buildDisambiguationArgs(args, 'agent_find_element');
                    if (disambig.error) {
                        return { result: disambig.error, isError: true };
                    }
                    const helperArgs = ['find-element'];
                    if (args.role) {
                        helperArgs.push('--role', String(args.role));
                    }
                    helperArgs.push(...disambig.args);
                    helperArgs.push(label);
                    const r = await runHelper(deps, helperArgs);
                    if (r.found) showActionAt(avatar, r);
                    return { result: formatFind(r), isError: !!r.error };
                }

                case 'agent_recent_events': {
                    if (typeof deps.getAgentEvents !== 'function') {
                        return { result: 'Agent events not wired.', isError: true };
                    }
                    const events = deps.getAgentEvents();
                    if (!events || typeof events.getEvents !== 'function') {
                        return { result: 'Agent events not running.', isError: true };
                    }
                    const count = Number(args.count);
                    const sinceMs = Number(args.since_ms);
                    const list = events.getEvents({
                        count: Number.isFinite(count) ? count : undefined,
                        since_ms: Number.isFinite(sinceMs) ? sinceMs : undefined,
                    });
                    return { result: formatEvents(list), isError: false };
                }

                case 'agent_press_named': {
                    const label = String(args.label || '').trim();
                    if (!label) {
                        return { result: 'agent_press_named requires a non-empty label.', isError: true };
                    }
                    const now = Date.now();
                    if (now - lastPressAt < PRESS_INTERVAL_MIN_MS) {
                        const wait = PRESS_INTERVAL_MIN_MS - (now - lastPressAt);
                        return {
                            result: `Rate limited: another press is allowed in ${wait}ms.`,
                            isError: true,
                        };
                    }
                    const disambig = buildDisambiguationArgs(args, 'agent_press_named');
                    if (disambig.error) {
                        return { result: disambig.error, isError: true };
                    }
                    lastPressAt = now;
                    const helperArgs = ['press-named'];
                    if (args.role) {
                        helperArgs.push('--role', String(args.role));
                    }
                    helperArgs.push(...disambig.args);
                    helperArgs.push(label);
                    const r = await runHelper(deps, helperArgs);
                    if (r.ok) showActionAt(avatar, r);
                    return { result: formatPress(r), isError: !r.ok };
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
    __test: {
        resolveHelperPath,
        formatRead,
        formatWrite,
        formatReadWindow,
        formatFind,
        formatPress,
        formatEventLine,
        formatEvents,
        runHelper,
        buildDisambiguationArgs,
        maybeTravelToFrame,
    },
};
