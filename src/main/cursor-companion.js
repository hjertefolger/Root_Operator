/**
 * ROOT OPERATOR — CURSOR COMPANION
 *
 * A small dot follows the system cursor everywhere on screen. Option+Option
 * opens a bubble next to the cursor for text input. On Enter, the prompt
 * plus a cropped screenshot of the cursor area are sent through Root
 * Operator's existing channel-bridge to Claude Code; the response renders
 * back in the same cursor-anchored bubble.
 *
 * v0 ships only the cursor-area lens. Additional lenses (full-screen,
 * annotated frame, region select, window pick) are explicit out-of-scope
 * follow-ups and live behind the same Option+Option entry point.
 *
 * Per Codex review: this module owns overlay windows, cursor tracking,
 * capture, lens state, and a single-flight pending lock. It calls into the
 * existing channel-input submission path rather than reinventing a runtime.
 * Cursor screenshots are user→Claude artifacts (NOT outbound-attachments,
 * which is Claude→client). They're staged in a separate dir with their own
 * TTL and never persisted as bytes in channel-history.
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Window geometry constants
const DOT_SIZE = 24;
const DOT_OFFSET_X = 14; // dot sits to the lower-right of cursor
const DOT_OFFSET_Y = 14;
const BUBBLE_WIDTH = 360;
const BUBBLE_HEIGHT = 180;
const BUBBLE_OFFSET_X = 18;
const BUBBLE_OFFSET_Y = 18;

// Cursor polling cadence — 30Hz is fluid for a cursor companion without
// burning CPU. Bumped to 60Hz only if user feedback says it feels laggy.
const CURSOR_POLL_HZ = 30;
const CURSOR_POLL_INTERVAL_MS = Math.round(1000 / CURSOR_POLL_HZ);

// Default cursor-area screenshot crop (centered on cursor in DIP space).
// Tightish — captures what you're pointing at without snapshotting half
// the screen. Larger crops are a follow-up lens, not a v0 setting.
const CURSOR_LENS_CROP_W = 600;
const CURSOR_LENS_CROP_H = 400;

// How long a staged cursor screenshot lives on disk before sweep removes
// it. Cursor screenshots are short-lived: Claude reads the file during the
// turn, then it's no longer needed. 10 minutes is plenty for the longest
// reasonable agent turn while bounding disk growth.
const CURSOR_ATTACHMENT_TTL_MS = 10 * 60 * 1000;

// Double-tap-Option detection window. Two Option keydowns within this
// window count as the activation gesture; outside it, the second tap
// resets the state machine.
const DOUBLE_OPTION_WINDOW_MS = 320;

// Single-flight: only one pending cursor turn at a time. Phone chat plus
// cursor chat racing is a real concern (per Codex); v0 keeps things simple
// by blocking another cursor send while a reply is outstanding.
const PENDING_TIMEOUT_MS = 90_000;

let depsRef = null;
let dotWindow = null;
let bubbleWindow = null;
let cursorPollTimer = null;
let lastDotPos = { x: -1, y: -1 };
let pending = null; // { turnId, startedAt, timeoutHandle }
let optionTapState = { lastTapAt: 0 };
let isInitialized = false;
let uiohookRef = null;
let optionKeyCodes = [];
let optionListenerAttached = false;

function isUsable(win) {
    return Boolean(win && !win.isDestroyed());
}

function newTurnId() {
    return `cursor-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Initialise the cursor companion. Creates the dot window, starts the
 * cursor poll, registers the Option+Option global listener, and wires the
 * IPC channels the bubble renderer talks to.
 *
 * Required dependencies:
 *   BrowserWindow, ipcMain, screen, app, path
 *   getCursorAttachmentsDir() -> string
 *   loadRendererWindow(window, search) -> void  (from window-manager)
 *   submitChannelUserMessage(chatId, content, userId, options) -> Promise<{success}>
 *   getOperatingMode() -> 'terminal' | 'channel'
 *   uiohook (uiohook-napi instance, optional — pass null to disable
 *     Option+Option until after Accessibility prompt; the tray menu can
 *     still call showBubble() programmatically)
 *   logDebug(message) -> void
 *
 * Design notes per Codex review:
 *   - Two windows (dot passive + bubble transient), both 'floating' level
 *   - Click-through dot via setIgnoreMouseEvents(true, { forward: true })
 *   - Cursor poll via screen.getCursorScreenPoint() at ~30Hz
 *   - Capture via `screencapture -x -R x,y,w,h` shell, hide overlay first
 *   - Lens shortcuts (other lenses) are NOT registered globally; they fire
 *     only while the bubble is open — done in the renderer via key events,
 *     not via electron globalShortcut
 */
