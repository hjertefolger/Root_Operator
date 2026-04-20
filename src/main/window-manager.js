const { defaultUpdateState: defaultUpdateStateFactory } = require('../updater');

const DEFAULT_RENDERER_ENTRY = 'ui/dist/renderer.html';
const DEFAULT_UPDATE_BANNER_DISMISSED_VERSION_KEY = 'updateBannerDismissedVersion';

function requireDependency(name, value) {
    if (value === undefined || value === null) {
        throw new TypeError(`window-manager.init missing dependency: ${name}`);
    }
    return value;
}

function requireFunction(name, value) {
    if (typeof value !== 'function') {
        throw new TypeError(`window-manager.init expected function dependency: ${name}`);
    }
    return value;
}

function isUsableWindow(window) {
    return Boolean(window && !window.isDestroyed());
}

function resolveFilePath(path, baseDir, candidate) {
    if (!candidate) {
        return candidate;
    }

    return path.isAbsolute(candidate) ? candidate : path.join(baseDir, candidate);
}

function loadRuntimeConfig(fs, path, appDir) {
    const configPath = path.join(appDir, 'runtime-config.json');

    try {
        if (!fs.existsSync(configPath)) {
            return {};
        }

        const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function init(deps = {}) {
    const app = requireDependency('app', deps.app);
    const BrowserWindow = requireDependency('BrowserWindow', deps.BrowserWindow);
    const Menu = requireDependency('Menu', deps.Menu);
    const nativeImage = requireDependency('nativeImage', deps.nativeImage);
    const defaultUpdateState = typeof deps.defaultUpdateState === 'function'
        ? deps.defaultUpdateState
        : defaultUpdateStateFactory;
    const fs = requireDependency('fs', deps.fs);
    const path = requireDependency('path', deps.path);
    const appDir = requireDependency('appDir', deps.appDir);
    const getStore = requireFunction('getStore', deps.getStore);
    const getMainWindow = requireFunction('getMainWindow', deps.getMainWindow);
    const setMainWindow = requireFunction('setMainWindow', deps.setMainWindow);
    const getLocalChatWindow = requireFunction('getLocalChatWindow', deps.getLocalChatWindow);
    const setLocalChatWindow = requireFunction('setLocalChatWindow', deps.setLocalChatWindow);
    const getAboutWindow = requireFunction('getAboutWindow', deps.getAboutWindow);
    const setAboutWindow = requireFunction('setAboutWindow', deps.setAboutWindow);
    const getIsConnecting = requireFunction('getIsConnecting', deps.getIsConnecting);
    const getServer = requireFunction('getServer', deps.getServer);
    const getTunnelProcess = requireFunction('getTunnelProcess', deps.getTunnelProcess);
    const getCurrentTunnelUrl = requireFunction('getCurrentTunnelUrl', deps.getCurrentTunnelUrl);
    const getCurrentFingerprint = requireFunction('getCurrentFingerprint', deps.getCurrentFingerprint);
    const getCurrentSessionStartedAt = requireFunction('getCurrentSessionStartedAt', deps.getCurrentSessionStartedAt);
    const getOperatingMode = requireFunction('getOperatingMode', deps.getOperatingMode);
    const getChannelStatus = requireFunction('getChannelStatus', deps.getChannelStatus);
    const getChannelManager = requireFunction('getChannelManager', deps.getChannelManager);
    const getUpdater = requireFunction('getUpdater', deps.getUpdater);
    const getHasActiveChannelActivity = requireFunction('getHasActiveChannelActivity', deps.getHasActiveChannelActivity);
    const getActivityAssistantName = requireFunction('getActivityAssistantName', deps.getActivityAssistantName);
    const getScheduler = requireFunction('getScheduler', deps.getScheduler);
    const getTray = typeof deps.getTray === 'function' ? deps.getTray : () => null;
    const getTrayIconSetter = requireFunction('getTrayIconSetter', deps.getTrayIconSetter);
    const getTrayTooltipFormatter = requireFunction('getTrayTooltipFormatter', deps.getTrayTooltipFormatter);
    const getActiveClients = requireFunction('getActiveClients', deps.getActiveClients);
    const logDebug = typeof deps.logDebug === 'function' ? deps.logDebug : () => {};

    const isDev = Boolean(deps.isDev);
    const runtimeConfig = loadRuntimeConfig(fs, path, appDir);
    const viteRendererPort = deps.viteRendererPort
        || parseInt(process.env.VITE_RENDERER_PORT || runtimeConfig.VITE_RENDERER_PORT, 10)
        || 5174;
    const updateBannerDismissedVersionKey = deps.updateBannerDismissedVersionKey || DEFAULT_UPDATE_BANNER_DISMISSED_VERSION_KEY;
    const webSocketOpenState = deps.webSocketOpenState ?? 1;
    const rendererEntry = resolveFilePath(path, appDir, deps.rendererEntry || DEFAULT_RENDERER_ENTRY);
    const preloadPath = resolveFilePath(path, appDir, deps.preloadPath || 'preload.js');
    const aboutIconPath = resolveFilePath(path, appDir, deps.aboutIconPath || path.join('public', 'icon-512-v3.png'));
    const preferredDockIconPath = resolveFilePath(path, appDir, deps.preferredDockIconPath || path.join('public', 'icon-macos-dock.png'));
    const fallbackDockIconPath = resolveFilePath(path, appDir, deps.fallbackDockIconPath || path.join('public', 'icon-512-v3.png'));
    const viewerWindowStateByWebContentsId = new Map();

    function loadRendererWindow(window, search = '') {
        if (isDev) {
            if (!viteRendererPort) {
                throw new Error('window-manager.init requires viteRendererPort in development mode');
            }

            window.loadURL(`http://localhost:${viteRendererPort}/renderer.html${search}`);
            return;
        }

        if (search) {
            window.loadFile(rendererEntry, { search });
            return;
        }

        window.loadFile(rendererEntry);
    }

    function getDevDockIconPath() {
        if (!isDev) {
            return null;
        }

        if (fs.existsSync(preferredDockIconPath)) {
            return preferredDockIconPath;
        }

        return fs.existsSync(fallbackDockIconPath) ? fallbackDockIconPath : null;
    }

    function applyDevDockIcon() {
        if (!isDev || process.platform !== 'darwin' || !app.dock) {
            return;
        }

        const iconPath = getDevDockIconPath();
        if (!iconPath) {
            return;
        }

        const dockIcon = nativeImage.createFromPath(iconPath);
        if (!dockIcon.isEmpty()) {
            app.dock.setIcon(dockIcon);
        }
    }

    function getTunnelHealth() {
        const currentTunnelUrl = getCurrentTunnelUrl();
        if (currentTunnelUrl) {
            return {
                level: 'green',
                label: 'Tunnel live',
                detail: `Remote clients can reach ${currentTunnelUrl}.`,
            };
        }

        if (getIsConnecting() || getTunnelProcess() || getServer()) {
            return {
                level: 'orange',
                label: 'Starting tunnel',
                detail: 'Root Operator is still bringing the remote tunnel online.',
            };
        }

        return {
            level: 'red',
            label: 'Tunnel offline',
            detail: 'Remote clients cannot reach this machine until the tunnel starts.',
        };
    }

    function getOverallHealth(tunnelHealth, channelHealth) {
        if (getOperatingMode() === 'channel') {
            if (tunnelHealth.level !== 'green') {
                return {
                    level: tunnelHealth.level,
                    label: tunnelHealth.label,
                    detail: tunnelHealth.detail,
                };
            }

            return {
                level: channelHealth.level,
                label: channelHealth.label,
                detail: channelHealth.detail,
            };
        }

        if (tunnelHealth.level === 'green') {
            return {
                level: 'green',
                label: 'Terminal ready',
                detail: 'The tunnel is live and terminal clients can attach normally.',
            };
        }

        if (tunnelHealth.level === 'orange') {
            return {
                level: 'orange',
                label: 'Starting terminal tunnel',
                detail: tunnelHealth.detail,
            };
        }

        return {
            level: 'red',
            label: 'Terminal offline',
            detail: tunnelHealth.detail,
        };
    }

    function getUpdateInstallGate() {
        const reasons = [];
        if (getIsConnecting() || getCurrentTunnelUrl() || getTunnelProcess()) {
            reasons.push('the tunnel is active');
        }

        if (getOperatingMode() === 'channel' && getHasActiveChannelActivity()) {
            reasons.push(`${getActivityAssistantName()} is active`);
        }

        const scheduler = getScheduler();
        if (scheduler) {
            const runningJobs = scheduler.listJobs().filter((job) => job.running);
            if (runningJobs.length > 0) {
                reasons.push(runningJobs.length === 1
                    ? `scheduler job "${runningJobs[0].name}" is running`
                    : 'scheduler jobs are running');
            }
        }

        return reasons.length > 0
            ? { ok: false, reason: reasons.join(', ') }
            : { ok: true, reason: '' };
    }

    function getUpdateState() {
        const updater = getUpdater();
        const base = updater
            ? updater.getState()
            : defaultUpdateState({ packaged: app.isPackaged });
        const activeVersion = base.downloadedVersion || base.availableVersion || '';
        const dismissedVersion = getStore()?.get(updateBannerDismissedVersionKey) || '';

        if (base.status === 'downloaded') {
            const gate = getUpdateInstallGate();
            return {
                ...base,
                canInstallNow: gate.ok,
                installBlockedReason: gate.ok ? '' : gate.reason,
                detail: gate.ok
                    ? 'Restart Root Operator to install the update.'
                    : `Update is ready, but install is deferred: ${gate.reason}`,
                dismissedBanner: !!activeVersion && dismissedVersion === activeVersion,
            };
        }

        return {
            ...base,
            dismissedBanner: !!activeVersion && dismissedVersion === activeVersion,
        };
    }

    function getTunnelState() {
        const server = getServer();
        const currentTunnelUrl = getCurrentTunnelUrl();
        const channelManager = getChannelManager();
        const tunnelHealth = getTunnelHealth();
        const channelHealth = getChannelStatus();

        return {
            active: !!(server && (currentTunnelUrl || getTunnelProcess())),
            connecting: getIsConnecting(),
            url: currentTunnelUrl || '',
            fingerprint: getCurrentFingerprint(),
            sessionStartedAt: getCurrentSessionStartedAt(),
            mode: getOperatingMode(),
            channelConnected: !!(channelManager && channelManager.connected),
            update: getUpdateState(),
            health: {
                overall: getOverallHealth(tunnelHealth, channelHealth),
                tunnel: tunnelHealth,
                channel: channelHealth,
            },
        };
    }

    function sendSyncStateToManagedWindows(state) {
        const mainWindow = getMainWindow();
        if (isUsableWindow(mainWindow)) {
            mainWindow.webContents.send('SYNC_STATE', state);
        }

        const localChatWindow = getLocalChatWindow();
        if (isUsableWindow(localChatWindow)) {
            localChatWindow.webContents.send('SYNC_STATE', state);
        }
    }

    function syncStateWithRenderer() {
        const state = getTunnelState();
        const tray = getTray();
        const setTrayIconState = getTrayIconSetter();
        const formatTrayTooltip = getTrayTooltipFormatter();

        if (tray && typeof setTrayIconState === 'function' && typeof formatTrayTooltip === 'function') {
            setTrayIconState(state.active);
            tray.setToolTip(formatTrayTooltip(state));
        }

        sendSyncStateToManagedWindows(state);
        for (const client of getActiveClients()) {
            if (client.readyState === webSocketOpenState) {
                client.send(JSON.stringify({
                    type: 'system_status',
                    state,
                }));
            }
        }
    }

    function dismissUpdateBanner(version) {
        const store = getStore();
        const targetVersion = version || getUpdateState().downloadedVersion || getUpdateState().availableVersion;
        if (!store || !targetVersion) {
            return { success: false, error: 'No update banner is available to dismiss.' };
        }

        store.set(updateBannerDismissedVersionKey, targetVersion);
        syncStateWithRenderer();
        return { success: true, version: targetVersion };
    }

    function syncDockVisibility() {
        if (!app.dock) {
            return;
        }

        const localChatWindow = getLocalChatWindow();
        const mainWindow = getMainWindow();
        const tray = getTray();
        const localChatVisible = Boolean(
            isUsableWindow(localChatWindow) && localChatWindow.isVisible()
        );
        const fallbackMainVisible = Boolean(
            isUsableWindow(mainWindow) && mainWindow.isVisible() && !tray
        );

        if (localChatVisible || fallbackMainVisible) {
            app.setActivationPolicy('regular');
            applyDevDockIcon();
            app.dock.show();
        } else {
            app.dock.hide();
            app.setActivationPolicy('accessory');
        }
    }

    function createWindow() {
        const mainWindow = new BrowserWindow({
            width: 280,
            height: 400,
            maxHeight: 500,
            show: false,
            frame: false,
            fullscreenable: false,
            resizable: false,
            transparent: true,
            useContentSize: true,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                preload: preloadPath,
                sandbox: true,
            },
        });

        setMainWindow(mainWindow);
        loadRendererWindow(mainWindow);

        mainWindow.on('blur', () => {
            if (!mainWindow.webContents.isDevToolsOpened()) {
                mainWindow.hide();
            }
        });

        mainWindow.webContents.on('did-finish-load', () => {
            syncStateWithRenderer();
        });

        return mainWindow;
    }

    function initializeDesktopShell({ createTray, registerGlobalShortcuts, initDoubleShiftShortcut, toggleLocalChatWindow, setTray } = {}) {
        applyDevDockIcon();
        app.setActivationPolicy('accessory');
        if (app.dock) app.dock.hide();
        Menu.setApplicationMenu(null);
        createWindow();

        if (typeof createTray === 'function') {
            const tray = createTray();
            if (typeof setTray === 'function') {
                setTray(tray);
            }
        }

        if (typeof registerGlobalShortcuts === 'function') {
            registerGlobalShortcuts();
        }
        if (typeof initDoubleShiftShortcut === 'function') {
            initDoubleShiftShortcut(() => {
                if (typeof toggleLocalChatWindow === 'function') {
                    toggleLocalChatWindow();
                }
            });
        }
    }

    function toggleLocalChatWindow() {
        const localChatWindow = getLocalChatWindow();
        if (isUsableWindow(localChatWindow) && localChatWindow.isVisible()) {
            localChatWindow.hide();
            syncDockVisibility();
            return localChatWindow;
        }

        return createLocalChatWindow();
    }

    function createLocalChatWindow() {
        const existingWindow = getLocalChatWindow();
        if (isUsableWindow(existingWindow)) {
            existingWindow.show();
            existingWindow.focus();
            return existingWindow;
        }

        const localChatWindow = new BrowserWindow({
            width: 430,
            height: 760,
            minWidth: 360,
            minHeight: 520,
            show: false,
            frame: false,
            titleBarStyle: 'hidden',
            backgroundColor: '#000000',
            title: 'Root Operator Chat',
            autoHideMenuBar: true,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                preload: preloadPath,
                sandbox: true,
            },
        });

        setLocalChatWindow(localChatWindow);

        if (process.platform === 'darwin') {
            localChatWindow.setWindowButtonVisibility(false);
        }

        loadRendererWindow(localChatWindow, '?view=chat');

        localChatWindow.once('ready-to-show', () => {
            if (isUsableWindow(localChatWindow)) {
                syncDockVisibility();
                localChatWindow.show();
                localChatWindow.focus();
            }
        });

        localChatWindow.on('show', () => {
            syncDockVisibility();
            localChatWindow.webContents.send('LOCAL_CHAT_WINDOW_SHOWN', {
                ts: new Date().toISOString(),
            });
        });

        localChatWindow.on('hide', () => {
            syncDockVisibility();
        });

        localChatWindow.on('closed', () => {
            setLocalChatWindow(null);
            syncDockVisibility();
        });

        localChatWindow.webContents.on('did-finish-load', () => {
            if (isUsableWindow(localChatWindow)) {
                localChatWindow.webContents.send('SYNC_STATE', getTunnelState());
            }
        });

        return localChatWindow;
    }

    function normalizeViewerInitState(payload = {}) {
        const attachments = Array.isArray(payload.attachments)
            ? payload.attachments.filter((attachment) => attachment && typeof attachment === 'object')
            : [];
        const resolvedInitialIndex = Number.isInteger(payload.initialIndex)
            ? payload.initialIndex
            : Number.parseInt(payload.initialIndex, 10);
        const initialIndex = attachments.length > 0
            ? Math.max(0, Math.min(Number.isNaN(resolvedInitialIndex) ? 0 : resolvedInitialIndex, attachments.length - 1))
            : 0;

        return {
            attachments,
            externalRef: typeof payload.externalRef === 'string' && payload.externalRef.trim()
                ? payload.externalRef.trim()
                : null,
            initialIndex,
            parentChatId: typeof payload.parentChatId === 'string' && payload.parentChatId.trim()
                ? payload.parentChatId.trim()
                : null,
        };
    }

    function createAttachmentViewerWindow({ attachments, externalRef, initialIndex, parentChatId, parentWindow }) {
        const viewerWindow = new BrowserWindow({
            width: 1180,
            height: 860,
            minWidth: 720,
            minHeight: 520,
            show: false,
            parent: parentWindow,
            titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
            backgroundColor: '#0a0b10',
            title: 'Attachment Viewer',
            autoHideMenuBar: true,
            resizable: true,
            maximizable: true,
            minimizable: true,
            fullscreenable: true,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                preload: preloadPath,
                sandbox: true,
            },
        });

        viewerWindowStateByWebContentsId.set(viewerWindow.webContents.id, {
            attachments,
            externalRef,
            initialIndex,
            parentChatId,
            parentWindowId: isUsableWindow(parentWindow) ? parentWindow.id : null,
        });

        loadRendererWindow(viewerWindow, '?view=viewer');

        viewerWindow.once('ready-to-show', () => {
            if (!viewerWindow.isDestroyed()) {
                viewerWindow.center();
                viewerWindow.show();
                viewerWindow.focus();
            }
        });

        viewerWindow.on('closed', () => {
            viewerWindowStateByWebContentsId.delete(viewerWindow.webContents.id);
        });

        return viewerWindow;
    }

    function getAttachmentViewerContext(event) {
        const viewerWindow = BrowserWindow.fromWebContents(event.sender);
        if (!viewerWindow || viewerWindow.isDestroyed()) {
            throw new Error('Viewer window unavailable');
        }

        const state = viewerWindowStateByWebContentsId.get(event.sender.id);
        if (!state) {
            throw new Error('Viewer state unavailable');
        }

        const parentWindow = state.parentWindowId ? BrowserWindow.fromId(state.parentWindowId) : null;

        return { viewerWindow, state, parentWindow };
    }

    function normalizeViewerResultPayload(payload = {}) {
        if (typeof payload.filename !== 'string' || !payload.filename.trim()) {
            throw new Error('Viewer filename missing');
        }
        if (typeof payload.mimeType !== 'string' || !payload.mimeType.trim()) {
            throw new Error('Viewer mime type missing');
        }
        if (!Array.isArray(payload.data) || payload.data.length === 0) {
            throw new Error('Viewer image data missing');
        }

        return {
            filename: path.basename(payload.filename.trim()),
            mimeType: payload.mimeType.trim(),
            data: payload.data.map((value) => Number(value) & 0xff),
        };
    }

    function handleAppActivate() {
        const localChatWindow = getLocalChatWindow();
        if (isUsableWindow(localChatWindow)) {
            localChatWindow.show();
            localChatWindow.focus();
            syncDockVisibility();
            return localChatWindow;
        }

        const mainWindow = getMainWindow();
        if (isUsableWindow(mainWindow) && !getTray()) {
            mainWindow.show();
            mainWindow.focus();
            syncDockVisibility();
            return mainWindow;
        }

        return null;
    }

    function registerAppShellEvents() {
        app.on('activate', handleAppActivate);
        app.on('window-all-closed', () => {
            if (process.platform !== 'darwin') app.quit();
        });
    }

    function showAboutWindow() {
        const existingWindow = getAboutWindow();
        if (isUsableWindow(existingWindow)) {
            existingWindow.focus();
            return existingWindow;
        }

        const aboutWindow = new BrowserWindow({
            width: 300,
            height: 340,
            resizable: false,
            minimizable: false,
            maximizable: false,
            fullscreenable: false,
            title: 'About Root_Operator',
            show: false,
            backgroundColor: '#1c1c1e',
            titleBarStyle: 'hidden',
            trafficLightPosition: { x: 12, y: 12 },
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
            },
        });

        setAboutWindow(aboutWindow);

        const iconBase64 = fs.readFileSync(aboutIconPath).toString('base64');
        const version = app.getVersion();
        const html = `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                background: #1c1c1e;
                color: #fff;
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                height: 100vh;
                padding: 20px;
                -webkit-app-region: drag;
                user-select: none;
            }
            .icon {
                width: 80px;
                height: 80px;
                border-radius: 16px;
                margin-bottom: 16px;
            }
            .name {
                font-size: 18px;
                font-weight: 600;
                margin-bottom: 4px;
            }
            .version {
                font-size: 13px;
                color: rgba(255,255,255,0.5);
                margin-bottom: 20px;
            }
            .tagline {
                font-size: 13px;
                color: rgba(255,255,255,0.7);
                margin-bottom: 8px;
                text-align: center;
            }
            .email {
                font-size: 13px;
                color: #4B5AFF;
                text-decoration: none;
                margin-bottom: 20px;
                -webkit-app-region: no-drag;
                cursor: pointer;
            }
            .email:hover { text-decoration: underline; }
            .copyright {
                font-size: 13px;
                color: rgba(255,255,255,0.5);
            }
        </style>
    </head>
    <body>
        <img class="icon" src="data:image/png;base64,${iconBase64}" alt="Icon">
        <div class="name">Root_Operator</div>
        <div class="version">Version ${version}</div>
        <div class="tagline">Personal AI assistant for macOS<br>powered by Claude Code channels</div>
        <a class="email" href="mailto:support@rootoperator.dev">support@rootoperator.dev</a>
        <div class="copyright">© 2026 Root Operator</div>
    </body>
    </html>
    `;

        aboutWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

        aboutWindow.once('ready-to-show', () => {
            if (isUsableWindow(aboutWindow)) {
                aboutWindow.show();
            }
        });

        aboutWindow.on('closed', () => {
            setAboutWindow(null);
        });

        return aboutWindow;
    }

    return {
        getMainWindow,
        getLocalChatWindow,
        getAboutWindow,
        getViewerWindowStateByWebContentsId: () => viewerWindowStateByWebContentsId,
        createWindow,
        initializeDesktopShell,
        getDevDockIconPath,
        applyDevDockIcon,
        syncDockVisibility,
        toggleLocalChatWindow,
        createLocalChatWindow,
        normalizeViewerInitState,
        createAttachmentViewerWindow,
        getAttachmentViewerContext,
        normalizeViewerResultPayload,
        sendSyncStateToManagedWindows,
        syncStateWithRenderer,
        getTunnelState,
        getUpdateInstallGate,
        getUpdateState,
        dismissUpdateBanner,
        handleAppActivate,
        registerAppShellEvents,
        showAboutWindow,
    };
}

module.exports = { init };
