/**
 * ROOT OPERATOR — CURSOR COMPANION
 *
 * Cursor-anchored ambient surface. Layers stack vertically below the
 * cursor, each independently visible:
 *
 *   1. dot          — ambient idle marker
 *   2. loader       — two-dot indicator while a turn is in flight
 *   3. input pill   — composer for the next prompt
 *   4. reply stack  — completed assistant messages, latest on top
 *
 * Any combination is valid. Loader can be visible while the user is
 * typing a follow-up; replies can stack underneath both. When a layer
 * exits, the layers below smoothly slide up into the freed slot.
 *
 * Concurrent-turn semantics mirror desktop/web chat: there is no
 * single-flight rejection. The user may submit while a previous turn is
 * still in flight; both replies will land in the stack in arrival order.
 *
 * Mouse events are click-through except where a focusable layer is
 * visible (input or any reply). Keyboard input flows to the renderer
 * because the window is an NSPanel that can become key.
 *
 * The capture + submission flow: on Option+Enter we hide the overlay,
 * run `screencapture -x -R`, restore, and submit through the existing
 * channel-bridge with a system-reminder envelope referencing the staged
 * screenshot. The reply is forwarded back to the same renderer.
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Window is sized large enough to host every layer combination without
// resizing the native window mid-animation (which fights CSS transitions).
const WIN_WIDTH = 720;
const WIN_HEIGHT = 720;

// Cursor anchor inside the window: the mouse pointer-arrow corresponds
// to (ANCHOR_X, ANCHOR_Y) in window-local coordinates.
const ANCHOR_X = 16;
const ANCHOR_Y = 16;

// Cursor polling cadence — match standard 60Hz so the dot doesn't chop
// next to the native cursor. setPosition is gated on movement.
const CURSOR_POLL_HZ = 60;
const CURSOR_POLL_INTERVAL_MS = Math.round(1000 / CURSOR_POLL_HZ);

// Cursor-area screenshot crop in DIP space.
const CURSOR_LENS_CROP_W = 800;
const CURSOR_LENS_CROP_H = 800;

// Stage-attachment TTL.
const CURSOR_ATTACHMENT_TTL_MS = 10 * 60 * 1000;

// Sweep cadence for stale screenshot attachments.
const CURSOR_ATTACHMENT_SWEEP_INTERVAL_MS = 60 * 1000;

// Maximum visible replies in the stack. Older replies fall off the
// visible deck but remain in the channel-history that drives all other
// surfaces.
const REPLY_STACK_CAP = 3;

// Grace window for terminal activity arriving before any reply. macOS
// activity stream and websocket reply delivery are independent; the
// `finished` phase can fire before the `claude_reply` socket message
// lands. The grace timer holds loading state for this many ms after
// terminal-without-reply, cancelled by handleChannelReply.
const TERMINAL_GRACE_MS = 750;

const CURSOR_CHAT_ID = 'cursor-companion';

// Suppression window after a Shift+Shift gesture is dispatched. Both
// the renderer-side detector (textarea keydown) and the tray-side
// uIOhook keyup detector observe the same physical double-tap. Whichever
// fires first claims the gesture; subsequent dispatches inside this
// window are dropped.
const GESTURE_LOCK_MS = 250;

// Drafts are in-memory only and time-bounded. 12h is generous enough to
// survive a meeting/lunch/etc but short enough that a draft from
// yesterday won't surprise-restore in a long-running app session.
const DRAFT_TTL_MS = 12 * 60 * 60 * 1000;

// Last reply persists across dismissals so a future triple-tap gesture
// can recall it.
const LAST_REPLY_TTL_MS = 30 * 60 * 1000;

let depsRef = null;
let win = null;
let cursorPollTimer = null;
let attachmentSweepTimer = null;
let lastWinPos = { x: -1, y: -1 };
let pending = null;
let isInitialized = false;
let uiohookRef = null;
let shiftKeyCodes = [];
let escKeyCode = null;
let mouseListenerAttached = false;
let isShiftHeld = false;

// Layered visibility. Each is independent.
let inputOpen = false;
let replies = []; // array of { id, content, ts, role }
let terminalGraceTimer = null;
let terminalGraceTurnId = null;

// Half-written prompt persists across dismissals. Cleared on successful submit.
let draftPrompt = '';
let draftUpdatedAt = 0;

// Stored on every assistant reply for future triple-Shift recall.
let lastReply = null;
let lastReplyUpdatedAt = 0;

// Gesture suppression: timestamp until which subsequent gesture
// dispatches should be ignored.
let gestureLockUntil = 0;

// Cursor-following pause. While parked the window stays at its current
// screen position so the user can move the system cursor onto a
// reply/input layer to interact with it. Auto-cleared when input closes.
let isParked = false;

function isUsable(w) {
    return Boolean(w && !w.isDestroyed());
}

function newTurnId() {
    return `cursor-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

function newReplyId() {
    return `reply-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * Derived single-word "mode" for legacy callers and tests.
 * Priority: input > response (replies present) > loading > dot.
 * Loading combined with input/replies still surfaces as the foreground
 * layer's name; the loader is a co-resident layer, not a mode.
 */