function init(deps) {
    if (isInitialized) {
        return getApi();
    }

    const required = [
        'BrowserWindow', 'ipcMain', 'screen', 'app',
        'getCursorAttachmentsDir', 'loadRendererWindow',
        'submitChannelUserMessage', 'getOperatingMode',
    ];
    for (const key of required) {
        if (deps[key] == null) {
            throw new TypeError(`cursor-companion.init missing dependency: ${key}`);
        }
    }

    depsRef = {
        ...deps,
        logDebug: typeof deps.logDebug === 'function' ? deps.logDebug : () => {},
    };

    registerIpcHandlers();
    isInitialized = true;
    depsRef.logDebug('[CURSOR] Companion module initialised (not started)');
    return getApi();
}

function getApi() {
    return {
        start,
        stop,
        showBubble,
        hideBubble,
        handleChannelReply,
        attachOptionListener,
        detachOptionListener,
        isPending: () => pending !== null,
    };
}

/**
 * Attach a keydown listener to the existing uIOhook singleton (already
 * started by tray's double-Shift wiring). Detects Option-tap pairs and
 * calls noteOptionTap, which opens the bubble on the second tap.
 *
 * Per Codex review: lens shortcuts (Cmd+Shift+S/A/R/W) should NOT be
 * registered globally — they conflict with common app UI. They're handled
 * inside the bubble renderer via key events instead. The only globally
 * listened key is Option, and only as a double-tap activation.
 */
function attachOptionListener() {
    if (optionListenerAttached) return;
    try {
        // Same singleton tray.js uses. Safe to require independently —
        // uiohook-napi exports a single instance.
        const { uIOhook, UiohookKey } = require('uiohook-napi');
        uiohookRef = uIOhook;
        // Mac Option = Alt in uiohook's vocabulary. Both left and right.
        optionKeyCodes = [UiohookKey.Alt, UiohookKey.AltRight].filter((k) => k != null);
        if (optionKeyCodes.length === 0) {
            depsRef.logDebug('[CURSOR] uiohook-napi exposes no Alt key codes; Option-tap disabled');
            return;
        }
        uiohookRef.on('keydown', handleOptionKeyDown);
        optionListenerAttached = true;
        depsRef.logDebug('[CURSOR] Double-Option activation listener attached');
    } catch (err) {
        depsRef.logDebug(`[CURSOR] Failed to attach Option listener: ${err.message}`);
    }
}

function detachOptionListener() {
    if (!optionListenerAttached || !uiohookRef) return;
    try {
        uiohookRef.off('keydown', handleOptionKeyDown);
    } catch (err) {
        depsRef.logDebug(`[CURSOR] detach Option listener failed: ${err.message}`);
    }
    optionListenerAttached = false;
    uiohookRef = null;
    optionKeyCodes = [];
}

function handleOptionKeyDown(event) {
    if (!event || !optionKeyCodes.includes(event.keycode)) {
        // Any non-Option keydown breaks an in-progress Option-pair so
        // "Option + something" doesn't accidentally count as a tap pair.
        if (event && optionTapState.lastTapAt !== 0 && !optionKeyCodes.includes(event.keycode)) {
            optionTapState.lastTapAt = 0;
        }
        return;
    }
    noteOptionTap();
}

/**
 * Begin tracking the cursor and showing the dot. Called after the desktop
 * shell is ready and the user has had a chance to grant permissions.
 * Idempotent.
 */
function start() {
    if (!isInitialized) {
        throw new Error('cursor-companion.start called before init');
    }
    if (dotWindow) {
        return; // already started
    }

    createDotWindow();
    startCursorPoll();
    depsRef.logDebug('[CURSOR] Companion started — dot tracking cursor');
}

/**
 * Stop tracking and tear down the dot/bubble. Used by tests and by
 * graceful shutdown. Idempotent.
 */
function stop() {
    stopCursorPoll();
    detachOptionListener();
    hideBubble();
    if (isUsable(dotWindow)) {
        dotWindow.close();
    }
    dotWindow = null;
    if (pending && pending.timeoutHandle) {
        clearTimeout(pending.timeoutHandle);
    }
    pending = null;
    depsRef && depsRef.logDebug && depsRef.logDebug('[CURSOR] Companion stopped');
}

