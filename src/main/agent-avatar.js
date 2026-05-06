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
 *   driving        — agent is borrowing the HID cursor lane; dot locks
 *                   to the live cursor and renderer shifts color/scale
 *
 * Implementation pattern follows `cursor-companion.js`: a transparent
 * NSPanel `BrowserWindow` with always-on-top floating level, visible
 * across all Spaces and over fullscreen, click-through, hidden in
 * Mission Control.
 */
const path = require('path');
const presenceMotionConfig = require('../shared/presence-motion-config.json');

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

// Test/default travel duration. Runtime travel is distance-scaled from
// the shared presence config; deps.travelDurationMs fixes the duration
// for deterministic tests.
const DEFAULT_TRAVEL_DURATION_MS = 800;

// Default offset from a cursor target — used both as the ambient
// resting offset (spring-follow target) and when the LLM asks
// agent_move_to_cursor without explicit offsets. Mirrors the legacy
// cursor-companion ambient dot: top-left at cursor + (14, 18) with a
// 5px dot (centre cursor + (16.5, 20.5)). Rounded for parity.
const DEFAULT_CURSOR_OFFSET_X = 16;
const DEFAULT_CURSOR_OFFSET_Y = 20;

// Spring constant for ambient cursor-follow. 0.18 gives a soft trailing
// lag that reads as alive without feeling heavy. Higher = snappier,
// lower = sleepier.
const AMBIENT_SPRING_K = 0.18;

// Breath oscillation while active. ±1.5px sinusoidal y-offset over a
// 2.4s period gives a subtle hover that reads as alive without ever
// becoming distracting.
const BREATH_PERIOD_MS = 2400;
const BREATH_AMPLITUDE_PX = 1.5;
const AVATAR_MOTION = presenceMotionConfig.avatar || {};
const TRAVEL_MIN_MS = AVATAR_MOTION.travelMinMs || 620;
const TRAVEL_MAX_MS = AVATAR_MOTION.travelMaxMs || 1100;
const TRAVEL_BASE_MS = AVATAR_MOTION.travelBaseMs || 520;
const TRAVEL_DISTANCE_SLOPE_MS_PER_PX = AVATAR_MOTION.travelDistanceSlopeMsPerPx || 0.34;
const TRAVEL_SETTLE_MS = AVATAR_MOTION.settleMs || 150;
const TRAVEL_OVERSHOOT_PX = AVATAR_MOTION.overshootPx || 1.7;
const ACTIVE_DRIFT_RADIUS_PX = AVATAR_MOTION.driftRadiusPx || 9;
const ACTIVE_DRIFT_PERIOD_MS = AVATAR_MOTION.driftPeriodMs || 5400;
const ACTIVE_DRIFT_SECONDARY_PERIOD_MS = AVATAR_MOTION.driftSecondaryPeriodMs || 7600;
const ACTIVE_DRIFT_VERTICAL_SCALE = AVATAR_MOTION.driftVerticalScale || 0.72;
const MICRO_TOUR_MIN_DELAY_MS = AVATAR_MOTION.microTourMinDelayMs || 8000;
const MICRO_TOUR_MAX_DELAY_MS = AVATAR_MOTION.microTourMaxDelayMs || 15000;
const MICRO_TOUR_MIN_DURATION_MS = AVATAR_MOTION.microTourMinDurationMs || 1200;
const MICRO_TOUR_MAX_DURATION_MS = AVATAR_MOTION.microTourMaxDurationMs || 2000;
const MICRO_TOUR_MIN_RADIUS_PX = AVATAR_MOTION.microTourMinRadiusPx || 20;
const MICRO_TOUR_MAX_RADIUS_PX = AVATAR_MOTION.microTourMaxRadiusPx || 40;