function getMode() {
    if (inputOpen) return 'input';
    if (replies.length > 0) return 'response';
    if (pending !== null) return 'loading';
    return 'dot';
}

function isLoading() {
    return pending !== null;
}

function init(deps) {
    if (isInitialized) return getApi();

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
        showInput,
        dismiss,
        handleChannelReply,
        handleChannelActivity,
        toggleFromHotkey,
        notifyEnabledChanged,
        isPending: () => pending !== null,
        getMode,
    };
}

/**
 * Tell the renderer that the master enabled flag flipped.
 */
function notifyEnabledChanged(enabled) {
    if (!isUsable(win)) return;
    const value = Boolean(enabled);
    const send = () => {
        if (!isUsable(win)) return;
        try {
            win.webContents.send('CURSOR_ENABLED_CHANGED', { enabled: value });
        } catch (err) {
            depsRef && depsRef.logDebug && depsRef.logDebug(`[CURSOR] notifyEnabledChanged failed: ${err.message}`);
        }
    };
    try {
        if (win.webContents.isLoading()) {
            win.webContents.once('did-finish-load', send);
            return;
        }
    } catch (_) { /* fall through to immediate send */ }
    send();
}

/**
 * Single Shift+Shift gesture entry. Per-mode mapping:
 *   input open                → close input (preserve draft)
 *   input closed (any layers) → open input (restore draft if any)
 *   nothing visible           → open input
 *
 * Loading state alone no longer blocks the gesture — concurrent-turn
 * UX means the user can compose a follow-up while a turn is in flight.
 */
function handleShiftGesture(source = 'tray', options = {}) {
    if (!isInitialized) return;

    if (source === 'renderer' && typeof options.prompt === 'string') {
        setDraftPrompt(options.prompt);
    }

    const now = Date.now();
    if (now < gestureLockUntil) {
        depsRef.logDebug(`[CURSOR] gesture suppressed (source=${source})`);
        return;
    }
    gestureLockUntil = now + GESTURE_LOCK_MS;

    if (inputOpen) {
        closeInput();
        return;
    }
    openInput();
}

function toggleFromHotkey() {
    handleShiftGesture('tray');
}

function attachInputListeners() {
    if (mouseListenerAttached) return;
    try {
        const { uIOhook, UiohookKey } = require('uiohook-napi');
        uiohookRef = uIOhook;
        shiftKeyCodes = [UiohookKey.Shift, UiohookKey.ShiftRight].filter((k) => k != null);
        escKeyCode = UiohookKey.Escape != null ? UiohookKey.Escape : null;
        uiohookRef.on('keydown', handleShiftKeyDown);
        uiohookRef.on('keydown', handleGlobalEscDown);
        uiohookRef.on('keyup', handleShiftKeyUp);
        uiohookRef.on('mousedown', handleGlobalMouseDown);
        mouseListenerAttached = true;
        depsRef.logDebug('[CURSOR] Shift + Esc + global click listeners attached');
    } catch (err) {
        depsRef.logDebug(`[CURSOR] Failed to attach input listeners: ${err.message}`);
    }
}