// ─── Window factories ───────────────────────────────────────────────────

function createDotWindow() {
    const { BrowserWindow, app, loadRendererWindow } = depsRef;
    const win = new BrowserWindow({
        width: DOT_SIZE,
        height: DOT_SIZE,
        x: 0,
        y: 0,
        show: false,
        frame: false,
        transparent: true,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        focusable: false,
        hasShadow: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(app.getAppPath(), 'preload.js'),
            sandbox: true,
            backgroundThrottling: false,
        },
    });

    // Stay above ordinary app windows but below system alerts.
    win.setAlwaysOnTop(true, 'floating');
    win.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
        skipTransformProcessType: true,
    });
    if (typeof win.setHiddenInMissionControl === 'function') {
        win.setHiddenInMissionControl(true);
    }
    // Click-through. forward: true keeps Chromium aware of mouse movement
    // so any future hover affordance still works, while clicks pass to
    // whatever's underneath.
    win.setIgnoreMouseEvents(true, { forward: true });

    loadRendererWindow(win, '?view=cursor-dot');

    win.once('ready-to-show', () => {
        if (isUsable(win)) {
            win.showInactive();
        }
    });

    win.on('closed', () => {
        if (dotWindow === win) {
            dotWindow = null;
        }
    });

    dotWindow = win;
    return win;
}

function createBubbleWindow(anchor) {
    const { BrowserWindow, app, loadRendererWindow } = depsRef;
    const win = new BrowserWindow({
        width: BUBBLE_WIDTH,
        height: BUBBLE_HEIGHT,
        x: anchor.x,
        y: anchor.y,
        show: false,
        frame: false,
        transparent: true,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        hasShadow: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(app.getAppPath(), 'preload.js'),
            sandbox: true,
            backgroundThrottling: false,
        },
    });

    win.setAlwaysOnTop(true, 'floating');
    win.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
        skipTransformProcessType: true,
    });
    if (typeof win.setHiddenInMissionControl === 'function') {
        win.setHiddenInMissionControl(true);
    }

    loadRendererWindow(win, '?view=cursor-bubble');

    win.once('ready-to-show', () => {
        if (isUsable(win)) {
            win.show();
            win.focus();
        }
    });

    win.on('blur', () => {
        // Auto-dismiss on focus loss: user clicking elsewhere is the
        // natural "I'm done with this turn" gesture.
        if (!pending) {
            hideBubble();
        }
    });

    win.on('closed', () => {
        if (bubbleWindow === win) {
            bubbleWindow = null;
        }
    });

    bubbleWindow = win;
    return win;
}

// ─── Cursor tracking ────────────────────────────────────────────────────

function startCursorPoll() {
    if (cursorPollTimer) return;
    cursorPollTimer = setInterval(updateDotPosition, CURSOR_POLL_INTERVAL_MS);
}

function stopCursorPoll() {
    if (cursorPollTimer) {
        clearInterval(cursorPollTimer);
        cursorPollTimer = null;
    }
}

function updateDotPosition() {
    if (!isUsable(dotWindow)) return;

    const point = depsRef.screen.getCursorScreenPoint();
    const targetX = point.x + DOT_OFFSET_X;
    const targetY = point.y + DOT_OFFSET_Y;
    if (targetX === lastDotPos.x && targetY === lastDotPos.y) {
        return;
    }
    lastDotPos = { x: targetX, y: targetY };
    try {
        dotWindow.setPosition(targetX, targetY, false);
    } catch (err) {
        depsRef.logDebug(`[CURSOR] setPosition failed: ${err.message}`);
    }
}

// ─── Activation / dismissal ─────────────────────────────────────────────

/**
 * Open the bubble next to the current cursor position. Called by the
 * Option+Option handler (registered by main.js via uiohook).
 */
function showBubble() {
    if (!isInitialized) return;
    if (isUsable(bubbleWindow)) {
        bubbleWindow.show();
        bubbleWindow.focus();
        return;
    }
    const point = depsRef.screen.getCursorScreenPoint();
    const anchor = clampAnchor({
        x: point.x + BUBBLE_OFFSET_X,
        y: point.y + BUBBLE_OFFSET_Y,
    });
    createBubbleWindow(anchor);
}

function hideBubble() {
    if (!isUsable(bubbleWindow)) return;
    try { bubbleWindow.close(); } catch (_) {}
    bubbleWindow = null;
}

