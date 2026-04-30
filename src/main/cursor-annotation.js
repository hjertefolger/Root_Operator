/**
 * ROOT OPERATOR — CURSOR ANNOTATION
 *
 * Companion to cursor-companion.js. Owns the full-screen annotation
 * surface invoked via ⌥⇧⇧:
 *
 *   1. Capture stage — borderless panel sized to the target display,
 *      paints a frozen screen capture as the canvas, hosts the bounded
 *      rectangle + draggable toolbar + stroke surface.
 *   2. On Done — renderer composites the rectangle + strokes into PNG
 *      bytes, ships them via IPC. Main writes the file (renderer is
 *      sandboxed; we don't trust renderer-supplied paths).
 *   3. On Commit — main queues the PNG as cursor-companion's
 *      pendingAttachment and the cursor presence input pill opens.
 *
 * The freeze-image PNG is staged to the same cursor attachments dir
 * with a `freeze-` prefix; cleaned up unconditionally when the window
 * closes (commit, cancel, master-toggle-off, app quit).
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { getActiveApp } = require('./active-app');

let depsRef = null;
let win = null;
let isInitialized = false;
let currentFreezePath = null;
let currentDisplay = null;
let currentRectInit = null;
let currentCursorAnchor = null; // window-local cursor point at invocation
let currentActiveApp = null;
let pendingCommitHandler = null;

function init(deps) {
    if (isInitialized) return getApi();
    const required = [
        'BrowserWindow', 'ipcMain', 'screen', 'app', 'loadRendererWindow',
        'getCursorAttachmentsDir', 'logDebug', 'onCommit', 'onCancel',
        'getCursorCompanionWindow',
    ];
    for (const key of required) {
        if (deps[key] == null) throw new TypeError(`cursor-annotation.init missing dependency: ${key}`);
    }
    depsRef = deps;
    pendingCommitHandler = deps.onCommit;
    registerIpcHandlers();
    isInitialized = true;
    return getApi();
}

function getApi() {
    return {
        openAnnotation,
        stop,
        isOpen: () => Boolean(win),
    };
}

function isUsable(w) {
    return Boolean(w) && typeof w.isDestroyed === 'function' && !w.isDestroyed();
}

function newFreezeName() {
    return `freeze-${crypto.randomBytes(3).toString('hex')}.png`;
}

async function openAnnotation() {
    if (!isInitialized) return;
    if (isUsable(win)) return; // already open

    const point = depsRef.screen.getCursorScreenPoint();
    const display = depsRef.screen.getDisplayNearestPoint(point);
    if (!display) return;

    // Snapshot the active app NOW — the very moment the gesture fires.
    // Once we open the annotation panel and focus it, frontmost app
    // becomes Root Operator. Probe runs concurrently with the freeze
    // capture; resolved at commit time.
    const activeAppPromise = getActiveApp().catch(() => null);

    // Stage a freeze of the target display. Hide the cursor presence
    // overlay first so the freeze doesn't include our own dot / pill /
    // pending attachment / replies.
    const dir = depsRef.getCursorAttachmentsDir();
    fs.mkdirSync(dir, { recursive: true });
    const freezePath = path.join(dir, newFreezeName());
    const companionWin = (() => {
        try { return depsRef.getCursorCompanionWindow(); } catch (_) { return null; }
    })();
    const companionVisible = companionWin && typeof companionWin.isVisible === 'function' && companionWin.isVisible();
    if (companionVisible) {
        try { companionWin.hide(); } catch (_) {}
        await new Promise((r) => setTimeout(r, 32));
    }
    try {
        await runScreencapture({
            x: display.bounds.x,
            y: display.bounds.y,
            w: display.bounds.width,
            h: display.bounds.height,
            outPath: freezePath,
        });
    } catch (err) {
        depsRef.logDebug(`[CURSOR-ANN] Freeze capture failed: ${err.message}`);
        try { fs.unlinkSync(freezePath); } catch (_) {}
        if (companionVisible) {
            try { companionWin.showInactive(); } catch (_) {}
        }
        return;
    }
    if (companionVisible) {
        try { companionWin.showInactive(); } catch (_) {}
    }

    currentFreezePath = freezePath;
    currentDisplay = {
        x: display.bounds.x,
        y: display.bounds.y,
        width: display.bounds.width,
        height: display.bounds.height,
        scaleFactor: display.scaleFactor || 1,
    };
    // Default rectangle: 800×800 centered on cursor, clamped to display.
    const rectW = Math.min(800, display.bounds.width);
    const rectH = Math.min(800, display.bounds.height);
    const rectX = Math.max(
        0,
        Math.min(point.x - display.bounds.x - rectW / 2, display.bounds.width - rectW),
    );
    const rectY = Math.max(
        0,
        Math.min(point.y - display.bounds.y - rectH / 2, display.bounds.height - rectH),
    );
    currentRectInit = { x: rectX, y: rectY, w: rectW, h: rectH };
    // Cursor anchor in window-local (display-relative) coordinates.
    // Toolbar uses this so it spawns next to the cursor, mirroring how
    // the cursor presence input/replies anchor at the cursor.
    currentCursorAnchor = {
        x: Math.max(0, Math.min(point.x - display.bounds.x, display.bounds.width)),
        y: Math.max(0, Math.min(point.y - display.bounds.y, display.bounds.height)),
    };
    currentActiveApp = await activeAppPromise;

    createAnnotationWindow();
}

function createAnnotationWindow() {
    const { BrowserWindow, app, loadRendererWindow } = depsRef;
    const display = currentDisplay;
    const w = new BrowserWindow({
        x: display.x,
        y: display.y,
        width: display.width,
        height: display.height,
        frame: false,
        transparent: false,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        type: process.platform === 'darwin' ? 'panel' : undefined,
        focusable: true,
        hasShadow: false,
        show: false,
        backgroundColor: '#000000',
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            preload: path.join(app.getAppPath(), 'preload.js'),
            backgroundThrottling: false,
        },
    });

    w.setAlwaysOnTop(true, 'screen-saver');
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    if (typeof w.setHiddenInMissionControl === 'function') {
        w.setHiddenInMissionControl(true);
    }

    loadRendererWindow(w, '?view=cursor-annotation');

    w.once('ready-to-show', () => {
        if (!isUsable(w)) return;
        w.showInactive();
        // Make this window key so it can receive keystrokes (Esc, Enter).
        try { w.focus(); } catch (_) {}
    });

    w.on('closed', () => {
        if (w === win) {
            win = null;
            cleanupFreeze('window-closed');
        }
    });

    win = w;
}

function cleanupFreeze(reason) {
    const p = currentFreezePath;
    currentFreezePath = null;
    currentDisplay = null;
    currentRectInit = null;
    currentCursorAnchor = null;
    currentActiveApp = null;
    if (!p) return;
    try { fs.unlinkSync(p); } catch (_) { /* already gone */ }
    depsRef && depsRef.logDebug && depsRef.logDebug(`[CURSOR-ANN] freeze unlinked (${reason})`);
}