function detachInputListeners() {
    if (!mouseListenerAttached || !uiohookRef) return;
    try {
        uiohookRef.off('keydown', handleShiftKeyDown);
        uiohookRef.off('keydown', handleGlobalEscDown);
        uiohookRef.off('keyup', handleShiftKeyUp);
        uiohookRef.off('mousedown', handleGlobalMouseDown);
    } catch (err) {
        depsRef.logDebug(`[CURSOR] detach input listeners failed: ${err.message}`);
    }
    mouseListenerAttached = false;
    uiohookRef = null;
    shiftKeyCodes = [];
    escKeyCode = null;
    isShiftHeld = false;
}

function handleShiftKeyDown(event) {
    if (!event || !shiftKeyCodes.includes(event.keycode)) return;
    if (isShiftHeld) return;
    isShiftHeld = true;
    applyInteractivity();
}

function handleShiftKeyUp(event) {
    if (!event || !shiftKeyCodes.includes(event.keycode)) return;
    if (!isShiftHeld) return;
    isShiftHeld = false;
    applyInteractivity();
}

/**
 * Right-click anywhere dismisses the topmost reply. While the bubble
 * is following the cursor (the common case), the cursor is never over
 * the bubble itself, so hit-testing the click against the reply rect
 * would always fail by design. Parked mode can put the cursor over
 * the bubble, but the dismiss-on-right-click intent holds either way:
 * the user wants this reply gone.
 *
 * Loading is intentionally still not click-dismissable.
 */
function handleGlobalMouseDown(event) {
    if (replies.length === 0) return;
    if (!event || event.button !== 2) return;
    if (!isUsable(win)) return;
    try {
        win.webContents.send('CURSOR_RIGHT_CLICK', {});
    } catch (_) {}
}

/**
 * Esc dismisses layers in priority order: input first (preserve draft),
 * then the entire reply stack. Renderer's own keydown handles the
 * input-mode case; this handler only fires when input is closed.
 */
function handleGlobalEscDown(event) {
    if (!event || event.keycode !== escKeyCode) return;
    if (inputOpen) return; // renderer handles the input-mode Esc
    if (replies.length === 0) return;
    clearReplies();
}

function start() {
    if (!isInitialized) {
        throw new Error('cursor-companion.start called before init');
    }
    if (win) return;
    createWindow();
    startCursorPoll();
    attachInputListeners();
    startAttachmentSweep();
    depsRef.logDebug('[CURSOR] Companion started');
}

function stop() {
    stopCursorPoll();
    stopAttachmentSweep();
    detachInputListeners();
    if (terminalGraceTimer) {
        clearTimeout(terminalGraceTimer);
        terminalGraceTimer = null;
        terminalGraceTurnId = null;
    }
    if (isUsable(win)) {
        try { win.close(); } catch (_) {}
    }
    win = null;
    pending = null;
    inputOpen = false;
    replies = [];
    gestureLockUntil = 0;
    isParked = false;
    isShiftHeld = false;
    lastWinPos = { x: -1, y: -1 };
    depsRef && depsRef.logDebug && depsRef.logDebug('[CURSOR] Companion stopped');
}

function createWindow() {
    const { BrowserWindow, app, loadRendererWindow } = depsRef;
    const w = new BrowserWindow({
        width: WIN_WIDTH,
        height: WIN_HEIGHT,
        x: 0,
        y: 0,
        show: false,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        // NSPanel on macOS — can become key window without activating
        // our entire app or stealing dock focus.
        type: process.platform === 'darwin' ? 'panel' : undefined,
        focusable: true,
        hasShadow: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(app.getAppPath(), 'preload.js'),
            sandbox: true,
            backgroundThrottling: false,
        },
    });

    w.setAlwaysOnTop(true, 'floating');
    w.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
        skipTransformProcessType: true,
    });
    if (typeof w.setHiddenInMissionControl === 'function') {
        w.setHiddenInMissionControl(true);
    }
    w.setIgnoreMouseEvents(true, { forward: true });

    loadRendererWindow(w, '?view=cursor-companion');

    w.once('ready-to-show', () => {
        if (isUsable(w)) {
            w.showInactive();
        }
    });

    w.on('closed', () => {
        if (win === w) win = null;
    });

    win = w;
    return w;
}