/**
 * Bubble must stay on the same display as the cursor and not slide off
 * the right/bottom edge. Tooltip-style flip when there isn't room.
 */
function clampAnchor({ x, y }) {
    const display = depsRef.screen.getDisplayNearestPoint({ x, y });
    const bounds = display.workArea; // excludes menu bar / dock
    let nx = x;
    let ny = y;
    if (nx + BUBBLE_WIDTH > bounds.x + bounds.width) {
        nx = Math.max(bounds.x, bounds.x + bounds.width - BUBBLE_WIDTH - 8);
    }
    if (ny + BUBBLE_HEIGHT > bounds.y + bounds.height) {
        ny = Math.max(bounds.y, bounds.y + bounds.height - BUBBLE_HEIGHT - 8);
    }
    return { x: Math.round(nx), y: Math.round(ny) };
}

/**
 * Public: invoked by the Option-key handler. State machine is just two
 * timestamps — second tap within the window opens the bubble; otherwise
 * the second tap becomes the new "first" tap.
 */
function noteOptionTap() {
    const now = Date.now();
    if (now - optionTapState.lastTapAt <= DOUBLE_OPTION_WINDOW_MS) {
        optionTapState.lastTapAt = 0; // consume the pair
        showBubble();
        return true;
    }
    optionTapState.lastTapAt = now;
    return false;
}

// ─── Capture ────────────────────────────────────────────────────────────

/**
 * Capture a region of the screen using `screencapture`. Hides the overlay
 * before snapshotting so the dot/bubble aren't in the frame, waits for the
 * compositor, then captures. Returns the absolute path of the staged file.
 */
async function captureCursorArea() {
    const point = depsRef.screen.getCursorScreenPoint();
    const display = depsRef.screen.getDisplayNearestPoint(point);
    const cropX = Math.max(
        display.bounds.x,
        Math.min(point.x - CURSOR_LENS_CROP_W / 2, display.bounds.x + display.bounds.width - CURSOR_LENS_CROP_W),
    );
    const cropY = Math.max(
        display.bounds.y,
        Math.min(point.y - CURSOR_LENS_CROP_H / 2, display.bounds.y + display.bounds.height - CURSOR_LENS_CROP_H),
    );

    const dir = depsRef.getCursorAttachmentsDir();
    fs.mkdirSync(dir, { recursive: true });
    const filename = `cursor-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.png`;
    const filepath = path.join(dir, filename);

    await hideOverlayForCapture();
    try {
        await runScreencapture({
            x: Math.round(cropX),
            y: Math.round(cropY),
            w: CURSOR_LENS_CROP_W,
            h: CURSOR_LENS_CROP_H,
            outPath: filepath,
        });
    } finally {
        await restoreOverlayAfterCapture();
    }

    return { path: filepath, rect: { x: cropX, y: cropY, w: CURSOR_LENS_CROP_W, h: CURSOR_LENS_CROP_H } };
}

function hideOverlayForCapture() {
    return new Promise((resolve) => {
        if (isUsable(dotWindow)) dotWindow.hide();
        if (isUsable(bubbleWindow)) bubbleWindow.hide();
        // One animation frame for the compositor to actually drop the
        // overlay before screencapture grabs the frame.
        setTimeout(resolve, 32);
    });
}

function restoreOverlayAfterCapture() {
    return new Promise((resolve) => {
        if (isUsable(dotWindow)) dotWindow.showInactive();
        if (isUsable(bubbleWindow)) {
            bubbleWindow.show();
            bubbleWindow.focus();
        }
        resolve();
    });
}

function runScreencapture({ x, y, w, h, outPath }) {
    return new Promise((resolve, reject) => {
        const args = ['-x', '-R', `${x},${y},${w},${h}`, outPath];
        const proc = spawn('/usr/sbin/screencapture', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
        proc.on('error', reject);
        proc.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`screencapture exited ${code}: ${stderr.trim()}`));
        });
    });
}

// ─── Submission flow ────────────────────────────────────────────────────

const CURSOR_CHAT_ID = 'cursor-companion';

