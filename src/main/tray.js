const fs = require('fs');
const path = require('path');

// Pass iconDirectory from the legacy main-process asset root; the tray PNGs still live beside main.js.
function init(deps = {}) {
    const {
        app,
        Tray,
        Menu,
        shell,
        globalShortcut,
        fs: fsImpl = fs,
        path: pathImpl = path,
        logger = console,
        iconDirectory,
        websiteUrl = 'https://rootoperator.dev',
        getMainWindow = () => null,
        getOperatingMode = () => 'channel',
        setOperatingMode = () => {},
        showAboutWindow = () => {},
        syncStateWithRenderer = () => {},
        getStoredTunnelSettings = async () => ({}),
        startBridge = async () => {},
        stopBridge = () => {},
        getIsConnecting = () => false,
        getServer = () => null,
        getTunnelProcess = () => null,
        logDebug = () => {},
        doubleShiftWindowMs = 300,
        toggleLocalChatWindow = () => {},
        toggleCursorCompanionEnabled = () => {},
    } = deps;

    let tray = null;
    let shortcutHook = null;
    let shiftKeyCodes = [];
    let shiftShortcutStarted = false;
    let shiftListenersAttached = false;
    let lastShiftKeyUpCode = null;
    let lastShiftKeyUpTime = 0;
    let hadOtherKeyBetweenShiftTaps = false;
    let shiftToggleCallback = null;
    // Pending restart timer scheduled by restartDoubleShiftShortcut.
    // Captured here so a teardown via stopDoubleShiftShortcut can cancel
    // it before it fires — without this, a `resume` powerMonitor event
    // arriving moments before app quit can re-start uIOhook after we've
    // torn it down.
    let pendingResumeTimer = null;
    let resumeRetryAttempt = 0;
    const RESUME_RETRY_BACKOFF_MS = [200, 500, 1500, 3000];

    function resetShiftDetectorState() {
        lastShiftKeyUpCode = null;
        lastShiftKeyUpTime = 0;
        hadOtherKeyBetweenShiftTaps = false;
    }

    function getTray() {
        return tray;
    }

    function getIconPath(iconName) {
        return pathImpl.join(iconDirectory, iconName);
    }

    function getUsableMainWindow() {
        const mainWindow = getMainWindow();
        if (!mainWindow || typeof mainWindow.isDestroyed !== 'function' || mainWindow.isDestroyed()) {
            return null;
        }

        return mainWindow;
    }

    function isActiveShiftCode(keycode) {
        return shiftKeyCodes.includes(keycode);
    }

    function handleModifierShortcutKeyDown(event) {
        if (!shiftShortcutStarted) {
            return;
        }

        if (isActiveShiftCode(event.keycode)) {
            return;
        }

        hadOtherKeyBetweenShiftTaps = true;
    }

    function handleModifierShortcutKeyUp(event) {
        if (!shiftShortcutStarted || !isActiveShiftCode(event.keycode)) {
            return;
        }

        const now = Date.now();
        if (
            !hadOtherKeyBetweenShiftTaps
            && lastShiftKeyUpCode !== null
            && isActiveShiftCode(lastShiftKeyUpCode)
            && now - lastShiftKeyUpTime <= doubleShiftWindowMs
        ) {
            lastShiftKeyUpCode = null;
            lastShiftKeyUpTime = 0;
            hadOtherKeyBetweenShiftTaps = false;
            if (typeof shiftToggleCallback === 'function') {
                shiftToggleCallback();
            }
            return;
        }

        lastShiftKeyUpCode = event.keycode;
        lastShiftKeyUpTime = now;
        hadOtherKeyBetweenShiftTaps = false;
    }

    function createTray() {
        try {
            logger.log('Creating tray...');
            const iconPath = getIconPath('tray_iconTemplate.png');

            if (!fsImpl.existsSync(iconPath)) {
                logger.error('Tray icon DOES NOT EXIST at:', iconPath);
                if (app.dock) {
                    app.dock.show();
                }

                const mainWindow = getUsableMainWindow();
                if (mainWindow) {
                    mainWindow.show();
                }
                return null;
            }

            tray = new Tray(iconPath);
            tray.setToolTip('Root Operator');
            tray.setIgnoreDoubleClickEvents(true);

            tray.on('click', () => {
                logger.log('Tray clicked');
                toggleWindow();
            });

            tray.on('right-click', () => {
                const contextMenu = buildTrayMenu();
                tray.popUpContextMenu(contextMenu);
            });

            syncStateWithRenderer();
            logger.log('Tray created successfully');
            return tray;
        } catch (error) {
            logger.error('Failed to create tray:', error);
            if (app.dock) {
                app.dock.show();
            }

            const mainWindow = getUsableMainWindow();
            if (mainWindow) {
                mainWindow.show();
            }
            return null;
        }
    }

    function toggleWindow() {
        const mainWindow = getUsableMainWindow();
        if (!mainWindow) {
            return;
        }

        if (mainWindow.isVisible()) {
            mainWindow.hide();
        } else {
            showWindow();
        }
    }

    function showWindow() {
        if (!tray) {
            return;
        }

        const mainWindow = getUsableMainWindow();
        if (!mainWindow) {
            return;
        }

        const trayBounds = tray.getBounds();
        const windowBounds = mainWindow.getBounds();

        const x = Math.round(trayBounds.x + (trayBounds.width / 2) - (windowBounds.width / 2));
        const y = Math.round(trayBounds.y + trayBounds.height + 4);

        mainWindow.setPosition(x, y, false);
        mainWindow.show();
        mainWindow.focus();
        syncStateWithRenderer();
    }

    // Double-Shift gesture lifecycle
    //
    // The macOS CGEvent tap that uIOhook sits on can be invalidated by
    // the OS when the user locks the screen, switches sessions, or the
    // machine sleeps/resumes. libuiohook (the underlying lib) does not
    // automatically re-arm the tap; if we leave it alone, the gesture
    // silently stops working until the app is restarted. The init/stop
    // pair below now expose suspend/resume/restart so that lifecycle
    // events from `powerMonitor` (wired in main.js) can rebuild the tap
    // without tearing down our JS listeners or the toggle callback.
    function initDoubleShiftShortcut(callback) {
        if (typeof callback === 'function') {
            shiftToggleCallback = callback;
        }

        // Idempotent: if a hook is already running just refresh state.
        if (shortcutHook && shiftShortcutStarted) {
            resetShiftDetectorState();
            return;
        }

        try {
            const { uIOhook, UiohookKey } = require('uiohook-napi');
            shortcutHook = uIOhook;
            shiftKeyCodes = [UiohookKey.Shift, UiohookKey.ShiftRight].filter((k) => k != null);
            if (!shiftListenersAttached) {
                shortcutHook.on('keydown', handleModifierShortcutKeyDown);
                shortcutHook.on('keyup', handleModifierShortcutKeyUp);
                shiftListenersAttached = true;
            }
            shortcutHook.start();
            shiftShortcutStarted = true;
            resetShiftDetectorState();
            logDebug('[SHORTCUT] Double-Shift shortcut active');
        } catch (error) {
            // If start() threw, listeners may already be attached. Detach
            // them before clearing the bookkeeping flag so a future retry
            // can attach a fresh pair without doubling up — duplicate
            // keyup handlers turn one Shift release into two and would
            // make the gesture detector see a single tap as a double-tap.
            if (shiftListenersAttached && shortcutHook) {
                try {
                    shortcutHook.off('keydown', handleModifierShortcutKeyDown);
                    shortcutHook.off('keyup', handleModifierShortcutKeyUp);
                } catch (_) { /* best effort */ }
            }
            shortcutHook = null;
            shiftKeyCodes = [];
            shiftShortcutStarted = false;
            shiftListenersAttached = false;
            logDebug(`[SHORTCUT] Failed to initialize Double-Shift shortcut: ${error.message}`);
        }
    }

    // Suspend the native tap without removing our JS listeners or the
    // callback. Used when the OS is about to invalidate the tap (lock,
    // resign-active) so we can resume cleanly afterwards.
    function suspendDoubleShiftShortcut(reason = '') {
        // Cancel any deferred resume the previous unlock/resume queued.
        // Without this, an unlock→quick-lock sequence can leave a 200ms
        // restart timer alive that fires while the system is now locked
        // again, re-arming uIOhook in the wrong state.
        if (pendingResumeTimer) {
            clearTimeout(pendingResumeTimer);
            pendingResumeTimer = null;
        }
        // Suspending invalidates any in-flight retry chain.
        resumeRetryAttempt = 0;
        if (!shortcutHook || !shiftShortcutStarted) {
            return;
        }
        try {
            shortcutHook.stop();
        } catch (error) {
            logDebug(`[SHORTCUT] Suspend failed (${reason}): ${error.message}`);
        }
        shiftShortcutStarted = false;
        resetShiftDetectorState();
        logDebug(`[SHORTCUT] Double-Shift suspended (${reason || 'no reason'})`);
    }

    // Resume the native tap. Listeners and callback are preserved.
    // On failure, schedule bounded exponential-backoff retries — macOS
    // can refuse uIOhook.start() briefly during slow unlock/login
    // animations or fast user switching transitions, and a single
    // 200ms attempt is not enough to ride that out.
    function resumeDoubleShiftShortcut(reason = '') {
        if (shiftShortcutStarted) {
            resumeRetryAttempt = 0;
            return;
        }
        if (!shortcutHook) {
            initDoubleShiftShortcut(shiftToggleCallback);
            if (shiftShortcutStarted) {
                resumeRetryAttempt = 0;
            } else {
                scheduleResumeRetry(reason);
            }
            return;
        }
        try {
            shortcutHook.start();
            shiftShortcutStarted = true;
            resetShiftDetectorState();
            resumeRetryAttempt = 0;
            logDebug(`[SHORTCUT] Double-Shift resumed (${reason || 'no reason'})`);
        } catch (error) {
            logDebug(`[SHORTCUT] Resume failed (${reason}, attempt ${resumeRetryAttempt + 1}): ${error.message}`);
            scheduleResumeRetry(reason);
        }
    }

    function scheduleResumeRetry(reason) {
        if (resumeRetryAttempt >= RESUME_RETRY_BACKOFF_MS.length) {
            logDebug(`[SHORTCUT] Resume gave up after ${resumeRetryAttempt} attempts (${reason})`);
            resumeRetryAttempt = 0;
            return;
        }
        const delay = RESUME_RETRY_BACKOFF_MS[resumeRetryAttempt];
        resumeRetryAttempt += 1;
        if (pendingResumeTimer) {
            clearTimeout(pendingResumeTimer);
        }
        pendingResumeTimer = setTimeout(() => {
            pendingResumeTimer = null;
            resumeDoubleShiftShortcut(`${reason}-retry-${resumeRetryAttempt}`);
        }, delay);
    }

    // Restart the native tap. macOS finishes its own auth/animation
    // before we re-arm — a small delay avoids racing the loginwindow
    // tap-disable on unlock.
    function restartDoubleShiftShortcut(reason = '', delayMs = 200) {
        // Cancel any prior pending restart so back-to-back calls don't
        // queue multiple deferred resumes.
        if (pendingResumeTimer) {
            clearTimeout(pendingResumeTimer);
            pendingResumeTimer = null;
        }
        suspendDoubleShiftShortcut(reason);
        const safeDelay = Math.max(0, Number.isFinite(delayMs) ? delayMs : 0);
        if (safeDelay === 0) {
            resumeDoubleShiftShortcut(reason);
            return;
        }
        pendingResumeTimer = setTimeout(() => {
            pendingResumeTimer = null;
            resumeDoubleShiftShortcut(reason);
        }, safeDelay);
    }

    function stopDoubleShiftShortcut() {
        // Always cancel any pending deferred resume — without this, an
        // unlock-screen / resume that scheduled a restart could fire
        // after teardown and re-arm uIOhook on a hook we just dropped.
        if (pendingResumeTimer) {
            clearTimeout(pendingResumeTimer);
            pendingResumeTimer = null;
        }
        resumeRetryAttempt = 0;

        if (!shortcutHook) {
            shiftListenersAttached = false;
            shiftShortcutStarted = false;
            shiftKeyCodes = [];
            shiftToggleCallback = null;
            resetShiftDetectorState();
            return;
        }

        try {
            if (shiftListenersAttached) {
                shortcutHook.off('keydown', handleModifierShortcutKeyDown);
                shortcutHook.off('keyup', handleModifierShortcutKeyUp);
            }
            if (shiftShortcutStarted) {
                shortcutHook.stop();
            }
        } catch (error) {
            logDebug(`[SHORTCUT] Failed to stop Double-Shift shortcut: ${error.message}`);
        }

        shortcutHook = null;
        shiftKeyCodes = [];
        shiftShortcutStarted = false;
        shiftListenersAttached = false;
        resetShiftDetectorState();
        shiftToggleCallback = null;
    }

    function registerGlobalShortcuts() {
        const startTunnelRegistered = globalShortcut.register('CommandOrControl+Shift+J', async () => {
            if (getIsConnecting() || getServer() || getTunnelProcess()) {
                stopBridge();
                return;
            }

            try {
                const cfSettings = await getStoredTunnelSettings();
                await startBridge(cfSettings);
            } catch (error) {
                stopBridge();
                logDebug(`[SHORTCUT] Failed to toggle tunnel from shortcut: ${error.message}`);
            }
        });

        if (!startTunnelRegistered) {
            logDebug('[SHORTCUT] Failed to register CommandOrControl+Shift+J');
        }

        const desktopChatRegistered = globalShortcut.register('CommandOrControl+Shift+K', () => {
            try {
                toggleLocalChatWindow();
            } catch (error) {
                logDebug(`[SHORTCUT] Failed to toggle desktop chat: ${error.message}`);
            }
        });

        if (!desktopChatRegistered) {
            logDebug('[SHORTCUT] Failed to register CommandOrControl+Shift+K');
        }

        const cursorCompanionRegistered = globalShortcut.register('CommandOrControl+Shift+L', () => {
            try {
                toggleCursorCompanionEnabled();
            } catch (error) {
                logDebug(`[SHORTCUT] Failed to toggle cursor companion: ${error.message}`);
            }
        });

        if (!cursorCompanionRegistered) {
            logDebug('[SHORTCUT] Failed to register CommandOrControl+Shift+L');
        }
    }

    function buildTrayMenu() {
        const operatingMode = getOperatingMode();
        const menuItems = [
            { label: 'Root_Operator', enabled: false },
            { type: 'separator' },
            {
                label: 'Mode',
                submenu: [
                    {
                        label: 'Terminal',
                        type: 'radio',
                        checked: operatingMode === 'terminal',
                        click: () => setOperatingMode('terminal'),
                    },
                    {
                        label: 'Claude Code Channel',
                        type: 'radio',
                        checked: operatingMode === 'channel',
                        click: () => setOperatingMode('channel'),
                    },
                ],
            },
            { type: 'separator' },
            { label: 'About', click: () => showAboutWindow() },
            { label: 'Website', click: () => shell.openExternal(websiteUrl) },
            { type: 'separator' },
            { label: 'Quit', click: () => app.quit() },
        ];

        return Menu.buildFromTemplate(menuItems);
    }

    function formatTrayTooltip(state) {
        const modeLabel = state.mode === 'channel' ? 'Chat' : 'Terminal';
        return [
            'Root Operator',
            `Mode: ${modeLabel}`,
            `Status: ${state.health.overall.label}`,
            `Tunnel: ${state.health.tunnel.label}`,
            `Chat: ${state.health.channel.label}`,
            state.health.channel.activity?.label ? `Activity: ${state.health.channel.activity.label}` : null,
            state.update && !['disabled', 'idle'].includes(state.update.status)
                ? `Update: ${state.update.label}`
                : null,
        ].filter(Boolean).join('\n');
    }

    function setTrayIconState(isActive) {
        if (!tray) {
            return;
        }

        const iconName = isActive ? 'tray_icon_active.png' : 'tray_iconTemplate.png';
        tray.setImage(getIconPath(iconName));
    }

    return {
        getTray,
        createTray,
        toggleWindow,
        showWindow,
        initDoubleShiftShortcut,
        suspendDoubleShiftShortcut,
        resumeDoubleShiftShortcut,
        restartDoubleShiftShortcut,
        stopDoubleShiftShortcut,
        registerGlobalShortcuts,
        buildTrayMenu,
        formatTrayTooltip,
        setTrayIconState,
    };
}

module.exports = {
    init,
};