function startCursorPoll() {
    if (cursorPollTimer) return;
    updateWindowPosition();
    cursorPollTimer = setInterval(updateWindowPosition, CURSOR_POLL_INTERVAL_MS);
}

function stopCursorPoll() {
    if (cursorPollTimer) {
        clearInterval(cursorPollTimer);
        cursorPollTimer = null;
    }
}

function updateWindowPosition() {
    if (!isUsable(win)) return;
    if (isParked) return;

    const point = depsRef.screen.getCursorScreenPoint();
    const targetX = point.x - ANCHOR_X;
    const targetY = point.y - ANCHOR_Y;
    if (targetX === lastWinPos.x && targetY === lastWinPos.y) return;
    lastWinPos = { x: targetX, y: targetY };
    try {
        win.setPosition(targetX, targetY, false);
    } catch (err) {
        depsRef.logDebug(`[CURSOR] setPosition failed: ${err.message}`);
    }
}

function startAttachmentSweep() {
    if (attachmentSweepTimer) return;
    sweepStaleAttachments();
    attachmentSweepTimer = setInterval(sweepStaleAttachments, CURSOR_ATTACHMENT_SWEEP_INTERVAL_MS);
}

function stopAttachmentSweep() {
    if (attachmentSweepTimer) {
        clearInterval(attachmentSweepTimer);
        attachmentSweepTimer = null;
    }
}

function sweepStaleAttachments() {
    try {
        const dir = depsRef.getCursorAttachmentsDir();
        if (!fs.existsSync(dir)) return;
        const cutoff = Date.now() - CURSOR_ATTACHMENT_TTL_MS;
        for (const name of fs.readdirSync(dir)) {
            const filepath = path.join(dir, name);
            try {
                const stat = fs.statSync(filepath);
                if (stat.mtimeMs < cutoff) {
                    fs.unlinkSync(filepath);
                }
            } catch (_) { /* file may have been removed already */ }
        }
    } catch (err) {
        depsRef.logDebug(`[CURSOR] attachment sweep failed: ${err.message}`);
    }
}

// ─── State broadcasting ────────────────────────────────────────────────

function broadcastState(extra = {}) {
    if (!isUsable(win)) return;
    try {
        win.webContents.send('CURSOR_STATE', {
            loading: isLoading(),
            inputOpen,
            replies: replies.slice(),
            isParked,
            ...extra,
        });
    } catch (err) {
        depsRef.logDebug(`[CURSOR] broadcastState failed: ${err.message}`);
    }
}

function applyInteractivity() {
    if (!isUsable(win)) return;
    // Window must accept mouse events whenever any focusable layer is
    // visible: input pill OR any reply (right-click / scroll / hover).
    const interactive = inputOpen || replies.length > 0;
    if (interactive) {
        win.setIgnoreMouseEvents(false);
    } else {
        win.setIgnoreMouseEvents(true, { forward: true });
    }
}

function getFreshDraft() {
    if (!draftPrompt) return '';
    if (Date.now() - draftUpdatedAt > DRAFT_TTL_MS) {
        draftPrompt = '';
        draftUpdatedAt = 0;
        return '';
    }
    return draftPrompt;
}

function setDraftPrompt(next) {
    const value = typeof next === 'string' ? next : '';
    if (value.length === 0) {
        draftPrompt = '';
        draftUpdatedAt = 0;
        return;
    }
    draftPrompt = value;
    draftUpdatedAt = Date.now();
}

function clearDraftPrompt() {
    draftPrompt = '';
    draftUpdatedAt = 0;
}

function setLastReply(content, ts) {
    if (typeof content !== 'string' || content.length === 0) return;
    lastReply = { content, ts: ts || null };
    lastReplyUpdatedAt = Date.now();
}