// Curved-path control-point parameters. Travel uses a cubic Bezier
// instead of a straight line: P0 = from, P3 = to, P1 sits ahead of
// from in the travel direction (detach kick — first impression that
// the agent leaves where it was), P2 sits past the midpoint with a
// perpendicular offset (arc — reads as a natural human-like curve
// rather than a straight rail). Magnitudes are fractions of the
// from→to distance with hard caps to prevent extreme curves on long
// cross-screen travels.
const DETACH_KICK_FRACTION = 0.18;     // P1 = from + dir × dist × 0.18
const DETACH_KICK_MAX_PX = 36;
const ARC_PERPENDICULAR_FRACTION = 0.12; // P2 = mid + perp × dist × 0.12
const ARC_PERPENDICULAR_MAX_PX = 90;
// Avoid degenerate curves on tiny travels (< MIN_CURVE_DIST_PX): fall
// back to a linear interpolation. Below this, arcs look jittery.
const MIN_CURVE_DIST_PX = 20;

const STATE = Object.freeze({
    AMBIENT: 'ambient',
    TRAVELING: 'traveling',
    ACTIVE: 'active',
    DRIVING: 'driving',
});

function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
}

function clamp01(t) {
    return Math.max(0, Math.min(1, t));
}

function easeInOutSine(t) {
    return -(Math.cos(Math.PI * t) - 1) / 2;
}