async function submitFromBubble({ prompt }) {
    if (pending) {
        return { success: false, error: 'A previous cursor turn is still in flight.' };
    }
    if (typeof prompt !== 'string' || prompt.trim().length === 0) {
        return { success: false, error: 'Empty prompt' };
    }
    if (depsRef.getOperatingMode() !== 'channel') {
        return { success: false, error: 'Channel mode is not active.' };
    }

    let capture;
    try {
        capture = await captureCursorArea();
    } catch (err) {
        depsRef.logDebug(`[CURSOR] Capture failed: ${err.message}`);
        return { success: false, error: `Could not capture screen: ${err.message}` };
    }

    const turnId = newTurnId();
    pending = {
        turnId,
        startedAt: Date.now(),
        timeoutHandle: setTimeout(() => clearPendingForTimeout(turnId), PENDING_TIMEOUT_MS),
        attachmentPath: capture.path,
    };

    // The agent reads the screenshot via its Read tool — so we send a
    // prompt that explicitly references the file path. This is the
    // file-reference path Codex flagged as the cleanest v0 integration:
    // no channel-envelope extension, just a text message that points the
    // agent at the staged image.
    const composedContent = [
        `Cursor companion: I'm pointing at something on my screen.`,
        `Read the screenshot at ${capture.path}.`,
        `Crop is ${CURSOR_LENS_CROP_W}×${CURSOR_LENS_CROP_H} centred on the cursor.`,
        ``,
        prompt.trim(),
    ].join('\n');

    try {
        const result = await depsRef.submitChannelUserMessage(
            CURSOR_CHAT_ID,
            composedContent,
            CURSOR_CHAT_ID,
            { echoToLocalChat: false },
        );
        if (!result || result.success === false) {
            clearPending();
            return { success: false, error: result?.error || 'Channel submission failed' };
        }
        return { success: true, turnId };
    } catch (err) {
        clearPending();
        depsRef.logDebug(`[CURSOR] Submit error: ${err.message}`);
        return { success: false, error: err.message };
    }
}

function clearPending() {
    if (pending && pending.timeoutHandle) {
        clearTimeout(pending.timeoutHandle);
    }
    pending = null;
}

function clearPendingForTimeout(turnId) {
    if (pending && pending.turnId === turnId) {
        depsRef.logDebug(`[CURSOR] Pending turn ${turnId} timed out after ${PENDING_TIMEOUT_MS}ms`);
        if (isUsable(bubbleWindow)) {
            bubbleWindow.webContents.send('CURSOR_REPLY_TIMEOUT');
        }
        clearPending();
    }
}

/**
 * Forward a channel reply to the bubble window when a cursor turn is
 * pending. main.js wires this from wherever the channel-mode reply
 * handler lives. Caller passes the assistant message content + ts; we
 * relay to the bubble renderer and clear the pending lock.
 */
function handleChannelReply({ content, ts, role = 'assistant' }) {
    if (!pending) return false; // not ours
    if (!isUsable(bubbleWindow)) {
        clearPending();
        return false;
    }
    bubbleWindow.webContents.send('CURSOR_REPLY', {
        turnId: pending.turnId,
        content,
        ts,
        role,
    });
    clearPending();
    return true;
}

// ─── IPC handlers ───────────────────────────────────────────────────────

function registerIpcHandlers() {
    const { ipcMain } = depsRef;

    ipcMain.handle('CURSOR_SUBMIT', async (event, payload = {}) => {
        if (!isFromBubbleWindow(event)) {
            return { success: false, error: 'unauthorized' };
        }
        return submitFromBubble({ prompt: payload.prompt });
    });

    ipcMain.handle('CURSOR_DISMISS', (event) => {
        if (!isFromBubbleWindow(event)) {
            return { success: false, error: 'unauthorized' };
        }
        hideBubble();
        return { success: true };
    });

    ipcMain.handle('CURSOR_GET_PENDING', (event) => {
        if (!isFromBubbleWindow(event)) {
            return { pending: false };
        }
        return { pending: pending !== null, turnId: pending?.turnId || null };
    });
}

function isFromBubbleWindow(event) {
    if (!isUsable(bubbleWindow)) return false;
    return event && event.sender === bubbleWindow.webContents;
}

module.exports = {
    init,
    // Internals exposed for testing only.
    __test: {
        noteOptionTap,
        getPendingForTest: () => pending,
        clampAnchorForTest: (anchor) => clampAnchor(anchor),
        resetTapStateForTest: () => { optionTapState.lastTapAt = 0; },
        setScreenForTest: (screen) => {
            depsRef = depsRef || {};
            depsRef.screen = screen;
        },
        DOUBLE_OPTION_WINDOW_MS,
        CURSOR_LENS_CROP_W,
        CURSOR_LENS_CROP_H,
    },
};