function getFreshLastReply() {
    if (!lastReply) return null;
    if (Date.now() - lastReplyUpdatedAt > LAST_REPLY_TTL_MS) {
        lastReply = null;
        lastReplyUpdatedAt = 0;
        return null;
    }
    return lastReply;
}

// ─── Layer transitions ─────────────────────────────────────────────────

function openInput() {
    if (!isInitialized || !isUsable(win)) return;
    inputOpen = true;
    isParked = false;
    try { win.focus(); } catch (_) {}
    applyInteractivity();
    broadcastState({ event: 'input_opened', draftPrompt: getFreshDraft() });
}

function closeInput() {
    if (!inputOpen) return;
    inputOpen = false;
    isParked = false;
    applyInteractivity();
    broadcastState({ event: 'input_closed' });
}

function clearReplies() {
    if (replies.length === 0) return;
    replies = [];
    applyInteractivity();
    broadcastState({ event: 'replies_cleared' });
}

function dismissReplyById(id) {
    const before = replies.length;
    replies = replies.filter((r) => r.id !== id);
    if (replies.length === before) return false;
    applyInteractivity();
    broadcastState({ event: 'reply_dismissed', dismissedId: id });
    return true;
}

function pushReply({ content, ts, role = 'assistant' }) {
    if (typeof content !== 'string' || content.trim().length === 0) return;
    replies.push({ id: newReplyId(), content, ts: ts || null, role });
    while (replies.length > REPLY_STACK_CAP) replies.shift();
    setLastReply(content, ts);
    applyInteractivity();
    broadcastState({ event: 'reply_appended' });
}

function showInput() {
    openInput();
}

/**
 * Full dismiss to dot — clears everything. Used by the legacy dismiss
 * IPC for callers that want the old "back to ambient" behaviour.
 */
function dismiss() {
    if (!isInitialized) return;
    inputOpen = false;
    replies = [];
    isParked = false;
    applyInteractivity();
    broadcastState({ event: 'dismissed' });
}

// ─── Capture ────────────────────────────────────────────────────────────

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
    const filename = `presence-${crypto.randomBytes(3).toString('hex')}.png`;
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

    return {
        path: filepath,
        rect: { x: cropX, y: cropY, w: CURSOR_LENS_CROP_W, h: CURSOR_LENS_CROP_H },
        mode: 'cursor',
    };
}

async function captureFullScreen() {
    const point = depsRef.screen.getCursorScreenPoint();
    const display = depsRef.screen.getDisplayNearestPoint(point);

    const dir = depsRef.getCursorAttachmentsDir();
    fs.mkdirSync(dir, { recursive: true });
    const filename = `presence-${crypto.randomBytes(3).toString('hex')}.png`;
    const filepath = path.join(dir, filename);

    await hideOverlayForCapture();
    try {
        await runScreencapture({
            x: display.bounds.x,
            y: display.bounds.y,
            w: display.bounds.width,
            h: display.bounds.height,
            outPath: filepath,
        });
    } finally {
        await restoreOverlayAfterCapture();
    }

    return {
        path: filepath,
        rect: {
            x: display.bounds.x,
            y: display.bounds.y,
            w: display.bounds.width,
            h: display.bounds.height,
        },
        mode: 'fullscreen',
    };
}

function hideOverlayForCapture() {
    return new Promise((resolve) => {
        if (isUsable(win)) win.hide();
        setTimeout(resolve, 32);
    });
}

