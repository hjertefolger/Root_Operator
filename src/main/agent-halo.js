/**
 * ROOT OPERATOR — AGENT HALO
 *
 * Soft accent glow ring drawn around the AX element the agent is acting
 * on. Visible cue for "I'm reading / writing / pressing this." Lives in
 * its own transparent NSPanel so it can be sized to arbitrary element
 * frames without disturbing the avatar window.
 *
 * Lifecycle:
 *   show(frame)  — resize/move panel to fit (frame +/- PAD), tell
 *                  renderer to fade in. Auto-hides after AUTO_HIDE_MS
 *                  unless show() is called again to extend.
 *   hide()       — tell renderer to fade out, then close-defer.
 *
 * The panel itself never animates size/position during a single show —
 * the renderer fades opacity. Sizing only changes between shows.
 */
const path = require('path');

// Padding around the element frame, in pixels. Halo sits this far
// outside every edge.
const PAD = 14;

// Auto-hide after this much time. Long enough to read; short enough
// that a stalled agent doesn't leave a lingering ring. Renderer fade-out
// duration is added on top inside the React component.
const AUTO_HIDE_MS = 1400;

function init(deps) {
    if (!deps || !deps.BrowserWindow || !deps.app || !deps.loadRendererWindow) {
        throw new Error('agent-halo.init requires BrowserWindow, app, loadRendererWindow');
    }

    let win = null;
    let autoHideTimer = null;

    function logDebug(message) {
        if (typeof deps.logDebug === 'function') {
            deps.logDebug(message);
        }
    }

    function isUsable(w) {
        return w && !w.isDestroyed();
    }

    function clearAutoHide() {
        if (autoHideTimer) {
            clearTimeout(autoHideTimer);
            autoHideTimer = null;
        }
    }

    function ensureWindow() {
        if (isUsable(win)) return win;
        const { BrowserWindow, app, loadRendererWindow } = deps;
        const w = new BrowserWindow({
            width: 1, height: 1,
            x: -10000, y: -10000,
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
            type: process.platform === 'darwin' ? 'panel' : undefined,
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
        w.setAlwaysOnTop(true, 'floating');
        w.setVisibleOnAllWorkspaces(true, {
            visibleOnFullScreen: true,
            skipTransformProcessType: true,
        });
        if (typeof w.setHiddenInMissionControl === 'function') {
            w.setHiddenInMissionControl(true);
        }
        w.setIgnoreMouseEvents(true, { forward: false });
        loadRendererWindow(w, '?view=agent-halo');
        w.once('ready-to-show', () => {
            if (isUsable(w)) w.showInactive();
        });
        win = w;
        return w;
    }

    function show(frame) {
        if (!frame
            || !Number.isFinite(frame.x)
            || !Number.isFinite(frame.y)
            || !Number.isFinite(frame.w)
            || !Number.isFinite(frame.h)) {
            return;
        }
        const w = ensureWindow();
        if (!isUsable(w)) return;

        const x = Math.round(frame.x - PAD);
        const y = Math.round(frame.y - PAD);
        const width = Math.max(8, Math.round(frame.w + PAD * 2));
        const height = Math.max(8, Math.round(frame.h + PAD * 2));

        try {
            w.setBounds({ x, y, width, height });
            try {
                w.webContents.send('AGENT_HALO_SHOW', { width, height });
            } catch (_) { /* renderer not ready; show on next ready-to-show */ }
            if (!w.isVisible()) {
                w.showInactive();
            }
        } catch (err) {
            logDebug(`[AGENT-HALO] show failed: ${err && err.message}`);
        }

        clearAutoHide();
        autoHideTimer = setTimeout(() => {
            autoHideTimer = null;
            hide();
        }, AUTO_HIDE_MS);
        if (typeof autoHideTimer.unref === 'function') autoHideTimer.unref();
    }

    function hide() {
        clearAutoHide();
        if (!isUsable(win)) return;
        try {
            win.webContents.send('AGENT_HALO_HIDE', {});
        } catch (_) { /* ignore */ }
    }

    function stop() {
        clearAutoHide();
        if (isUsable(win)) {
            try { win.close(); } catch (_) { /* ignore */ }
        }
        win = null;
    }

    return {
        show,
        hide,
        stop,
        getWindow: () => (isUsable(win) ? win : null),
    };
}

module.exports = {
    init,
    __test: { PAD, AUTO_HIDE_MS },
};
