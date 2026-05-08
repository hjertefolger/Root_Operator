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
const presenceMotionConfig = require('../shared/presence-motion-config.json');

// Padding around the element frame, in pixels. Halo sits this far
// outside every edge.
const HALO_CONFIG = presenceMotionConfig.halo || {};
const PAD = HALO_CONFIG.padPx || 18;
const WINDOW_RADIUS_PX = Number.isFinite(HALO_CONFIG.windowRadiusPx) ? HALO_CONFIG.windowRadiusPx : 12;

// Auto-hide after this much time. Long enough to read; short enough
// that a stalled agent doesn't leave a lingering ring. Renderer fade-out
// duration is added on top inside the React component.
const AUTO_HIDE_MS = HALO_CONFIG.actionAutoHideMs || 1700;

function clampRadius(value, width, height) {
    if (!Number.isFinite(value) || value <= 0) return 0;
    return Math.max(0, Math.min(value, Math.max(0, Math.min(width, height) / 2)));
}

function borderRadiusForFrame(frame, options = {}) {
    const explicit = Number(options.borderRadius ?? options.border_radius);
    if (Number.isFinite(explicit)) {
        return clampRadius(explicit, frame.w, frame.h);
    }

    const role = typeof options.role === 'string' ? options.role : '';
    if (role === 'AXWindow' || role === 'AXSheet' || role === 'AXDialog' || role === 'AXPopover') {
        return clampRadius(WINDOW_RADIUS_PX, frame.w, frame.h);
    }

    return clampRadius(Number(HALO_CONFIG.defaultRadiusPx || 0), frame.w, frame.h);
}

function init(deps) {
    if (!deps || !deps.BrowserWindow || !deps.app || !deps.loadRendererWindow) {
        throw new Error('agent-halo.init requires BrowserWindow, app, loadRendererWindow');
    }

    let win = null;
    let autoHideTimer = null;
    // The renderer may not be ready when the first show() lands. Stage
    // the most-recent payload and replay on did-finish-load.
    let pendingShow = null;
    let rendererReady = false;

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
        try {
            w.webContents.on('did-finish-load', () => {
                rendererReady = true;
                if (pendingShow && isUsable(w)) {
                    try {
                        w.webContents.send('AGENT_HALO_SHOW', pendingShow);
                    } catch (_) { /* ignore */ }
                    pendingShow = null;
                }
            });
        } catch (_) { /* ignore */ }
        win = w;
        return w;
    }

    function show(frame, options = {}) {
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
            const payload = {
                width,
                height,
                mode: options.mode || 'action',
                sustain: options.sustain === true,
                role: options.role,
                borderRadius: borderRadiusForFrame(frame, options),
                seed: Math.floor(Date.now() % 2147483647),
                accent: HALO_CONFIG.accent,
            };
            if (rendererReady) {
                try {
                    w.webContents.send('AGENT_HALO_SHOW', payload);
                } catch (_) { /* ignore */ }
            } else {
                pendingShow = payload;
            }
            if (!w.isVisible()) {
                w.showInactive();
            }
        } catch (err) {
            logDebug(`[AGENT-HALO] show failed: ${err && err.message}`);
        }

        clearAutoHide();
        const autoHideMs = options.sustain === true
            ? (HALO_CONFIG.focusAutoHideMs || 0)
            : (Number.isFinite(options.autoHideMs) ? options.autoHideMs : AUTO_HIDE_MS);
        if (autoHideMs > 0) {
            autoHideTimer = setTimeout(() => {
                autoHideTimer = null;
                hide();
            }, autoHideMs);
            if (typeof autoHideTimer.unref === 'function') autoHideTimer.unref();
        }
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
        rendererReady = false;
        pendingShow = null;
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