function restoreOverlayAfterCapture() {
    return new Promise((resolve) => {
        if (isUsable(win)) win.showInactive();
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

async function submitFromBubble({ prompt, screenshot = 'none' }) {
    if (typeof prompt !== 'string' || prompt.trim().length === 0) {
        return { success: false, error: 'Empty prompt' };
    }
    if (depsRef.getOperatingMode() !== 'channel') {
        return { success: false, error: 'Channel mode is not active.' };
    }

    const captureMode = screenshot === 'cursor' || screenshot === 'fullscreen' ? screenshot : 'none';

    // Concurrent turns are allowed — channel-bridge serialises behind
    // the scenes, but the cursor surface lets the user compose and fire
    // as fast as they want. New submission replaces the current pending
    // marker; older turns still flow through, their replies arriving on
    // the stack via handleChannelReply.
    const turnId = newTurnId();
    pending = { turnId, startedAt: Date.now(), attachmentPath: null };

    if (terminalGraceTimer) {
        clearTimeout(terminalGraceTimer);
        terminalGraceTimer = null;
        terminalGraceTurnId = null;
    }

    // Closing input is part of the submit gesture — replies smoothly
    // shift up into the freed slot in the renderer.
    inputOpen = false;
    isParked = false;
    applyInteractivity();
    broadcastState({ event: 'turn_submitted', turnId });

    let capture = null;
    if (captureMode !== 'none') {
        try {
            capture = captureMode === 'fullscreen'
                ? await captureFullScreen()
                : await captureCursorArea();
        } catch (err) {
            depsRef.logDebug(`[CURSOR] Capture (${captureMode}) failed: ${err.message}`);
            if (pending && pending.turnId === turnId) {
                pending = null;
                broadcastState({ event: 'capture_failed', turnId });
            }
            return { success: false, error: `Could not capture screen: ${err.message}` };
        }
        if (!pending || pending.turnId !== turnId) {
            try { fs.unlinkSync(capture.path); } catch (_) {}
            return { success: false, error: 'Turn was cancelled' };
        }
        pending.attachmentPath = capture.path;
    }

    const composedContent = capture
        ? [
            prompt.trim(),
            ``,
            `<system-reminder>`,
            capture.mode === 'fullscreen'
                ? `This message arrives from the Cursor Companion surface — your human attached a full-screen capture of their display (${capture.rect.w}×${capture.rect.h}). Read the screenshot at ${capture.path}, then act on it naturally — notice what's important or interesting, answer what's asked. If there's nothing to act on, say nothing.`
                : `This message arrives from the Cursor Companion surface — your human is pointing at something on their screen. The attached screenshot is a ${CURSOR_LENS_CROP_W}×${CURSOR_LENS_CROP_H} crop centred on their cursor at the moment they invoked you. Read the screenshot at ${capture.path}, then act on it naturally — notice what's important or interesting, answer what's asked. If there's nothing to act on, say nothing.`,
            `</system-reminder>`,
        ].join('\n')
        : prompt.trim();

    try {
        const result = await depsRef.submitChannelUserMessage(
            CURSOR_CHAT_ID,
            composedContent,
            CURSOR_CHAT_ID,
            {
                echoToLocalChat: true,
                displayContent: prompt.trim(),
                attachments: capture ? [capture.path] : [],
            },
        );
        if (!result || result.success === false) {
            if (pending && pending.turnId === turnId) {
                pending = null;
                broadcastState({ event: 'submit_failed', turnId });
            }
            return { success: false, error: result?.error || 'Channel submission failed' };
        }
        clearDraftPrompt();
        return { success: true, turnId };
    } catch (err) {
        if (pending && pending.turnId === turnId) {
            pending = null;
            broadcastState({ event: 'submit_failed', turnId });
        }
        depsRef.logDebug(`[CURSOR] Submit error: ${err.message}`);
        return { success: false, error: err.message };
    }
}

/**
 * Forward a channel reply to the renderer when there's a pending cursor
 * turn. Each reply pushes onto the visible stack (cap REPLY_STACK_CAP).
 *
 * Cancels any in-flight terminal grace timer — the reply we were
 * waiting for has now arrived.
 */
function handleChannelReply({ content, ts, role = 'assistant', chatId } = {}) {
    if (!pending) return false;
    if (chatId && chatId !== CURSOR_CHAT_ID) return false;
    if (!isUsable(win)) return false;

    if (terminalGraceTimer) {
        clearTimeout(terminalGraceTimer);
        terminalGraceTimer = null;
        terminalGraceTurnId = null;
    }

    pushReply({ content, ts, role });
    return true;
}

/**
 * Activity-tracker subscriber. Drives the loading layer and handles
 * terminal phases.
 */
function handleChannelActivity(activity = {}) {
    if (!pending) return;
    const phase = typeof activity.phase === 'string' ? activity.phase : '';

    if (activity.reset === true) {
        pending = null;
        if (terminalGraceTimer) {
            clearTimeout(terminalGraceTimer);
            terminalGraceTimer = null;
            terminalGraceTurnId = null;
        }
        broadcastState({ event: 'activity_reset' });
        return;
    }

    if (!isTerminalPhase(phase)) return;

    const turnIdAtEntry = pending.turnId;
    const isFailure = phase === 'failed' || phase === 'error';

    if (isFailure) {
        pending = null;
        if (isUsable(win)) {
            try {
                win.webContents.send('CURSOR_ERROR', {
                    turnId: turnIdAtEntry,
                    message: activity.label || activity.detail || 'Reply failed',
                });
            } catch (_) {}
        }
        broadcastState({ event: 'turn_failed', turnId: turnIdAtEntry });
        return;
    }

    // Terminal idle/finished. If at least one reply arrived during this
    // turn, it's already on the stack — just clear pending. If not,
    // start a grace timer: the reply socket message may be in flight
    // and arrive shortly after the activity stream goes idle.
    const hasReplyForTurn = replies.length > 0;
    if (hasReplyForTurn) {
        pending = null;
        broadcastState({ event: 'turn_completed', turnId: turnIdAtEntry });
        return;
    }

    if (terminalGraceTimer) {
        clearTimeout(terminalGraceTimer);
    }
    terminalGraceTurnId = turnIdAtEntry;
    terminalGraceTimer = setTimeout(() => {
        terminalGraceTimer = null;
        if (pending && pending.turnId === terminalGraceTurnId) {
            pending = null;
            broadcastState({ event: 'turn_completed_no_reply', turnId: terminalGraceTurnId });
        }
        terminalGraceTurnId = null;
    }, TERMINAL_GRACE_MS);
}

function isTerminalPhase(phase) {
    return phase === 'finished'
        || phase === 'idle'
        || phase === 'failed'
        || phase === 'error';
}

// ─── IPC handlers ───────────────────────────────────────────────────────

function registerIpcHandlers() {
    const { ipcMain } = depsRef;

    ipcMain.handle('CURSOR_SUBMIT', async (event, payload = {}) => {
        if (!isFromCursorWindow(event)) {
            return { success: false, error: 'unauthorized' };
        }
        return submitFromBubble({
            prompt: payload.prompt,
            screenshot: payload.screenshot === 'cursor' || payload.screenshot === 'fullscreen'
                ? payload.screenshot
                : 'none',
        });
    });

    ipcMain.handle('CURSOR_DISMISS', (event, payload = {}) => {
        if (!isFromCursorWindow(event)) {
            return { success: false, error: 'unauthorized' };
        }
        if (typeof payload.prompt === 'string' && inputOpen) {
            setDraftPrompt(payload.prompt);
        }
        // Esc/explicit dismiss: collapse input first if open, otherwise
        // clear the reply stack. Two presses → fully back to dot.
        if (inputOpen) {
            closeInput();
        } else if (replies.length > 0) {
            clearReplies();
        }
        return { success: true };
    });

    ipcMain.handle('CURSOR_DISMISS_REPLY', (event, payload = {}) => {
        if (!isFromCursorWindow(event)) {
            return { success: false, error: 'unauthorized' };
        }
        if (typeof payload.id !== 'string') {
            return { success: false, error: 'invalid' };
        }
        const ok = dismissReplyById(payload.id);
        return { success: ok };
    });

    ipcMain.handle('CURSOR_SHIFT_GESTURE', (event, payload = {}) => {
        if (!isFromCursorWindow(event)) {
            return { success: false, error: 'unauthorized' };
        }
        handleShiftGesture('renderer', { prompt: payload.prompt });
        return { success: true };
    });

    ipcMain.handle('CURSOR_DRAFT_UPDATE', (event, payload = {}) => {
        if (!isFromCursorWindow(event)) {
            return { success: false, error: 'unauthorized' };
        }
        if (typeof payload.prompt !== 'string') {
            return { success: false, error: 'invalid' };
        }
        setDraftPrompt(payload.prompt);
        return { success: true };
    });

    ipcMain.handle('CURSOR_BLUR_PARK', (event, payload = {}) => {
        if (!isFromCursorWindow(event)) {
            return { success: false, error: 'unauthorized' };
        }
        // Synchronously persist the latest draft before parking, closing
        // the gap between debounced CURSOR_DRAFT_UPDATE and a subsequent
        // tray-side dismissal.
        if (typeof payload.prompt === 'string') {
            setDraftPrompt(payload.prompt);
        }
        if (inputOpen) {
            isParked = true;
            broadcastState({ event: 'parked' });
        }
        return { success: true, parked: isParked };
    });

    ipcMain.handle('CURSOR_FOCUS_RESUME', (event) => {
        if (!isFromCursorWindow(event)) {
            return { success: false, error: 'unauthorized' };
        }
        isParked = false;
        broadcastState({ event: 'unparked' });
        return { success: true };
    });

    ipcMain.handle('CURSOR_GET_STATE', (event) => {
        if (!isFromCursorWindow(event)) {
            return { ok: false };
        }
        return {
            ok: true,
            loading: isLoading(),
            inputOpen,
            replies: replies.slice(),
            isParked,
            draftPrompt: getFreshDraft(),
        };
    });

}

function isFromCursorWindow(event) {
    if (!isUsable(win)) return false;
    return event && event.sender === win.webContents;
}

module.exports = {
    init,
    __test: {
        getPendingForTest: () => pending,
        getModeForTest: getMode,
        getInputOpenForTest: () => inputOpen,
        getRepliesForTest: () => replies.slice(),
        setShiftHeldForTest: (held) => { isShiftHeld = Boolean(held); },
        getShiftHeldForTest: () => isShiftHeld,
        setScreenForTest: (screen) => {
            depsRef = depsRef || {};
            depsRef.screen = screen;
        },
        getDraftForTest: () => ({ prompt: draftPrompt, updatedAt: draftUpdatedAt }),
        setDraftForTest: (prompt, updatedAt) => {
            draftPrompt = prompt || '';
            draftUpdatedAt = updatedAt || (prompt ? Date.now() : 0);
        },
        getFreshDraftForTest: getFreshDraft,
        getLastReplyForTest: () => lastReply,
        setLastReplyForTest: (content, ts, updatedAt) => {
            if (content == null) {
                lastReply = null;
                lastReplyUpdatedAt = 0;
                return;
            }
            lastReply = { content, ts: ts || null };
            lastReplyUpdatedAt = updatedAt || Date.now();
        },
        getFreshLastReplyForTest: getFreshLastReply,
        getGestureLockUntilForTest: () => gestureLockUntil,
        resetGestureLockForTest: () => { gestureLockUntil = 0; },
        getParkedForTest: () => isParked,
        setParkedForTest: (next) => { isParked = Boolean(next); },
        setInputOpenForTest: (next) => { inputOpen = Boolean(next); },
        setRepliesForTest: (next) => { replies = Array.isArray(next) ? next.slice() : []; },
        setPendingForTest: (next) => { pending = next; },
        setGestureLockUntilForTest: (next) => { gestureLockUntil = Number(next) || 0; },
        runStopForTest: () => stop(),
        pushReplyForTest: pushReply,
        clearRepliesForTest: clearReplies,
        DRAFT_TTL_MS,
        LAST_REPLY_TTL_MS,
        GESTURE_LOCK_MS,
        TERMINAL_GRACE_MS,
        REPLY_STACK_CAP,
        CURSOR_LENS_CROP_W,
        CURSOR_LENS_CROP_H,
        CURSOR_ATTACHMENT_TTL_MS,
        WIN_WIDTH,
        WIN_HEIGHT,
        ANCHOR_X,
        ANCHOR_Y,
    },
};
