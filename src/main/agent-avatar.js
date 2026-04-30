/**
 * ROOT OPERATOR — AGENT AVATAR (v1.5)
 *
 * The agent's body in the user's desktop. Lives parked near the Dock
 * (anchor side detected from the workArea / bounds delta). On an
 * intentional moveTo() the body travels to a target point and stays
 * there — no spring-follow, no auto-tracking. On park() it travels
 * back to the anchor.
 *
 * Motion is INTENTIONAL: the LLM calls it via the agent_* MCP tools.
 * Nothing in this module is wired to cursor-companion turns anymore.
 *
 * State machine:
 *   idle_parked          — at anchor, no motion, tick stopped
 *   traveling            — eased interpolation from current to target
 *   active               — at target, breath only, no follow
 *
 * Implementation pattern follows `cursor-companion.js`: a transparent
 * NSPanel `BrowserWindow` with always-on-top floating level, visible
 * across all Spaces and over fullscreen, click-through, hidden in
 * Mission Control.
 */
const path = require('path');

const WIN_WIDTH = 32;
const WIN_HEIGHT = 32;

// Margin from the screen edge when parking. Keeps the dot off the
// bezel without crowding the Dock corner.
const ANCHOR_EDGE_MARGIN = 16;

// Cmd+H / app-hide restoration delays. macOS hides every window owned
// by the process, including transparent NSPanels, when the user issues
// the hide-application command. Cursor companion uses the same staged
// restore — a single immediate showInactive() can race the macOS hide
// cascade. Retry briefly so the avatar wins after the cascade settles.
const APP_HIDE_RESTORE_DELAYS_MS = [0, 50, 150, 350];

// Motion engine constants.
const TICK_HZ = 60;
const TICK_INTERVAL_MS = Math.round(1000 / TICK_HZ);

// Travel duration. 800ms with cubic-out reads as walking-over rather
// than teleporting. Tunable via deps.travelDurationMs for tests.
const DEFAULT_TRAVEL_DURATION_MS = 800;

// Default offset from a cursor target — used when the LLM asks
// agent_move_to_cursor without explicit offsets. 30px right of the
// cursor, vertically aligned. Close enough to read as "next to you,"
// not so close it overlaps with cursor-companion's own dot.
const DEFAULT_CURSOR_OFFSET_X = 30;
const DEFAULT_CURSOR_OFFSET_Y = 0;

// Breath oscillation while active. ±1.5px sinusoidal y-offset over a
// 2.4s period gives a subtle hover that reads as alive without ever
// becoming distracting.
const BREATH_PERIOD_MS = 2400;
const BREATH_AMPLITUDE_PX = 1.5;

const STATE = Object.freeze({
    IDLE_PARKED: 'idle_parked',
    TRAVELING: 'traveling',
    ACTIVE: 'active',
});

function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
}

