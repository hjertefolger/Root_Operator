/**
 * ROOT OPERATOR — CURSOR COMPANION
 *
 * Single morphing element anchored to the system cursor. States:
 *   dot → input pill → loading dots → response → dot
 *
 * One transparent always-on-top window holds the renderer. The window
 * tracks the mouse pointer at 60Hz; the inner element morphs its shape
 * via CSS as state transitions occur. The pointer-arrow sits at the
 * left edge of the pill when typing — text grows to the right, and
 * the whole pill (with text intact) follows the mouse if it moves
 * mid-typing.
 *
 * Mouse events are click-through except while input is active; keyboard
 * input still flows to the renderer because the window is focusable.
 *
 * The capture + submission flow is unchanged in shape: on Enter we hide
 * the overlay, run `screencapture -x -R`, restore, and submit through
 * the existing channel-bridge with a text message that references the
 * staged screenshot. The reply is forwarded back to the same renderer.
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Window is sized large enough to host every state without resizing the
// native window mid-animation (which fights CSS transitions). Inner
// element morphs via CSS within this fixed canvas.
const WIN_WIDTH = 720;
const WIN_HEIGHT = 320;

// Cursor anchor inside the window: the mouse pointer-arrow corresponds
// to (ANCHOR_X, ANCHOR_Y) in window-local coordinates. In dot mode, the
// dot renders just south-east of this point. In input mode, this point
// sits at the left edge of the pill, vertically centered.
const ANCHOR_X = 16;
const ANCHOR_Y = 16;

// Cursor polling cadence — match standard 60Hz so the dot doesn't chop
// next to the native cursor. setPosition is gated on movement.
const CURSOR_POLL_HZ = 60;
const CURSOR_POLL_INTERVAL_MS = Math.round(1000 / CURSOR_POLL_HZ);

// Cursor-area screenshot crop in DIP space.
const CURSOR_LENS_CROP_W = 600;
const CURSOR_LENS_CROP_H = 400;

// Stage-attachment TTL.
const CURSOR_ATTACHMENT_TTL_MS = 10 * 60 * 1000;

// Double-tap-Option detection window.
const DOUBLE_OPTION_WINDOW_MS = 320;

// Single-flight pending lock. No auto-timeout — Claude turns can take
// long, and a stale "no response" pill is worse than waiting. The lock
// releases on actual reply or on user dismiss (Esc / Option+Option).

const CURSOR_CHAT_ID = 'cursor-companion';

let depsRef = null;
let win = null;
let cursorPollTimer = null;
let lastWinPos = { x: -1, y: -1 };
let pending = null;
let optionTapState = { lastTapAt: 0 };
let isInitialized = false;
let uiohookRef = null;
let optionKeyCodes = [];
let optionListenerAttached = false;
let mode = 'dot'; // dot | input | loading | response

function isUsable(w) {
    return Boolean(w && !w.isDestroyed());
}

function newTurnId() {
    return `cursor-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
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
        attachOptionListener,
        detachOptionListener,
        isPending: () => pending !== null,
        getMode: () => mode,
    };
}

function attachOptionListener() {
    if (optionListenerAttached) return;
    try {
        const { uIOhook, UiohookKey } = require('uiohook-napi');
        uiohookRef = uIOhook;
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
        if (event && optionTapState.lastTapAt !== 0 && !optionKeyCodes.includes(event.keycode)) {
            optionTapState.lastTapAt = 0;
        }
        return;
    }
    noteOptionTap();
}

function start() {
    if (!isInitialized) {
        throw new Error('cursor-companion.start called before init');
    }
    if (win) return;
    createWindow();
    startCursorPoll();
    depsRef.logDebug('[CURSOR] Companion started');
}

function stop() {
    stopCursorPoll();
    detachOptionListener();
    if (isUsable(win)) {
        try { win.close(); } catch (_) {}
    }
    win = null;
    pending = null;
    mode = 'dot';
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
        // NSPanel on macOS — can become key window (accept keystrokes)
        // while another app is foreground, without activating our entire
        // app or stealing the dock focus. Without this, Option+Option
        // opens the pill but the underlying app keeps keyboard focus.
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
    // Default mode is dot — fully click-through. Toggled to interactive
    // when input mode opens so the renderer can receive keystrokes.
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
    // Run once immediately so the window doesn't briefly show at (0,0)
    // before the first interval tick.
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

// ─── Mode transitions ───────────────────────────────────────────────────

function setMode(next, payload) {
    mode = next;
    if (!isUsable(win)) return;
    // Toggle interactivity: input mode is the only state that captures
    // mouse clicks (so the user can click in/select the field). All other
    // states are click-through so the underlying app stays usable.
    if (next === 'input') {
        win.setIgnoreMouseEvents(false);
        try { win.focus(); } catch (_) {}
    } else {
        win.setIgnoreMouseEvents(true, { forward: true });
    }
    win.webContents.send('CURSOR_MODE', { mode: next, ...(payload || {}) });
}

function showInput() {
    if (!isInitialized || !isUsable(win)) return;
    // Allow opening the input pill regardless of pending state — the
    // user can fire follow-up turns while a previous one is still in
    // flight (parity with desktop/web chat).
    setMode('input');
}

function dismiss() {
    if (!isInitialized) return;
    setMode('dot');
}

function noteOptionTap() {
    const now = Date.now();
    if (now - optionTapState.lastTapAt <= DOUBLE_OPTION_WINDOW_MS) {
        optionTapState.lastTapAt = 0;
        // Option+Option semantics:
        //   dot       → input  (start a turn)
        //   input     → dot    (cancel the input)
        //   loading   → input  (queue a follow-up turn)
        //   response  → input  (continue the conversation)
        if (mode === 'input') {
            dismiss();
        } else {
            showInput();
        }
        return true;
    }
    optionTapState.lastTapAt = now;
    return false;
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

async function submitFromBubble({ prompt }) {
    if (typeof prompt !== 'string' || prompt.trim().length === 0) {
        return { success: false, error: 'Empty prompt' };
    }
    if (depsRef.getOperatingMode() !== 'channel') {
        return { success: false, error: 'Channel mode is not active.' };
    }

    // Establish the pending marker BEFORE capture so the channel reply
    // forwarder routes the next response to us, not local chat. A
    // follow-up sent while a previous turn is still pending replaces
    // the marker — channel-history persists every turn so nothing is
    // lost on the conversation side; the renderer just renders the
    // most recent reply in its bubble.
    const turnId = newTurnId();
    pending = {
        turnId,
        startedAt: Date.now(),
    };
    setMode('loading');

    let capture;
    try {
        capture = await captureCursorArea();
    } catch (err) {
        depsRef.logDebug(`[CURSOR] Capture failed: ${err.message}`);
        clearPending();
        setMode('dot');
        return { success: false, error: `Could not capture screen: ${err.message}` };
    }
    pending.attachmentPath = capture.path;

    const composedContent = [
        prompt.trim(),
        ``,
        `<system-reminder>`,
        `This message arrives from the Cursor Companion surface — your human is pointing at something on their screen. The attached screenshot is a ${CURSOR_LENS_CROP_W}×${CURSOR_LENS_CROP_H} crop centred on their cursor at the moment they invoked you. Read the screenshot at ${capture.path}, then act on it naturally — notice what's important or interesting, answer what's asked. If there's nothing to act on, say nothing.`,
        `</system-reminder>`,
    ].join('\n');

    try {
        const result = await depsRef.submitChannelUserMessage(
            CURSOR_CHAT_ID,
            composedContent,
            CURSOR_CHAT_ID,
            {
                // Single source of truth: the cursor turn lands in the same
                // channel-history as every other surface, and every surface
                // (desktop chat, web/paired devices) sees it. The clean
                // displayContent strips the technical screenshot prefix —
                // human-facing surfaces and conversation memory show the
                // user's actual prompt, while Claude still receives the
                // full composed content needed to read the screenshot.
                //
                // The screenshot is also surfaced as a real attachment on
                // the user message, so it renders as a file pill below
                // the bubble in desktop/PWA chat — same envelope shape as
                // a user-uploaded file in the regular chat composer.
                echoToLocalChat: true,
                displayContent: prompt.trim(),
                attachments: [capture.path],
            },
        );
        if (!result || result.success === false) {
            clearPending();
            setMode('dot');
            return { success: false, error: result?.error || 'Channel submission failed' };
        }
        return { success: true, turnId };
    } catch (err) {
        clearPending();
        setMode('dot');
        depsRef.logDebug(`[CURSOR] Submit error: ${err.message}`);
        return { success: false, error: err.message };
    }
}

function clearPending() {
    pending = null;
}

/**
 * Forward a channel reply to the renderer when there's a pending cursor
 * turn. Caller is channel-mode's reply handler.
 */