function closeWindow(reason) {
    if (!isUsable(win)) {
        cleanupFreeze(reason);
        return;
    }
    try { win.close(); } catch (_) {}
    win = null;
    cleanupFreeze(reason);
}

function stop() {
    closeWindow('stop');
}

// Renderer asks for the initial freeze image path + rectangle defaults
// after mount. Returns null fields if no annotation session is live.
function getInitState() {
    if (!currentFreezePath || !currentDisplay || !currentRectInit) {
        return { ok: false };
    }
    let freezeDataUrl = null;
    try {
        const bytes = fs.readFileSync(currentFreezePath);
        freezeDataUrl = `data:image/png;base64,${bytes.toString('base64')}`;
    } catch (err) {
        depsRef.logDebug(`[CURSOR-ANN] getInitState read failed: ${err.message}`);
        return { ok: false };
    }
    return {
        ok: true,
        freezeDataUrl,
        display: { ...currentDisplay },
        rect: { ...currentRectInit },
        cursorAnchor: currentCursorAnchor ? { ...currentCursorAnchor } : null,
    };
}

function registerIpcHandlers() {
    const { ipcMain } = depsRef;

    ipcMain.handle('CURSOR_ANNOTATION_GET_INIT_STATE', (event) => {
        if (!isFromAnnotationWindow(event)) return { ok: false };
        return getInitState();
    });

    ipcMain.handle('CURSOR_ANNOTATION_COMMIT', (event, payload = {}) => {
        if (!isFromAnnotationWindow(event)) return { success: false, error: 'unauthorized' };
        const { pngBase64, rect } = payload;
        if (typeof pngBase64 !== 'string' || pngBase64.length === 0) {
            return { success: false, error: 'invalid-bytes' };
        }
        if (!rect || typeof rect.w !== 'number' || typeof rect.h !== 'number') {
            return { success: false, error: 'invalid-rect' };
        }
        try {
            // Outbound staging caps images at 10MB. Check the encoded
            // length BEFORE allocating the decoded Buffer so a buggy or
            // hostile renderer can't force main to allocate an
            // arbitrarily large buffer just to reject it. Base64 encoding
            // is ~4/3 of decoded length; bound encoded length by
            // ceil(10MB * 4 / 3) = 13981013.
            const MAX_BYTES = 10 * 1024 * 1024;
            const MAX_ENCODED = Math.ceil(MAX_BYTES * 4 / 3) + 4;
            if (pngBase64.length > MAX_ENCODED) {
                return { success: false, error: 'too-large', maxBytes: MAX_BYTES, actualBytes: pngBase64.length };
            }
            const buffer = Buffer.from(pngBase64, 'base64');
            if (buffer.length > MAX_BYTES) {
                return { success: false, error: 'too-large', maxBytes: MAX_BYTES, actualBytes: buffer.length };
            }
            const dir = depsRef.getCursorAttachmentsDir();
            fs.mkdirSync(dir, { recursive: true });
            const filename = `presence-${crypto.randomBytes(3).toString('hex')}.png`;
            const filepath = path.join(dir, filename);
            fs.writeFileSync(filepath, buffer);

            const handler = pendingCommitHandler;
            const activeApp = currentActiveApp;
            const rectSnapshot = { ...rect };
            // Close the annotation window first; freeze cleanup runs in
            // the closed handler. Then notify cursor-companion.
            closeWindow('commit');
            try {
                if (typeof handler === 'function') {
                    handler({
                        path: filepath,
                        name: filename,
                        size: buffer.length,
                        rect: rectSnapshot,
                        activeApp,
                    });
                }
            } catch (err) {
                depsRef.logDebug(`[CURSOR-ANN] commit handler failed: ${err.message}`);
            }
            return { success: true };
        } catch (err) {
            depsRef.logDebug(`[CURSOR-ANN] commit write failed: ${err.message}`);
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('CURSOR_ANNOTATION_CANCEL', (event) => {
        if (!isFromAnnotationWindow(event)) return { success: false, error: 'unauthorized' };
        closeWindow('cancel');
        try {
            if (typeof depsRef.onCancel === 'function') depsRef.onCancel();
        } catch (_) {}
        return { success: true };
    });
}

function isFromAnnotationWindow(event) {
    if (!isUsable(win)) return false;
    return event && event.sender === win.webContents;
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

module.exports = {
    init,
};