function init(deps) {
    if (!deps || !deps.BrowserWindow || !deps.screen || !deps.app || !deps.loadRendererWindow) {
        throw new Error('agent-avatar.init requires BrowserWindow, screen, app, loadRendererWindow');
    }

    const clock = deps.clock && typeof deps.clock.now === 'function'
        ? deps.clock
        : { now: () => Date.now() };

    const travelDurationMs = Number.isFinite(deps.travelDurationMs)
        ? deps.travelDurationMs
        : DEFAULT_TRAVEL_DURATION_MS;

    let win = null;
    let displayHandlers = null;
    let appHideHandler = null;
    let restoreTimers = [];

    let state = STATE.IDLE_PARKED;
    let position = { x: 0, y: 0 };
    let travel = null; // { from, to, startedAt, settleState }
    let tickTimer = null;
    const tickT0 = clock.now();

    function logDebug(message) {
        if (typeof deps.logDebug === 'function') {
            deps.logDebug(message);
        }
    }

    function isUsable(w) {
        return w && !w.isDestroyed();
    }

    // Detect which edge the Dock occupies. macOS exposes this via the
    // delta between display.bounds (the full pixel area) and
    // display.workArea (excludes menu bar + Dock). When the Dock is
    // hidden or absent we fall back to bottom — the most common config.
    function detectDockSide(display) {
        const { bounds, workArea } = display;
        if (workArea.x > bounds.x) return 'left';
        if ((workArea.x + workArea.width) < (bounds.x + bounds.width)) return 'right';
        if ((workArea.y + workArea.height) < (bounds.y + bounds.height)) return 'bottom';
        return 'bottom';
    }

    // Compute the parked position. Sits just outside the Dock corner
    // closest to the start of the icon strip, with a margin off the
    // screen edge so the dot doesn't visually fuse into the Dock.
    function computeParkedPosition() {
        const display = deps.screen.getPrimaryDisplay();
        const { workArea } = display;
        const side = detectDockSide(display);

        if (side === 'bottom') {
            // Park at the workArea bottom-left, which sits just above
            // the Dock corner where the first icon (Finder) begins.
            return {
                x: workArea.x + ANCHOR_EDGE_MARGIN,
                y: workArea.y + workArea.height - WIN_HEIGHT - ANCHOR_EDGE_MARGIN,
            };
        }
        if (side === 'left') {
            // Dock on the left — park at the top-left of the workArea
            // (above where the first Dock icon would sit).
            return {
                x: workArea.x + ANCHOR_EDGE_MARGIN,
                y: workArea.y + ANCHOR_EDGE_MARGIN,
            };
        }
        if (side === 'right') {
            // Mirror of the left case.
            return {
                x: workArea.x + workArea.width - WIN_WIDTH - ANCHOR_EDGE_MARGIN,
                y: workArea.y + ANCHOR_EDGE_MARGIN,
            };
        }
        // Fallback: top-left of workArea.
        return {
            x: workArea.x + ANCHOR_EDGE_MARGIN,
            y: workArea.y + ANCHOR_EDGE_MARGIN,
        };
    }

    function computeCursorTarget(offsetX, offsetY) {
        const cursor = deps.screen.getCursorScreenPoint();
        const ox = Number.isFinite(offsetX) ? offsetX : DEFAULT_CURSOR_OFFSET_X;
        const oy = Number.isFinite(offsetY) ? offsetY : DEFAULT_CURSOR_OFFSET_Y;
        return { x: cursor.x + ox, y: cursor.y + oy };
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

        if (state === STATE.TRAVELING) {
            if (!travel) {
                state = STATE.IDLE_PARKED;
                stopTick();
                applyParkedPosition();
                return;
            }
            const elapsed = now - travel.startedAt;
            const progress = Math.min(1, elapsed / travelDurationMs);
            const eased = easeOutCubic(progress);
            position.x = travel.from.x + (travel.to.x - travel.from.x) * eased;
            position.y = travel.from.y + (travel.to.y - travel.from.y) * eased;

            if (progress >= 1) {
                const settleState = travel.settleState;
                travel = null;
                if (settleState === STATE.IDLE_PARKED) {
                    state = STATE.IDLE_PARKED;
                    applyBoundsAt(position.x, position.y);
                    stopTick();
                    return;
                }
                state = STATE.ACTIVE;
            }
        } else if (state === STATE.ACTIVE) {
            // Stay put. Only breath modulates the rendered y. The base
            // position never moves until another moveTo / park call.
        } else {
            // IDLE_PARKED — tick should not be running, but be defensive.
            stopTick();
            return;
        }

        let renderY = position.y;
        if (state === STATE.ACTIVE) {
            const phase = ((now - tickT0) / BREATH_PERIOD_MS) * 2 * Math.PI;
            renderY += Math.sin(phase) * BREATH_AMPLITUDE_PX;
        }

        applyBoundsAt(position.x, renderY);
    }

    // If we're mid-travel when a new motion is requested, sample the
    // current eased position first so the new travel starts from where
    // the dot ACTUALLY is, not from the last persisted base position.
    // Without this, a re-target before the next 60Hz tick would jump
    // backward and re-traverse the missed delta.
    function sampleCurrentPosition() {
        if (state === STATE.TRAVELING && travel) {
            const elapsed = clock.now() - travel.startedAt;
            const progress = Math.min(1, elapsed / travelDurationMs);
            const eased = easeOutCubic(progress);
            position.x = travel.from.x + (travel.to.x - travel.from.x) * eased;
            position.y = travel.from.y + (travel.to.y - travel.from.y) * eased;
        }
    }

    function startTravelTo(target, settleState) {
        sampleCurrentPosition();
        travel = {
            from: { x: position.x, y: position.y },
            to: { x: target.x, y: target.y },
            startedAt: clock.now(),
            settleState,
        };
        state = STATE.TRAVELING;
        startTick();
    }

    // Move the agent to an explicit screen-space point and dwell there.
    function moveTo(x, y) {
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
            throw new Error('moveTo requires numeric x, y');
        }
        startTravelTo({ x, y }, STATE.ACTIVE);
        logDebug(`[AGENT-AVATAR] moveTo (${Math.round(x)}, ${Math.round(y)})`);
        return { from: { x: position.x, y: position.y }, to: { x, y } };
    }

    // Move the agent to the user's cursor (with optional offset) and dwell.
    function moveToCursor(offsetX, offsetY) {
        const target = computeCursorTarget(offsetX, offsetY);
        startTravelTo(target, STATE.ACTIVE);
        logDebug(`[AGENT-AVATAR] moveToCursor → (${Math.round(target.x)}, ${Math.round(target.y)})`);
        return { to: target };
    }

    // Travel back to the parked anchor.
    function park() {
        const target = computeParkedPosition();
        if (state === STATE.IDLE_PARKED) {
            // Already parked — snap to the current anchor in case the
            // display geometry changed and refresh.
            position.x = target.x;
            position.y = target.y;
            applyBoundsAt(target.x, target.y);
            return { to: target };
        }
        startTravelTo(target, STATE.IDLE_PARKED);
        logDebug('[AGENT-AVATAR] park');
        return { to: target };
    }

    // Tests / reset utilities.
    function getStateForTest() { return state; }
    function getPositionForTest() { return { x: position.x, y: position.y }; }
    function tickForTest() { tick(); }

    function createWindow() {
        const { BrowserWindow, app, loadRendererWindow } = deps;
        const { x, y } = computeParkedPosition();

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
            } catch (_) { /* ignore */ }
        }
        win = null;
        logDebug('[AGENT-AVATAR] stopped');
    }

    return {
        start,
        stop,
        moveTo,
        moveToCursor,
        park,
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
    __test: {
        WIN_WIDTH,
        WIN_HEIGHT,
        ANCHOR_EDGE_MARGIN,
        DEFAULT_TRAVEL_DURATION_MS,
        DEFAULT_CURSOR_OFFSET_X,
        DEFAULT_CURSOR_OFFSET_Y,
        BREATH_PERIOD_MS,
        BREATH_AMPLITUDE_PX,
        STATE,
    },
};