function handleChannelReply({ content, ts, role = 'assistant', chatId } = {}) {
    if (!pending) return false;
    if (chatId && chatId !== CURSOR_CHAT_ID) return false;
    if (!isUsable(win)) {
        clearPending();
        return false;
    }
    win.webContents.send('CURSOR_REPLY', {
        turnId: pending.turnId,
        content,
        ts,
        role,
    });
    clearPending();
    setMode('response');
    return true;
}

// ─── IPC handlers ───────────────────────────────────────────────────────

function registerIpcHandlers() {
    const { ipcMain } = depsRef;

    ipcMain.handle('CURSOR_SUBMIT', async (event, payload = {}) => {
        if (!isFromCursorWindow(event)) {
            return { success: false, error: 'unauthorized' };
        }
        return submitFromBubble({ prompt: payload.prompt });
    });

    ipcMain.handle('CURSOR_DISMISS', (event) => {
        if (!isFromCursorWindow(event)) {
            return { success: false, error: 'unauthorized' };
        }
        dismiss();
        return { success: true };
    });

    ipcMain.handle('CURSOR_GET_PENDING', (event) => {
        if (!isFromCursorWindow(event)) {
            return { pending: false };
        }
        return { pending: pending !== null, turnId: pending?.turnId || null, mode };
    });
}

function isFromCursorWindow(event) {
    if (!isUsable(win)) return false;
    return event && event.sender === win.webContents;
}

module.exports = {
    init,
    __test: {
        noteOptionTap,
        getPendingForTest: () => pending,
        getModeForTest: () => mode,
        resetTapStateForTest: () => { optionTapState.lastTapAt = 0; },
        setScreenForTest: (screen) => {
            depsRef = depsRef || {};
            depsRef.screen = screen;
        },
        DOUBLE_OPTION_WINDOW_MS,
        CURSOR_LENS_CROP_W,
        CURSOR_LENS_CROP_H,
        WIN_WIDTH,
        WIN_HEIGHT,
        ANCHOR_X,
        ANCHOR_Y,
    },
};
