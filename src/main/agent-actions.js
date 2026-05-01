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

// Keystrokes are higher-frequency than presses — chord shortcuts and
// typed text both compose multiple keys in a row. Rate-limit at the
// per-keystroke layer is tighter than press; the type-text path takes
// a single helper call so it gets the same window as a write.
const KEYSTROKE_INTERVAL_MIN_MS = 200;
const TYPE_TEXT_INTERVAL_MIN_MS = 750;
// Keyboard-synthesis path is more conservative than AX value-write
// because a single CGEvent unicode string types into focus, exercises
// app key handlers, and behaves less like natural typing for long
// payloads. Keep this short until chunked-typing semantics ship.
const MAX_TYPE_TEXT_LENGTH = 2000;

// User-activity guard window. Before posting a keystroke or typing
// text we look at the AX subscribe ring buffer. If we see a recent
// AXValueChanged or AXFocusedUIElementChanged that we did NOT cause
// (heuristic: outside our own action window), refuse with
// `user_active` so we don't fire keys into a moving focus or while
// the user is typing. The window is generous (1200ms) because user
// activity events trail their physical action by 50-300ms in tests.
const USER_ACTIVITY_WINDOW_MS = 1200;
// We grant ourselves a "self-caused" window after each AX action so
// that legitimate follow-on keystrokes aren't mistaken for user
// activity caused by our own previous write/press.
const SELF_ACTION_WINDOW_MS = 800;

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

// Travel the agent body to land BESIDE an AX result frame so every
// action is visibly grounded without the dot covering the content
// it's reading or writing. Default landing point: right edge of the
// frame, vertically centered, with a small outward offset. If the
// frame's right side would push the dot off the cursor's display,
// fall back to landing at the left edge. Pairs with maybeHalo at the
// call site: halo around the element, dot beside it.
//
// Pure module-level function so tests can call it directly. Optional
// `screen` dep used to keep the dot on-screen when an element sits
// flush against a display edge; without it we just default to the
// right edge.
const FRAME_LANDING_OFFSET_PX = 12;

function computeFrameLanding(frame, screen) {
    if (!frame || !Number.isFinite(frame.x) || !Number.isFinite(frame.y)
        || !Number.isFinite(frame.w) || !Number.isFinite(frame.h)) return null;
    const cy = frame.y + frame.h / 2;
    const right = frame.x + frame.w + FRAME_LANDING_OFFSET_PX;
    const left = frame.x - FRAME_LANDING_OFFSET_PX;

    // No screen helper → default to right.
    if (!screen || typeof screen.getDisplayNearestPoint !== 'function') {
        return { x: right, y: cy };
    }
    try {
        const display = screen.getDisplayNearestPoint({
            x: Math.round(frame.x + frame.w / 2),
            y: Math.round(cy),
        });
        const wa = display && display.workArea;
        if (!wa) return { x: right, y: cy };
        const fitsRight = right <= wa.x + wa.width;
        if (fitsRight) return { x: right, y: cy };
        // Right edge would push past display — fall back to left.
        return { x: left, y: cy };
    } catch (_) {
        return { x: right, y: cy };
    }
}

function maybeTravelToFrame(avatar, result, screen) {
    if (!avatar || typeof avatar.moveTo !== 'function') return;
    const landing = computeFrameLanding(result && result.frame, screen);
    if (!landing) return;
    try { avatar.moveTo(landing.x, landing.y); } catch (_) { /* best-effort */ }
}

