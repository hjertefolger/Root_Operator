/**
 * ROOT OPERATOR — AGENT AVATAR (v1.6 — cursor-as-home)
 *
 * The agent's body in the user's desktop. Lives ATTACHED to the user's
 * cursor (small dot, spring-follow with a soft lag) — the cursor is
 * home, not the Dock. On an intentional moveTo() it detaches, travels,
 * scales up, and dwells at the target. On park()/return() it travels
 * back to the cursor and resumes the spring-follow ambient.
 *
 * Motion is INTENTIONAL: the LLM calls it via the agent_* MCP tools.
 * Nothing in this module is wired to cursor-companion turns automatically.
 *
 * State machine:
 *   ambient        — spring-follow the user's cursor (small dot)
 *   traveling      — eased interpolation from current to target
 *   active         — at target, breath only, no follow (bigger dot)
 *
 * Implementation pattern follows `cursor-companion.js`: a transparent
 * NSPanel `BrowserWindow` with always-on-top floating level, visible
 * across all Spaces and over fullscreen, click-through, hidden in
 * Mission Control.
 */
const path = require('path');

// Window is bigger than the dot it contains — extra padding so the
// active-state dot + glow ring + halo arc fit without clipping.
const WIN_WIDTH = 40;
const WIN_HEIGHT = 40;

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

// Default offset from a cursor target — used both as the ambient
// resting offset (spring-follow target) and when the LLM asks
// agent_move_to_cursor without explicit offsets. 30px right of the
// cursor, vertically aligned. Close enough to read as "next to you,"
// not so close it overlaps with cursor-companion's own dot.
const DEFAULT_CURSOR_OFFSET_X = 30;
const DEFAULT_CURSOR_OFFSET_Y = 0;

// Spring constant for ambient cursor-follow. 0.18 gives a soft trailing
// lag that reads as alive without feeling heavy. Higher = snappier,
// lower = sleepier.
const AMBIENT_SPRING_K = 0.18;

// Breath oscillation while active. ±1.5px sinusoidal y-offset over a
// 2.4s period gives a subtle hover that reads as alive without ever
// becoming distracting.
const BREATH_PERIOD_MS = 2400;
const BREATH_AMPLITUDE_PX = 1.5;

