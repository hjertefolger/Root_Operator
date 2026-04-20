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
    } = deps;

    let tray = null;
    let shortcutHook = null;
    let shiftKeyCodes = [];
    let shiftShortcutStarted = false;
    let lastShiftKeyUpCode = null;
    let lastShiftKeyUpTime = 0;
    let hadOtherKeyBetweenShiftTaps = false;
    let shiftToggleCallback = null;

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

    function initDoubleShiftShortcut(callback) {
        shiftToggleCallback = callback;

        try {
            const { uIOhook, UiohookKey } = require('uiohook-napi');
            shortcutHook = uIOhook;
            shiftKeyCodes = [UiohookKey.Shift, UiohookKey.ShiftRight];
            shortcutHook.on('keydown', handleModifierShortcutKeyDown);
            shortcutHook.on('keyup', handleModifierShortcutKeyUp);
            shortcutHook.start();
            shiftShortcutStarted = true;
            logDebug('[SHORTCUT] Double-Shift shortcut active');
        } catch (error) {
            shortcutHook = null;
            shiftKeyCodes = [];
            shiftShortcutStarted = false;
            logDebug(`[SHORTCUT] Failed to initialize Double-Shift shortcut: ${error.message}`);
        }
    }

    function stopDoubleShiftShortcut() {
        if (!shortcutHook || !shiftShortcutStarted) {
            return;
        }

        try {
            shortcutHook.off('keydown', handleModifierShortcutKeyDown);
            shortcutHook.off('keyup', handleModifierShortcutKeyUp);
            shortcutHook.stop();
        } catch (error) {
            logDebug(`[SHORTCUT] Failed to stop Double-Shift shortcut: ${error.message}`);
        }

        shortcutHook = null;
        shiftKeyCodes = [];
        shiftShortcutStarted = false;
        lastShiftKeyUpCode = null;
        lastShiftKeyUpTime = 0;
        hadOtherKeyBetweenShiftTaps = false;
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