function clampMs(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function seededRandomFactory(seed) {
    let state = (Number.isFinite(seed) ? seed : Date.now()) >>> 0;
    if (state === 0) state = 0x9e3779b9;
    return function seededRandom() {
        state += 0x6D2B79F5;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function lerp(a, b, t) {
    return a + (b - a) * t;
}

// Compute the four control points of the travel Bezier. Pure function
// so tests can assert curve geometry independently. Returns
// { P0, P1, P2, P3, linear } where `linear: true` means the travel is
// short enough (< MIN_CURVE_DIST_PX) that we should fall back to a
// straight interpolation between P0 and P3 to avoid wobble.
function computeBezierControls(from, to) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dist = Math.hypot(dx, dy);
    if (!Number.isFinite(dist) || dist < MIN_CURVE_DIST_PX) {
        return {
            P0: { x: from.x, y: from.y },
            P1: { x: from.x, y: from.y },
            P2: { x: to.x, y: to.y },
            P3: { x: to.x, y: to.y },
            linear: true,
        };
    }
    const dirX = dx / dist;
    const dirY = dy / dist;
    // Perpendicular vector (90° counterclockwise of travel dir).
    // Always picks the same handedness — gives consistent curve shape
    // rather than randomized direction-flicker.
    const perpX = -dirY;
    const perpY = dirX;
    const kick = Math.min(DETACH_KICK_MAX_PX, dist * DETACH_KICK_FRACTION);
    const arc = Math.min(ARC_PERPENDICULAR_MAX_PX, dist * ARC_PERPENDICULAR_FRACTION);
    const midX = (from.x + to.x) / 2;
    const midY = (from.y + to.y) / 2;
    return {
        P0: { x: from.x, y: from.y },
        P1: { x: from.x + dirX * kick, y: from.y + dirY * kick },
        P2: { x: midX + perpX * arc, y: midY + perpY * arc },
        P3: { x: to.x, y: to.y },
        linear: false,
    };
}

// Cubic Bezier B(t) = (1-t)³P0 + 3(1-t)²t P1 + 3(1-t)t² P2 + t³ P3
function bezierAt(controls, t) {
    if (controls.linear) {
        return {
            x: controls.P0.x + (controls.P3.x - controls.P0.x) * t,
            y: controls.P0.y + (controls.P3.y - controls.P0.y) * t,
        };
    }
    const u = 1 - t;
    const u2 = u * u;
    const u3 = u2 * u;
    const t2 = t * t;
    const t3 = t2 * t;
    return {
        x: u3 * controls.P0.x + 3 * u2 * t * controls.P1.x + 3 * u * t2 * controls.P2.x + t3 * controls.P3.x,
        y: u3 * controls.P0.y + 3 * u2 * t * controls.P1.y + 3 * u * t2 * controls.P2.y + t3 * controls.P3.y,
    };
}

function init(deps) {
    if (!deps || !deps.BrowserWindow || !deps.screen || !deps.app || !deps.loadRendererWindow) {
        throw new Error('agent-avatar.init requires BrowserWindow, screen, app, loadRendererWindow');
    }

    const clock = deps.clock && typeof deps.clock.now === 'function'
        ? deps.clock
        : { now: () => Date.now() };

    const fixedTravelDurationMs = Number.isFinite(deps.travelDurationMs)
        ? deps.travelDurationMs
        : null;

    const springK = Number.isFinite(deps.ambientSpringK)
        ? deps.ambientSpringK
        : AMBIENT_SPRING_K;
    const random = seededRandomFactory(Number.isFinite(deps.motionSeed) ? deps.motionSeed : undefined);
    const driftPhaseX = random() * Math.PI * 2;
    const driftPhaseY = random() * Math.PI * 2;
    const driftPhaseSecondary = random() * Math.PI * 2;

    let win = null;
    let displayHandlers = null;
    let appHideHandler = null;
    let restoreTimers = [];

    let state = STATE.AMBIENT;
    let stateBeforeDriving = STATE.AMBIENT;
    let position = { x: 0, y: 0 };
    let travel = null; // { from, to, startedAt, durationMs, settleMs, controls, settleFrom, settleState }
    let microTour = null;
    let nextMicroTourAt = null;
    let tickTimer = null;
    let lastBroadcastState = null;
    const tickT0 = clock.now();

    // True while ambient is suppressed because cursor-companion owns the
    // cursor slot (its legacy dot or loader is visible). On the next
    // motion call (moveTo/moveToCursor) we treat this as "starting from
    // the cursor anchor" so the dot reads as appearing-and-leaving
    // rather than teleporting.
    let hiddenForLoader = false;

    function isLoaderActive() {
        if (typeof deps.isCursorCompanionLoading !== 'function') return false;
        try {
            return Boolean(deps.isCursorCompanionLoading());
        } catch (_) {
            return false;
        }
    }

    function isAmbientSuppressed() {
        if (typeof deps.isAmbientSuppressed !== 'function') return false;
        try {
            return Boolean(deps.isAmbientSuppressed());
        } catch (_) {
            return false;
        }
    }

    function shouldHideAmbient() {
        return state === STATE.AMBIENT && (isLoaderActive() || isAmbientSuppressed());
    }

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

    function resolveTravelDuration(from, to) {
        if (Number.isFinite(fixedTravelDurationMs)) {
            return Math.max(1, fixedTravelDurationMs);
        }
        const dist = Math.hypot(to.x - from.x, to.y - from.y);
        return clampMs(
            TRAVEL_BASE_MS + dist * TRAVEL_DISTANCE_SLOPE_MS_PER_PX,
            TRAVEL_MIN_MS,
            TRAVEL_MAX_MS,
        );
    }

    function computeOvershootPoint(from, to) {
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const dist = Math.hypot(dx, dy);
        if (!Number.isFinite(dist) || dist < 1) return { x: to.x, y: to.y };
        const overshoot = Math.min(TRAVEL_OVERSHOOT_PX, dist * 0.12);
        return {
            x: to.x + (dx / dist) * overshoot,
            y: to.y + (dy / dist) * overshoot,
        };
    }

    function randomBetween(min, max) {
        return min + (max - min) * random();
    }

    function scheduleNextMicroTour(now) {
        nextMicroTourAt = now + randomBetween(MICRO_TOUR_MIN_DELAY_MS, MICRO_TOUR_MAX_DELAY_MS);
    }

    function startMicroTour(now) {
        microTour = {
            startedAt: now,
            durationMs: randomBetween(MICRO_TOUR_MIN_DURATION_MS, MICRO_TOUR_MAX_DURATION_MS),
            radius: randomBetween(MICRO_TOUR_MIN_RADIUS_PX, MICRO_TOUR_MAX_RADIUS_PX),
            phase: random() * Math.PI * 2,
            direction: random() < 0.5 ? -1 : 1,
        };
        nextMicroTourAt = null;
    }

    function activeVisualOffset(now) {
        if (!Number.isFinite(now)) return { x: 0, y: 0 };
        if (nextMicroTourAt === null && microTour === null) {
            scheduleNextMicroTour(now);
        }
        if (!microTour && nextMicroTourAt !== null && now >= nextMicroTourAt) {
            startMicroTour(now);
        }

        const t = now - tickT0;
        const driftA = (t / ACTIVE_DRIFT_PERIOD_MS) * Math.PI * 2;
        const driftB = (t / ACTIVE_DRIFT_SECONDARY_PERIOD_MS) * Math.PI * 2;
        const drift = {
            x: Math.sin(driftA + driftPhaseX) * ACTIVE_DRIFT_RADIUS_PX
                + Math.sin(driftB + driftPhaseSecondary) * ACTIVE_DRIFT_RADIUS_PX * 0.35,
            y: (Math.cos(driftA * 0.92 + driftPhaseY) * ACTIVE_DRIFT_RADIUS_PX
                + Math.sin(driftB * 1.08 + driftPhaseSecondary) * ACTIVE_DRIFT_RADIUS_PX * 0.28)
                * ACTIVE_DRIFT_VERTICAL_SCALE,
        };

        if (!microTour) return drift;
        const elapsed = now - microTour.startedAt;
        const rawProgress = clamp01(elapsed / microTour.durationMs);
        if (rawProgress >= 1) {
            microTour = null;
            scheduleNextMicroTour(now);
            return drift;
        }
        const envelope = Math.sin(Math.PI * rawProgress);
        const lap = rawProgress * Math.PI * 2 * microTour.direction + microTour.phase;
        return {
            x: drift.x + Math.cos(lap) * microTour.radius * envelope,
            y: drift.y + Math.sin(lap) * microTour.radius * envelope,
        };
    }

    function activeVisualPosition(now) {
        const offset = activeVisualOffset(now);
        return clampToDisplay(position.x + offset.x, position.y + offset.y);
    }

    function sampleTravelPositionAt(now) {
        if (!travel) return { x: position.x, y: position.y };
        const elapsed = now - travel.startedAt;
        const approachMs = Math.max(1, travel.durationMs - travel.settleMs);
        if (elapsed <= approachMs) {
            const eased = easeOutCubic(clamp01(elapsed / approachMs));
            return bezierAt(travel.controls, eased);
        }
        const settleProgress = easeInOutSine(clamp01((elapsed - approachMs) / Math.max(1, travel.settleMs)));
        return {
            x: lerp(travel.settleFrom.x, travel.to.x, settleProgress),
            y: lerp(travel.settleFrom.y, travel.to.y, settleProgress),
        };
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
            // While cursor-companion owns the cursor slot, hide this
            // ambient avatar. Snap position to the live cursor target
            // so a following moveTo can travel from the natural anchor.
            const target = computeCursorTarget();
            if (shouldHideAmbient()) {
                position.x = target.x;
                position.y = target.y;
                if (!hiddenForLoader) {
                    hiddenForLoader = true;
                    if (isUsable(win) && typeof win.hide === 'function') {
                        try { win.hide(); } catch (_) { /* best-effort */ }
                    }
                }
                return;
            }
            if (hiddenForLoader) {
                hiddenForLoader = false;
                if (isUsable(win) && typeof win.showInactive === 'function') {
                    try { win.showInactive(); } catch (_) { /* best-effort */ }
                }
            }
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
            const progress = Math.min(1, elapsed / travel.durationMs);
            const pt = sampleTravelPositionAt(now);
            position.x = pt.x;
            position.y = pt.y;

            if (progress >= 1) {
                const settleState = travel.settleState;
                travel = null;
                state = settleState;
                microTour = null;
                nextMicroTourAt = null;
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
            const hover = Math.sin(phase) * BREATH_AMPLITUDE_PX;
            const render = activeVisualPosition(now);
            applyBoundsCentered(render.x, render.y + hover);
        }

        if (state === STATE.DRIVING) {
            const cursor = deps.screen.getCursorScreenPoint();
            const target = clampToDisplay(cursor.x, cursor.y);
            position.x = target.x;
            position.y = target.y;
            applyBoundsCentered(position.x, position.y);
        }
    }

    // If we're mid-travel when a new motion is requested, sample the
    // current eased position first so the new travel starts from where
    // the dot ACTUALLY is, not from the last persisted base position.
    function sampleCurrentPosition() {
        if (state === STATE.TRAVELING && travel) {
            const pt = sampleTravelPositionAt(clock.now());
            position.x = pt.x;
            position.y = pt.y;
        } else if (state === STATE.ACTIVE) {
            const pt = activeVisualPosition(clock.now());
            position.x = pt.x;
            position.y = pt.y;
            microTour = null;
            nextMicroTourAt = null;
        }
    }

    function startTravelTo(target, settleState) {
        sampleCurrentPosition();
        // If we were hidden by the cursor-companion loader, re-anchor
        // to the live cursor before traveling so the dot reads as
        // departing from "home" rather than teleporting from a stale
        // pre-loader position. The loader keeps running unaffected —
        // both surfaces simply share the cursor slot at travel start.
        if (hiddenForLoader) {
            const anchor = computeCursorTarget();
            position.x = anchor.x;
            position.y = anchor.y;
            hiddenForLoader = false;
            if (isUsable(win) && typeof win.showInactive === 'function') {
                try { win.showInactive(); } catch (_) { /* best-effort */ }
            }
        }
        const from = { x: position.x, y: position.y };
        const to = { x: target.x, y: target.y };
        const durationMs = resolveTravelDuration(from, to);
        const settleMs = Math.min(TRAVEL_SETTLE_MS, Math.max(0, durationMs * 0.25));
        const settleFrom = computeOvershootPoint(from, to);
        travel = {
            from,
            to,
            controls: computeBezierControls(from, to),
            startedAt: clock.now(),
            durationMs,
            settleMs,
            settleFrom,
            settleState,
        };
        microTour = null;
        nextMicroTourAt = null;
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

    function beginDriving() {
        if (state === STATE.DRIVING) return { state };
        sampleCurrentPosition();
        stateBeforeDriving = state === STATE.TRAVELING ? STATE.ACTIVE : state;
        hiddenForLoader = false;
        if (isUsable(win) && typeof win.showInactive === 'function') {
            try { win.showInactive(); } catch (_) { /* best-effort */ }
        }
        state = STATE.DRIVING;
        broadcastState();
        startTick();
        tick();
        logDebug('[AGENT-AVATAR] beginDriving');
        return { state };
    }

    function endDriving() {
        if (state !== STATE.DRIVING) return { state };
        state = stateBeforeDriving || STATE.AMBIENT;
        stateBeforeDriving = STATE.AMBIENT;
        broadcastState();
        startTick();
        logDebug('[AGENT-AVATAR] endDriving');
        return { state };
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
                if (!shouldHideAmbient()) {
                    w.showInactive();
                }
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
        // Don't re-show while cursor-companion deliberately owns the
        // cursor slot. App-hide → restore can otherwise race that
        // suppression and bring the ambient avatar back mid-turn.
        if (hiddenForLoader || shouldHideAmbient()) return;
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
        beginDriving,
        endDriving,
        getState: () => state,
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
        TRAVEL_MIN_MS,
        TRAVEL_MAX_MS,
        TRAVEL_SETTLE_MS,
        TRAVEL_OVERSHOOT_PX,
        ACTIVE_DRIFT_RADIUS_PX,
        MICRO_TOUR_MIN_DELAY_MS,
        MICRO_TOUR_MAX_DELAY_MS,
        DETACH_KICK_FRACTION,
        DETACH_KICK_MAX_PX,
        ARC_PERPENDICULAR_FRACTION,
        ARC_PERPENDICULAR_MAX_PX,
        MIN_CURVE_DIST_PX,
        STATE,
        computeBezierControls,
        bezierAt,
    },
};
