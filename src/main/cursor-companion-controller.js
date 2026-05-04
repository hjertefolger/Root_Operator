/**
 * Cursor Companion controller — owns the persistent enabled flag and
 * the start/stop lifecycle of the cursor companion subsystem. Sits
 * between the cursor-companion module (which knows how to draw a dot,
 * open a bubble, etc.) and main.js (which holds the electron-store and
 * the powerMonitor wiring).
 *
 * The controller is intentionally small and idempotent: callers can
 * invoke setEnabled(true)/setEnabled(false)/toggle() repeatedly without
 * worrying about double-start or double-stop.
 *
 * Animation choreography is split between this controller (start/stop
 * timing, send exit ping) and the renderer (entry/exit visual).
 */

const STORE_KEY = 'cursorCompanionEnabled';
// Must match the `cursor-presence-exit` keyframe duration in
// CursorCompanionView.jsx (200ms). 20ms slack ensures the renderer
// has reached the final frame before the window is destroyed.
const EXIT_ANIMATION_MS = 220;

function init(deps = {}) {
    const {
        getStore,
        cursorCompanion,
        // Optional sibling — annotation surface that piggybacks on the
        // companion's enabled state. When companion is disabled, any
        // open annotation surface should also tear down so a stale
        // panel doesn't survive a master-toggle-off.
        cursorAnnotation = null,
        getAgentAvatar = () => null,
        logDebug = () => {},
        broadcastEnabled = () => {},
    } = deps;

    if (typeof getStore !== 'function') {
        throw new TypeError('cursor-companion-controller.init missing dependency: getStore');
    }
    if (!cursorCompanion || typeof cursorCompanion.start !== 'function') {
        throw new TypeError('cursor-companion-controller.init missing dependency: cursorCompanion');
    }

    let enabled = false;
    let pendingExitTimer = null;

    function readPersisted() {
        try {
            const stored = getStore().get(STORE_KEY, false);
            return stored === true;
        } catch (error) {
            logDebug(`[CURSOR_CTL] Failed to read persisted flag: ${error.message}`);
            return false;
        }
    }

    function writePersisted(value) {
        try {
            getStore().set(STORE_KEY, Boolean(value));
        } catch (error) {
            logDebug(`[CURSOR_CTL] Failed to persist flag: ${error.message}`);
        }
    }

    function clearPendingExit() {
        if (pendingExitTimer) {
            clearTimeout(pendingExitTimer);
            pendingExitTimer = null;
        }
    }

    function startCompanion(reason) {
        clearPendingExit();
        try {
            cursorCompanion.start();
            try {
                const agentAvatar = getAgentAvatar();
                if (agentAvatar && typeof agentAvatar.start === 'function' && !agentAvatar.getWindow?.()) {
                    agentAvatar.start();
                }
            } catch (_) { /* optional sibling */ }
            // Ask the renderer to play its entrance animation. The
            // renderer no-ops if the window isn't ready yet (the
            // companion handles its own ready-to-show flow).
            if (typeof cursorCompanion.notifyEnabledChanged === 'function') {
                cursorCompanion.notifyEnabledChanged(true);
            }
            logDebug(`[CURSOR_CTL] companion started (${reason || 'no reason'})`);
        } catch (error) {
            logDebug(`[CURSOR_CTL] start failed (${reason}): ${error.message}`);
        }
    }

    function stopCompanion(reason) {
        clearPendingExit();
        // Stop annotation surface synchronously — no exit animation
        // for a presence-feature-being-disabled scenario, just close.
        if (cursorAnnotation && typeof cursorAnnotation.stop === 'function') {
            try { cursorAnnotation.stop(); } catch (_) { /* ignore */ }
        }
        try {
            const agentAvatar = getAgentAvatar();
            if (agentAvatar && typeof agentAvatar.stop === 'function') {
                agentAvatar.stop();
            }
        } catch (_) { /* optional sibling */ }
        // Tell the renderer to play its exit animation first, then close
        // the window after a delay long enough to cover that animation.
        try {
            if (typeof cursorCompanion.notifyEnabledChanged === 'function') {
                cursorCompanion.notifyEnabledChanged(false);
            }
        } catch (error) {
            logDebug(`[CURSOR_CTL] notify(false) failed: ${error.message}`);
        }
        pendingExitTimer = setTimeout(() => {
            pendingExitTimer = null;
            try {
                cursorCompanion.stop();
                logDebug(`[CURSOR_CTL] companion stopped (${reason || 'no reason'})`);
            } catch (error) {
                logDebug(`[CURSOR_CTL] stop failed (${reason}): ${error.message}`);
            }
        }, EXIT_ANIMATION_MS);
    }

    function setEnabled(next, reason = '') {
        const target = Boolean(next);
        if (target === enabled) {
            return enabled;
        }
        enabled = target;
        writePersisted(enabled);
        if (enabled) {
            startCompanion(reason);
        } else {
            stopCompanion(reason);
        }
        try { broadcastEnabled(enabled); } catch (_) { /* ignore */ }
        return enabled;
    }

    function toggle(reason = '') {
        return setEnabled(!enabled, reason || 'toggle');
    }

    function isEnabled() {
        return enabled;
    }

    /**
     * Boot — read the persisted flag and start the companion if the
     * user previously enabled it. Returns the resolved enabled state.
     */
    function bootstrap() {
        enabled = readPersisted();
        if (enabled) {
            startCompanion('bootstrap');
        }
        return enabled;
    }

    /**
     * Tear down on app quit. Stops the companion synchronously; skips
     * the exit animation since the window will close anyway.
     */
    function shutdown() {
        clearPendingExit();
        if (cursorAnnotation && typeof cursorAnnotation.stop === 'function') {
            try { cursorAnnotation.stop(); } catch (_) { /* ignore */ }
        }
        try { cursorCompanion.stop(); } catch (_) { /* ignore */ }
        enabled = false;
    }

    return {
        bootstrap,
        shutdown,
        setEnabled,
        toggle,
        isEnabled,
        STORE_KEY,
        EXIT_ANIMATION_MS,
    };
}

module.exports = { init };