function init(deps) {
    if (!deps || !deps.getAgentAvatar || !deps.screen) {
        throw new Error('agent-actions.init requires getAgentAvatar, screen');
    }

    let lastWriteAt = 0;
    let lastPressAt = 0;
    let lastKeystrokeAt = 0;
    let lastTypeTextAt = 0;
    // Timestamp of the most recent AX-mutating action we performed
    // (write, press, keystroke, type-text, select-*). Subsequent
    // user-activity checks ignore events older than this — those are
    // ours, not the user's. Updated on every successful action.
    let lastSelfActionAt = 0;

    function bumpSelfActionAt() {
        lastSelfActionAt = Date.now();
    }

    // Inspect the AX subscribe ring buffer for evidence that the user
    // is actively typing or navigating in the time window leading up
    // to a planned keystroke. Returns the offending event line, or
    // null if no user activity is detected.
    function detectUserActivity() {
        if (typeof deps.getAgentEvents !== 'function') return null;
        const events = deps.getAgentEvents();
        if (!events || typeof events.getEvents !== 'function') return null;
        const list = events.getEvents({ since_ms: USER_ACTIVITY_WINDOW_MS });
        if (!Array.isArray(list) || list.length === 0) return null;
        const cutoffMs = Date.now() - USER_ACTIVITY_WINDOW_MS;
        const selfCutoffMs = lastSelfActionAt - SELF_ACTION_WINDOW_MS;
        const triggers = new Set([
            'AXValueChanged',
            'AXFocusedUIElementChanged',
            'AXSelectedTextChanged',
        ]);
        for (const e of list) {
            if (!e || !triggers.has(e.event)) continue;
            const tsMs = Number(e.ts) * 1000;
            if (!Number.isFinite(tsMs) || tsMs < cutoffMs) continue;
            // If the event happened within our own self-caused window
            // immediately after a recent agent action, treat it as ours.
            if (lastSelfActionAt > 0 && tsMs >= selfCutoffMs && tsMs <= lastSelfActionAt + SELF_ACTION_WINDOW_MS) {
                continue;
            }
            return e;
        }
        return null;
    }

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
        maybeTravelToFrame(avatar, result, deps.screen);
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
                    if (r.ok) { bumpSelfActionAt(); showActionAt(avatar, r); }
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
                    if (r.ok) { bumpSelfActionAt(); showActionAt(avatar, r); }
                    return { result: formatPress(r), isError: !r.ok };
                }

                case 'agent_keystroke': {
                    const key = String(args.key || '').trim();
                    if (!key) {
                        return { result: 'agent_keystroke requires a non-empty key (e.g. "j", "return", "f5").', isError: true };
                    }
                    const mods = args.mods ? String(args.mods).trim() : '';
                    const force = args.force === true;

                    const now = Date.now();
                    if (now - lastKeystrokeAt < KEYSTROKE_INTERVAL_MIN_MS) {
                        const wait = KEYSTROKE_INTERVAL_MIN_MS - (now - lastKeystrokeAt);
                        return {
                            result: `Rate limited: another keystroke allowed in ${wait}ms.`,
                            isError: true,
                        };
                    }

                    if (!force) {
                        const offending = detectUserActivity();
                        if (offending) {
                            return {
                                result: `Refused: user activity detected (${offending.event}${offending.app ? ' in ' + offending.app : ''}). Pass force=true to override.`,
                                isError: true,
                            };
                        }
                    }
                    lastKeystrokeAt = now;
                    const helperArgs = ['keystroke'];
                    if (mods) helperArgs.push('--mods', mods);
                    helperArgs.push(key);
                    const r = await runHelper(deps, helperArgs);
                    if (r.ok) bumpSelfActionAt();
                    if (r.error) {
                        return {
                            result: `Keystroke failed: ${r.error}${r.detail ? ` (${r.detail})` : ''}`,
                            isError: true,
                        };
                    }
                    return {
                        result: `Sent ${mods ? mods + '+' : ''}${key}.`,
                        isError: false,
                    };
                }

                case 'agent_type_text': {
                    const text = String(args.text || '');
                    if (!text) {
                        return { result: 'agent_type_text requires non-empty text.', isError: true };
                    }
                    if (text.length > MAX_TYPE_TEXT_LENGTH) {
                        return {
                            result: `Refusing type-text: length ${text.length} exceeds limit ${MAX_TYPE_TEXT_LENGTH}.`,
                            isError: true,
                        };
                    }
                    const force = args.force === true;
                    const now = Date.now();
                    if (now - lastTypeTextAt < TYPE_TEXT_INTERVAL_MIN_MS) {
                        const wait = TYPE_TEXT_INTERVAL_MIN_MS - (now - lastTypeTextAt);
                        return {
                            result: `Rate limited: type-text allowed in ${wait}ms.`,
                            isError: true,
                        };
                    }
                    if (!force) {
                        const offending = detectUserActivity();
                        if (offending) {
                            return {
                                result: `Refused: user activity detected (${offending.event}). Pass force=true to override.`,
                                isError: true,
                            };
                        }
                    }
                    lastTypeTextAt = now;
                    const r = await runHelper(deps, ['type-text', text]);
                    if (r.ok) bumpSelfActionAt();
                    if (r.error) {
                        return {
                            result: `Type-text failed: ${r.error}${r.detail ? ` (${r.detail})` : ''}`,
                            isError: true,
                        };
                    }
                    return {
                        result: `Typed ${text.length} character${text.length === 1 ? '' : 's'}.`,
                        isError: false,
                    };
                }

                case 'agent_select_range': {
                    const location = Number(args.location);
                    const length = Number(args.length);
                    if (!Number.isInteger(location) || location < 0) {
                        return { result: 'agent_select_range requires a non-negative integer location.', isError: true };
                    }
                    if (!Number.isInteger(length) || length < 0) {
                        return { result: 'agent_select_range requires a non-negative integer length.', isError: true };
                    }
                    const r = await runHelper(deps, [
                        'select-range', '--location', String(location), '--length', String(length),
                    ]);
                    if (r.ok) bumpSelfActionAt();
                    if (r.error) {
                        return {
                            result: `Select range failed: ${r.error}${r.detail ? ` (${r.detail})` : ''}`,
                            isError: true,
                        };
                    }
                    return {
                        result: `Selected ${r.length} chars at offset ${r.location} (of ${r.total_chars}).`,
                        isError: false,
                    };
                }

                case 'agent_select_all': {
                    const r = await runHelper(deps, ['select-all']);
                    if (r.ok) bumpSelfActionAt();
                    if (r.error) {
                        return {
                            result: `Select all failed: ${r.error}${r.detail ? ` (${r.detail})` : ''}`,
                            isError: true,
                        };
                    }
                    return {
                        result: `Selected ${r.length} of ${r.total_chars} chars.`,
                        isError: false,
                    };
                }

                case 'agent_select_substring': {
                    const needle = String(args.needle || '');
                    if (!needle) {
                        return { result: 'agent_select_substring requires non-empty needle.', isError: true };
                    }
                    const occurrence = Number.isInteger(Number(args.occurrence)) && Number(args.occurrence) >= 0
                        ? Number(args.occurrence)
                        : 0;
                    const helperArgs = ['select-substring', '--occurrence', String(occurrence), needle];
                    const r = await runHelper(deps, helperArgs);
                    if (r.ok) bumpSelfActionAt();
                    if (r.error) {
                        return {
                            result: `Select substring failed: ${r.error}${r.detail ? ` (${r.detail})` : ''}`,
                            isError: true,
                        };
                    }
                    return {
                        result: `Selected "${needle}" (occurrence ${occurrence}) at offset ${r.location}.`,
                        isError: false,
                    };
                }

                case 'agent_menu_command': {
                    const path = Array.isArray(args.path) ? args.path : null;
                    if (!path || path.length === 0) {
                        return { result: 'agent_menu_command requires a non-empty path array (e.g. ["Format","Body"]).', isError: true };
                    }
                    if (path.some((s) => typeof s !== 'string' || !s.trim())) {
                        return { result: 'agent_menu_command path must be non-empty strings.', isError: true };
                    }
                    // Rate limit through the press window — menu invocations
                    // are press-equivalent in blast radius.
                    const now = Date.now();
                    if (now - lastPressAt < PRESS_INTERVAL_MIN_MS) {
                        const wait = PRESS_INTERVAL_MIN_MS - (now - lastPressAt);
                        return { result: `Rate limited: menu command allowed in ${wait}ms.`, isError: true };
                    }
                    // User-activity guard: a menu command in the frontmost
                    // app can trigger destructive or state-changing actions.
                    // If Tom switched apps or opened a menu just before this
                    // call, the path walks the WRONG app's menu bar. Same
                    // override semantics as keystroke / type-text.
                    const force = args.force === true;
                    if (!force) {
                        const offending = detectUserActivity();
                        if (offending) {
                            return {
                                result: `Refused menu command: user activity detected (${offending.event}${offending.app ? ' in ' + offending.app : ''}). Pass force=true to override.`,
                                isError: true,
                            };
                        }
                    }
                    lastPressAt = now;
                    const r = await runHelper(deps, ['menu-command', ...path]);
                    if (r.ok) bumpSelfActionAt();
                    if (r.error) {
                        return {
                            result: `Menu command failed: ${r.error}${r.detail ? ` (${r.detail})` : ''}`,
                            isError: true,
                        };
                    }
                    return {
                        result: `Invoked menu: ${path.join(' → ')} (leaf: ${r.leaf || ''}).`,
                        isError: false,
                    };
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
        computeFrameLanding,
        FRAME_LANDING_OFFSET_PX,
    },
};
