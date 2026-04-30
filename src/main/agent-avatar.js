/**
 * ROOT OPERATOR — AGENT AVATAR (v0)
 *
 * The agent's body in the user's desktop, rendered at a fixed parked
 * position in the top-left of the primary display: 20px from the left
 * edge, 20px below the menu bar.
 *
 * v0 scope (this version): a single static blue dot. No motion, no
 * interaction, no AX hit-testing, no synthetic events. Renders when
 * RO is running, hides when RO quits. Repositions if the primary
 * display geometry changes (resolution, scale, arrangement).
 *
 * Future versions add travel-on-summon (v0.5), AX-mediated dwelling
 * (v1), and consent-gated HID fallback (v2). The v0 surface is the
 * lightest possible slice that proves the rendering substrate.
 *
 * Implementation pattern follows `cursor-companion.js`: a transparent
 * NSPanel `BrowserWindow` with always-on-top floating level, visible
 * across all Spaces and over fullscreen, click-through, hidden in
 * Mission Control. The avatar window is independent of the cursor
 * companion window; the two share the substrate but not state.
 */
const path = require('path');

// Window dimensions chosen to give the dot a small breathable canvas
// without taking visual space. The dot is centered in this window.
const WIN_WIDTH = 32;
const WIN_HEIGHT = 32;

// Park anchor — measured from the primary display's workArea (which
// already excludes the menu bar). 20px right of the workArea origin
// horizontally, 20px below the workArea origin vertically.
const ANCHOR_OFFSET_X = 20;
const ANCHOR_OFFSET_Y = 20;

// Cmd+H / app-hide restoration delays. macOS hides every window owned
// by the process, including transparent NSPanels, when the user issues
// the hide-application command. Cursor companion uses the same staged
// restore — a single immediate showInactive() can race the macOS hide
// cascade. Retry briefly so the avatar wins after the cascade settles.
const APP_HIDE_RESTORE_DELAYS_MS = [0, 50, 150, 350];

function init(deps) {
    if (!deps || !deps.BrowserWindow || !deps.screen || !deps.app || !deps.loadRendererWindow) {
        throw new Error('agent-avatar.init requires BrowserWindow, screen, app, loadRendererWindow');
    }

    let win = null;
    let displayHandlers = null;
    let appHideHandler = null;
    let restoreTimers = [];

    function logDebug(message) {
        if (typeof deps.logDebug === 'function') {
            deps.logDebug(message);
        }
    }

    function isUsable(w) {
        return w && !w.isDestroyed();
    }

    function computeParkedPosition() {
        const display = deps.screen.getPrimaryDisplay();
        const { workArea } = display;
        return {
            x: workArea.x + ANCHOR_OFFSET_X,
            y: workArea.y + ANCHOR_OFFSET_Y,
        };
    }

    function applyParkedPosition() {
        if (!isUsable(win)) return;
        const { x, y } = computeParkedPosition();
        win.setBounds({ x, y, width: WIN_WIDTH, height: WIN_HEIGHT });
    }

    function createWindow() {
        const { BrowserWindow, app, loadRendererWindow } = deps;
        const { x, y } = computeParkedPosition();

        const w = new BrowserWindow({
            width: WIN_WIDTH,
            height: WIN_HEIGHT,
            x,
            y,
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
            // NSPanel on macOS — overlay above all apps without stealing
            // focus or activating our process icon in the Dock.
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
        // Click-through. v0 has no interaction; future versions can flip
        // this when the avatar enters an interactive state.
        w.setIgnoreMouseEvents(true, { forward: false });

        loadRendererWindow(w, '?view=agent-avatar');

        w.once('ready-to-show', () => {
            if (isUsable(w)) {
                w.showInactive();
            }
        });

        return w;
    }

    function clearRestoreTimers() {
        for (const t of restoreTimers) {
            clearTimeout(t);
        }
        restoreTimers = [];
    }

    function restoreVisibility() {
        if (!isUsable(win)) return;
        try {
            if (typeof win.isVisible === 'function' && win.isVisible()) return;
            win.showInactive();
        } catch (err) {
            logDebug(`[AGENT-AVATAR] restore failed: ${err && err.message}`);
        }
    }

    function scheduleVisibilityRestore() {
        clearRestoreTimers();
        restoreTimers = APP_HIDE_RESTORE_DELAYS_MS.map((delay) => {
            const t = setTimeout(() => {
                restoreTimers = restoreTimers.filter((x) => x !== t);
                restoreVisibility();
            }, delay);
            if (typeof t.unref === 'function') t.unref();
            return t;
        });
    }

    function attachAppHideHandler() {
        if (appHideHandler) return;
        if (!deps.app || typeof deps.app.on !== 'function') return;
        appHideHandler = () => scheduleVisibilityRestore();
        deps.app.on('hide', appHideHandler);
    }

    function detachAppHideHandler() {
        if (!appHideHandler) return;
        try {
            if (typeof deps.app.off === 'function') {
                deps.app.off('hide', appHideHandler);
            } else if (typeof deps.app.removeListener === 'function') {
                deps.app.removeListener('hide', appHideHandler);
            }
        } catch (_) { /* best-effort */ }
        appHideHandler = null;
    }

    function attachDisplayListeners() {
        const handler = () => applyParkedPosition();
        deps.screen.on('display-metrics-changed', handler);
        deps.screen.on('display-added', handler);
        deps.screen.on('display-removed', handler);
        displayHandlers = handler;
    }

    function detachDisplayListeners() {
        if (!displayHandlers) return;
        deps.screen.off('display-metrics-changed', displayHandlers);
        deps.screen.off('display-added', displayHandlers);
        deps.screen.off('display-removed', displayHandlers);
        displayHandlers = null;
    }

    function start() {
        if (win) {
            logDebug('[AGENT-AVATAR] start() called but window already exists');
            return;
        }
        win = createWindow();
        attachDisplayListeners();
        attachAppHideHandler();
        logDebug('[AGENT-AVATAR] started');
    }

    function stop() {
        detachAppHideHandler();
        detachDisplayListeners();
        clearRestoreTimers();
        if (isUsable(win)) {
            try {
                win.close();
            } catch (_) {
                /* ignore */
            }
        }
        win = null;
        logDebug('[AGENT-AVATAR] stopped');
    }

    return {
        start,
        stop,
        getWindow: () => (isUsable(win) ? win : null),
        // Test seams.
        repositionForTest: applyParkedPosition,
        triggerAppHideForTest: () => {
            if (typeof appHideHandler === 'function') appHideHandler();
        },
    };
}

module.exports = {
    init,
    // Exposed for tests.
    __test: {
        WIN_WIDTH,
        WIN_HEIGHT,
        ANCHOR_OFFSET_X,
        ANCHOR_OFFSET_Y,
    },
};