const STATE = Object.freeze({
    AMBIENT: 'ambient',
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

    const springK = Number.isFinite(deps.ambientSpringK)
        ? deps.ambientSpringK
        : AMBIENT_SPRING_K;

    let win = null;
    let displayHandlers = null;
    let appHideHandler = null;
    let restoreTimers = [];

    let state = STATE.AMBIENT;
    let position = { x: 0, y: 0 };
    let travel = null; // { from, to, startedAt, settleState }
    let tickTimer = null;
    let lastBroadcastState = null;
    const tickT0 = clock.now();

    function logDebug(message) {
        if (typeof deps.logDebug === 'function') {
            deps.logDebug(message);
        }
    }

    function isUsable(w) {
        return w && !w.isDestroyed();
    }

    // The window holds a 40x40 transparent canvas with the dot drawn
    // centered. To position the dot at logical (px, py) we set the
    // window's top-left so that the center lands on (px, py).
    function applyBoundsCentered(px, py) {
        if (!isUsable(win)) return;
        win.setBounds({
            x: Math.round(px - WIN_WIDTH / 2),
            y: Math.round(py - WIN_HEIGHT / 2),
            width: WIN_WIDTH,
            height: WIN_HEIGHT,
        });
    }

    // Clamp a logical screen-space center so the WIN_WIDTH/HEIGHT canvas
    // stays inside the display the cursor is on. Without this, an offset
    // applied near a screen edge can park the dot off-screen entirely.
    function clampToDisplay(x, y) {
        let display;
        try {
            display = typeof deps.screen.getDisplayNearestPoint === 'function'
                ? deps.screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) })
                : deps.screen.getPrimaryDisplay();
        } catch (_) {
            display = deps.screen.getPrimaryDisplay();
        }
        const wa = display && display.workArea ? display.workArea : null;
        if (!wa) return { x, y };
        const minX = wa.x + WIN_WIDTH / 2;
        const maxX = wa.x + wa.width - WIN_WIDTH / 2;
        const minY = wa.y + WIN_HEIGHT / 2;
        const maxY = wa.y + wa.height - WIN_HEIGHT / 2;
        return {
            x: Math.max(minX, Math.min(maxX, x)),
            y: Math.max(minY, Math.min(maxY, y)),
        };
    }

    function computeCursorTarget(offsetX, offsetY) {
        const cursor = deps.screen.getCursorScreenPoint();
        const ox = Number.isFinite(offsetX) ? offsetX : DEFAULT_CURSOR_OFFSET_X;
        const oy = Number.isFinite(offsetY) ? offsetY : DEFAULT_CURSOR_OFFSET_Y;
        return clampToDisplay(cursor.x + ox, cursor.y + oy);
    }

    function broadcastState() {
        if (!isUsable(win)) return;
        if (state === lastBroadcastState) return;
        try {
            win.webContents.send('AGENT_AVATAR_STATE', { state });
            lastBroadcastState = state;
        } catch (_) { /* renderer not ready yet; will retry on next change */ }
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

        if (state === STATE.AMBIENT) {
            const target = computeCursorTarget();
            position.x += (target.x - position.x) * springK;
            position.y += (target.y - position.y) * springK;
            applyBoundsCentered(position.x, position.y);
            return;
        }

        if (state === STATE.TRAVELING) {
            if (!travel) {
                state = STATE.AMBIENT;
                broadcastState();
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
                state = settleState;
                broadcastState();
                if (state === STATE.AMBIENT) {
                    // Tick stays running — ambient needs the loop to
                    // spring-follow.
                    return;
                }
            }
            applyBoundsCentered(position.x, position.y);
            return;
        }

        if (state === STATE.ACTIVE) {
            const phase = ((now - tickT0) / BREATH_PERIOD_MS) * 2 * Math.PI;
            const renderY = position.y + Math.sin(phase) * BREATH_AMPLITUDE_PX;
            applyBoundsCentered(position.x, renderY);
        }
    }

    // If we're mid-travel when a new motion is requested, sample the
    // current eased position first so the new travel starts from where
    // the dot ACTUALLY is, not from the last persisted base position.
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
        broadcastState();
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

    // Travel back to the user's cursor and resume ambient follow.
    function park() {
        const target = computeCursorTarget();
        if (state === STATE.AMBIENT) {
            // Already following — refresh once for safety.
            position.x = target.x;
            position.y = target.y;
            applyBoundsCentered(target.x, target.y);
            return { to: target };
        }
        startTravelTo(target, STATE.AMBIENT);
        logDebug('[AGENT-AVATAR] park (return to cursor)');
        return { to: target };
    }

    // Tests / reset utilities.
    function getStateForTest() { return state; }
    function getPositionForTest() { return { x: position.x, y: position.y }; }
    function tickForTest() { tick(); }

    function createWindow() {
        const { BrowserWindow, app, loadRendererWindow } = deps;
        const cursor = deps.screen.getCursorScreenPoint();
        const startX = cursor.x + DEFAULT_CURSOR_OFFSET_X;
        const startY = cursor.y + DEFAULT_CURSOR_OFFSET_Y;

        position.x = startX;
        position.y = startY;

        const w = new BrowserWindow({
            width: WIN_WIDTH,
            height: WIN_HEIGHT,
            x: Math.round(startX - WIN_WIDTH / 2),
            y: Math.round(startY - WIN_HEIGHT / 2),
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
                broadcastState();
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

    // Display changes don't need any explicit handler in cursor-as-home
    // mode: the spring-follow tick already re-targets to the live cursor
    // every frame, so the dot tracks across resolution changes naturally.
    function attachDisplayListeners() {
        const handler = () => {
            // No-op for ambient. For active/traveling we leave position
            // intact — the cursor wasn't necessarily where we're acting.
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
        // Ambient needs the tick running to spring-follow the cursor.
        startTick();
        logDebug('[AGENT-AVATAR] started (ambient at cursor)');
    }

    function stop() {
        detachAppHideHandler();
        detachDisplayListeners();
        clearRestoreTimers();
        stopTick();
        state = STATE.AMBIENT;
        travel = null;
        if (isUsable(win)) {
            try {
                win.close();
            } catch (_) { /* ignore */ }
        }
        win = null;
        lastBroadcastState = null;
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
        DEFAULT_TRAVEL_DURATION_MS,
        DEFAULT_CURSOR_OFFSET_X,
        DEFAULT_CURSOR_OFFSET_Y,
        AMBIENT_SPRING_K,
        BREATH_PERIOD_MS,
        BREATH_AMPLITUDE_PX,
        STATE,
    },
};
