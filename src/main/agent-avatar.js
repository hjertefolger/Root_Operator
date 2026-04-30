/**
 * ROOT OPERATOR — AGENT AVATAR (v0.5)
 *
 * The agent's body in the user's desktop. Lives parked at the top-left
 * of the primary display (20px from edge, 20px below the menu bar).
 * On `summon()` it travels to a position 30px right of the user's
 * cursor and dwells there with smooth spring-follow + a subtle breath.
 * On `dismiss()` it travels back to the anchor and parks.
 *
 * v0   = parked dot only (shipped, ce-presence-v0).
 * v0.5 = travel-on-summon + spring-follow + breath (this version).
 * v1   = AX-mediated dwelling (future).
 * v2   = consent-gated independent action (future research).
 *
 * State machine:
 *   idle_parked          — at anchor, no motion, tick stopped
 *   traveling_to_cursor  — eased interpolation from current to cursor target
 *   active               — at cursor + offset, spring-follow + breath
 *   traveling_to_anchor  — eased interpolation back to anchor
 *
 * Implementation pattern follows `cursor-companion.js`: a transparent
 * NSPanel `BrowserWindow` with always-on-top floating level, visible
 * across all Spaces and over fullscreen, click-through, hidden in
 * Mission Control.
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

// v0.5 motion engine constants.
const TICK_HZ = 60;
const TICK_INTERVAL_MS = Math.round(1000 / TICK_HZ);

// How far to the right of the user's cursor the agent dot dwells in
// active state. 30px chosen by Tom — close enough to read as "next to
// you," not so close it overlaps with cursor-companion's own dot.
const CURSOR_OFFSET_X = 30;
const CURSOR_OFFSET_Y = 0;

// Travel animation duration (idle → cursor, or cursor → anchor).
// 500ms matches design-study target. Eased with cubic-out so it
// accelerates fast then settles in — feels intentional, not robotic.
const TRAVEL_DURATION_MS = 500;

// Spring-follow strength while active. Each tick the position moves
// SPRING_K of the way toward the target. 0.18 reads as natural lag —
// the dot is alive, not magnetically attached. Lower = more lag.
const SPRING_K = 0.18;

// Breath oscillation while active. ±1.5px sinusoidal y-offset over a
// 2.4s period gives a subtle hover that reads as alive without ever
// becoming distracting. The amplitude is small enough that someone
// not specifically watching the dot won't notice — but stillness on
// idle would feel pinned, so this matters.
const BREATH_PERIOD_MS = 2400;
const BREATH_AMPLITUDE_PX = 1.5;

const STATE = Object.freeze({
    IDLE_PARKED: 'idle_parked',
    TRAVELING_TO_CURSOR: 'traveling_to_cursor',
    ACTIVE: 'active',
    TRAVELING_TO_ANCHOR: 'traveling_to_anchor',
});

function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
}

function init(deps) {
    if (!deps || !deps.BrowserWindow || !deps.screen || !deps.app || !deps.loadRendererWindow) {
        throw new Error('agent-avatar.init requires BrowserWindow, screen, app, loadRendererWindow');
    }

    // Injected clock for deterministic tests; defaults to Date.now.
    const clock = deps.clock && typeof deps.clock.now === 'function'
        ? deps.clock
        : { now: () => Date.now() };

    let win = null;
    let displayHandlers = null;
    let appHideHandler = null;
    let restoreTimers = [];

    // v0.5 motion engine state
    let state = STATE.IDLE_PARKED;
    let position = { x: 0, y: 0 }; // sub-pixel internal
    let travel = null; // { from, to, startedAt }
    let tickTimer = null;
    const tickT0 = clock.now(); // breath reference time

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

    function computeCursorTarget() {
        const cursor = deps.screen.getCursorScreenPoint();
        return {
            x: cursor.x + CURSOR_OFFSET_X,
            y: cursor.y + CURSOR_OFFSET_Y,
        };
    }

    function applyBoundsAt(x, y) {
        if (!isUsable(win)) return;
        win.setBounds({
            x: Math.round(x),
            y: Math.round(y),
            width: WIN_WIDTH,
            height: WIN_HEIGHT,
        });
    }

    function applyParkedPosition() {
        const { x, y } = computeParkedPosition();
        position.x = x;
        position.y = y;
        applyBoundsAt(x, y);
    }

    function startTick() {
        if (tickTimer) return;
        tickTimer = setInterval(tick, TICK_INTERVAL_MS);
        if (typeof tickTimer.unref === 'function') tickTimer.unref();
    }

    function stopTick() {
        if (tickTimer) {
            clearInterval(tickTimer);
            tickTimer = null;
        }
    }

    function tick() {
        const now = clock.now();

        if (state === STATE.TRAVELING_TO_CURSOR || state === STATE.TRAVELING_TO_ANCHOR) {
            if (!travel) {
                // Defensive: traveling state without a travel descriptor
                // means we were torn down mid-flight. Snap to anchor.
                state = STATE.IDLE_PARKED;
                stopTick();
                applyParkedPosition();
                return;
            }
            const elapsed = now - travel.startedAt;
            const progress = Math.min(1, elapsed / TRAVEL_DURATION_MS);
            const eased = easeOutCubic(progress);
            position.x = travel.from.x + (travel.to.x - travel.from.x) * eased;
            position.y = travel.from.y + (travel.to.y - travel.from.y) * eased;

            if (progress >= 1) {
                if (state === STATE.TRAVELING_TO_CURSOR) {
                    state = STATE.ACTIVE;
                } else {
                    state = STATE.IDLE_PARKED;
                    travel = null;
                    applyBoundsAt(position.x, position.y);
                    stopTick();
                    return;
                }
                travel = null;
            }
        } else if (state === STATE.ACTIVE) {
            // Spring-follow the cursor.
            const target = computeCursorTarget();
            position.x += (target.x - position.x) * SPRING_K;
            position.y += (target.y - position.y) * SPRING_K;
        } else {
            // IDLE_PARKED — tick should not be running, but be defensive.
            stopTick();
            return;
        }

        // Apply breath only while active. During travel, the dot is
        // already in motion; an additional sine wave on top reads as
        // jittery rather than alive.
        let renderY = position.y;
        if (state === STATE.ACTIVE) {
            const phase = ((now - tickT0) / BREATH_PERIOD_MS) * 2 * Math.PI;
            renderY += Math.sin(phase) * BREATH_AMPLITUDE_PX;
        }

        applyBoundsAt(position.x, renderY);
    }

    function summon() {
        if (state === STATE.TRAVELING_TO_CURSOR || state === STATE.ACTIVE) {
            return; // already on the way or arrived
        }
        const target = computeCursorTarget();
        travel = {
            from: { x: position.x, y: position.y },
            to: target,
            startedAt: clock.now(),
        };
        state = STATE.TRAVELING_TO_CURSOR;
        startTick();
        logDebug('[AGENT-AVATAR] summoned');
    }

    function dismiss() {
        if (state === STATE.IDLE_PARKED || state === STATE.TRAVELING_TO_ANCHOR) {
            return; // already parked or on the way back
        }
        const target = computeParkedPosition();
        travel = {
            from: { x: position.x, y: position.y },
            to: target,
            startedAt: clock.now(),
        };
        state = STATE.TRAVELING_TO_ANCHOR;
        startTick();
        logDebug('[AGENT-AVATAR] dismissed');
    }

    function getStateForTest() {
        return state;
    }

    function getPositionForTest() {
        return { x: position.x, y: position.y };
    }

    function tickForTest() {
        tick();
    }

    function createWindow() {
        const { BrowserWindow, app, loadRendererWindow } = deps;
        const { x, y } = computeParkedPosition();

        // Initialize position for the motion engine.
        position.x = x;
        position.y = y;

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
        // Click-through. v0.5 still has no interaction; future versions
        // can flip this when the avatar enters an interactive state.
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
        const handler = () => {
            // Only re-anchor if currently parked. While active or
            // traveling, the motion engine owns position.
            if (state === STATE.IDLE_PARKED) {
                applyParkedPosition();
            }
        };
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
        stopTick();
        state = STATE.IDLE_PARKED;
        travel = null;
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
        summon,
        dismiss,
        getWindow: () => (isUsable(win) ? win : null),
        // Test seams.
        repositionForTest: applyParkedPosition,
        triggerAppHideForTest: () => {
            if (typeof appHideHandler === 'function') appHideHandler();
        },
        getStateForTest,
        getPositionForTest,
        tickForTest,
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
        TRAVEL_DURATION_MS,
        CURSOR_OFFSET_X,
        CURSOR_OFFSET_Y,
        SPRING_K,
        STATE,
    },
};
