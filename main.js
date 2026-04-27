/**
 * ROOT OPERATOR - MAIN PROCESS
 */
const path = require('path');
const { spawn } = require('child_process');
const { app, BrowserWindow, ipcMain, shell, Tray, Menu, globalShortcut, nativeImage, Notification, safeStorage, screen } = require('electron');
const fs = require('fs');
const fixPath = async () => {
    const { default: fp } = await import('fix-path');
    fp();
};
const WebSocket = require('ws');
const pty = require('node-pty');
const crypto = require('crypto');
const cloudflared = require('cloudflared');
const keytar = require('keytar');
const webpush = require('web-push');
const { ChannelManager } = require('./src/channel-manager');
const { ChatStore } = require('./src/chat-store');
const { Scheduler } = require('./src/scheduler');
const { AppUpdater } = require('./src/updater');
const {
    ensureWorkspace,
    writeSystemPromptFile,
    writeProjectMcpConfig,
    ensureWorkspaceChatHistory,
    ensureAttachmentsDir,
    ensureOutboundAttachmentsDir,
    ensureCursorAttachmentsDir,
    ATTACHMENTS_DIR,
    OUTBOUND_ATTACHMENTS_DIR,
    CURSOR_ATTACHMENTS_DIR,
    WORKSPACE_DIR,
} = require('./src/workspace');
const {
    OUTBOUND_ATTACHMENT_GC_GRACE_MS,
    OUTBOUND_ATTACHMENT_SWEEP_INTERVAL_MS,
    getStagedAttachmentPath,
    loadStagedAttachmentBytes,
    stageOutboundAttachments,
    stripAttachmentBytes,
    touchAttachmentForGc,
} = require('./src/outbound-attachments');
const { DynamicMemory } = require('./src/dynamic-memory');
const { killOrphanClaudeIfAny, recordPid, clearPid } = require('./src/orphan-kill');
const { init: initLogging } = require('./src/main/logging');
const { init: initTray } = require('./src/main/tray');
const { init: initWindowManager } = require('./src/main/window-manager');
const { init: initCursorCompanion } = require('./src/main/cursor-companion');
const { init: initNotifications } = require('./src/main/notifications');
const { init: initActivityTracker } = require('./src/main/activity-tracker');
const { init: initLocalChat } = require('./src/main/local-chat');
const { init: initClaudeLifecycle } = require('./src/main/claude-lifecycle');
const { init: initIpcHandlers } = require('./src/main/ipc-handlers');
const { init: initTunnel } = require('./src/main/tunnel');
const { init: initCryptoPairing } = require('./src/main/crypto-pairing');
const { init: initWebsocketBridge } = require('./src/main/websocket-bridge');
const {
    createInitialChannelRuntime,
    init: initChannelModeModule,
} = require('./src/main/channel-mode');

let store;
let dynamicMemory = null;
const logging = initLogging({ fs, getStore: () => store });
const {
    logDebug,
    setLogFile,
} = logging;
const isDev = !app.isPackaged;

if (isDev) {
    require('dotenv').config({ path: path.join(__dirname, '.env') });
}

const KEYTAR_SERVICE = 'RootOperator';
const KEYTAR_CF_TOKEN = 'cloudflare-token';
const KEYTAR_TUNNEL_TOKEN = 'tunnel-token';
const KEYTAR_WORKER_PRIVATE_KEY = 'worker-private-key';

let mainWindow;
let localChatWindow;
let aboutWindow = null;
let tray;
let server;
let wss;
let ptyProcess;
let outputBuffer = "";
let tunnelProcess;
let wakeLock;
let activeClients = new Set();
let currentTunnelUrl = null; // Track tunnel URL for state sync
let isConnecting = false; // Track if tunnel is in the process of starting

let operatingMode = 'channel'; // 'terminal' | 'channel'
let channelManager = null;
let scheduler = null;
let updater = null;
let claudeProcess = null; // Claude Code child process
let chatStore = null; // initialized after app.whenReady()
const CHANNEL_IPC_PATH = '/tmp/root-operator-channel.sock';
const CHANNEL_STARTUP_TIMEOUT_MS = 15000;
const CHANNEL_RESTART_DELAY_MS = 2500;
const CHANNEL_ACTIVITY_IDLE_MS = 5000;
const DEFAULT_ACTIVITY_ASSISTANT_NAME = 'Operator';
let channelStartupTimer = null;
let channelRestartTimer = null;
let channelConfirmTimers = [];
let channelStartupAttempt = 0;
let isAppQuitting = false;
let currentFingerprint = null;
let currentSessionStartedAt = null;
const setMainWindow = (window) => (mainWindow = window);
const setLocalChatWindow = (window) => (localChatWindow = window);
const setAboutWindow = (window) => (aboutWindow = window);
const setPtyProcess = (value) => (ptyProcess = value);
const setOutputBuffer = (value) => (outputBuffer = value);
const setCurrentFingerprint = (value) => (currentFingerprint = value);
const setCurrentSessionStartedAt = (value) => (currentSessionStartedAt = value);
const setClaudeProcess = (value) => (claudeProcess = value);
const setChannelStartupTimer = (value) => (channelStartupTimer = value);
const setChannelRestartTimer = (value) => (channelRestartTimer = value);
const setChannelConfirmTimers = (value) => (channelConfirmTimers = value);
const setChannelStartupAttempt = (value) => (channelStartupAttempt = value);
const setOperatingModeState = (value) => (operatingMode = value);
const setChannelManagerRef = (value) => (channelManager = value);
const setSchedulerRef = (value) => (scheduler = value);
const setChannelRuntimeRef = (value) => (channelRuntime = value);
const setCurrentTunnelUrl = (value) => (currentTunnelUrl = value);
const setIsConnectingState = (value) => (isConnecting = Boolean(value));
const setServerState = (value) => (server = value);
const setWebSocketServer = (value) => (wss = value);
const setTunnelProcessState = (value) => (tunnelProcess = value);
const setWakeLock = (value) => (wakeLock = value);
const setAppQuittingState = (value) => (isAppQuitting = Boolean(value));
const trayModule = initTray({
    app,
    Tray,
    Menu,
    shell,
    globalShortcut,
    fs,
    path,
    logger: console,
    iconDirectory: __dirname,
    getMainWindow: () => mainWindow,
    getOperatingMode: () => operatingMode,
    setOperatingMode: (...args) => setOperatingMode(...args),
    showAboutWindow: (...args) => showAboutWindow(...args),
    syncStateWithRenderer: (...args) => syncStateWithRenderer(...args),
    getStoredTunnelSettings: (...args) => getStoredTunnelSettings(...args),
    startBridge: (...args) => startBridge(...args),
    stopBridge: (...args) => stopBridge(...args),
    getIsConnecting: () => isConnecting,
    getServer: () => server,
    getTunnelProcess: () => tunnelProcess,
    logDebug,
});
const {
    formatTrayTooltip,
    setTrayIconState,
    createTray,
    initDoubleShiftShortcut,
    stopDoubleShiftShortcut,
    registerGlobalShortcuts,
} = trayModule;
const windowManager = initWindowManager({
    app,
    BrowserWindow,
    Menu,
    nativeImage,
    fs,
    path,
    appDir: __dirname,
    isDev,
    getStore: () => store,
    getMainWindow: () => mainWindow,
    setMainWindow,
    getLocalChatWindow: () => localChatWindow,
    setLocalChatWindow,
    getAboutWindow: () => aboutWindow,
    setAboutWindow,
    getIsConnecting: () => isConnecting,
    getServer: () => server,
    getTunnelProcess: () => tunnelProcess,
    getTray: () => tray,
    getTrayIconSetter: () => setTrayIconState,
    getTrayTooltipFormatter: () => formatTrayTooltip,
    getActiveClients: () => activeClients,
    getCurrentTunnelUrl: () => currentTunnelUrl,
    getCurrentFingerprint: () => currentFingerprint,
    getCurrentSessionStartedAt: () => currentSessionStartedAt,
    getOperatingMode: () => operatingMode,
    getChannelStatus: () => getChannelStatus(),
    getChannelManager: () => channelManager,
    getUpdater: () => updater,
    getHasActiveChannelActivity: () => hasActiveChannelActivity(),
    getActivityAssistantName: (...args) => getActivityAssistantName(...args),
    getScheduler: () => scheduler,
    logDebug,
    webSocketOpenState: WebSocket.OPEN,
});
const {
    createLocalChatWindow,
    toggleLocalChatWindow,
    normalizeViewerInitState,
    createAttachmentViewerWindow,
    getAttachmentViewerContext,
    normalizeViewerResultPayload,
    syncStateWithRenderer,
    getTunnelState,
    getUpdateInstallGate,
    getUpdateState,
    dismissUpdateBanner,
    initializeDesktopShell,
    registerAppShellEvents,
    showAboutWindow,
    loadRendererWindow,
} = windowManager;
registerAppShellEvents();
const notifications = initNotifications({
    app,
    BrowserWindow,
    Notification,
    WebSocket,
    safeStorage,
    webpush,
    logDebug,
    getStore: () => store,
    getMainWindow: () => mainWindow,
    getLocalChatWindow: () => localChatWindow,
    createLocalChatWindow,
    getActiveClients: () => activeClients,
    desktopNotificationIconPath: path.join(__dirname, 'public', 'icon-192-v3.png'),
    defaultActivityAssistantName: DEFAULT_ACTIVITY_ASSISTANT_NAME,
});
const {
    getActivityAssistantName,
    configureWebPush,
    sendNotificationState,
    upsertPushSubscription,
    removePushSubscriptionsForKid,
    notifyAssistantReply,
    resetCachedPushVapidKeys,
} = notifications;
const cryptoPairing = initCryptoPairing({
    crypto,
    safeStorage,
    WebSocket,
    logDebug,
    getStore: () => store,
    getOperatingMode: () => operatingMode,
    getMainWindow: () => mainWindow,
    setCurrentFingerprint: (value) => {
        currentFingerprint = value;
        return currentFingerprint;
    },
    setCurrentSessionStartedAt: (value) => {
        currentSessionStartedAt = value;
        return currentSessionStartedAt;
    },
});
const {
    getDesktopIdentityKeyPair,
    clearDesktopIdentityKeyPairCache,
    toPublicPairingJwk,
    assertNoPrivatePairingJwkMaterial,
    getOrCreateDesktopIdentityKeyPair,
    ensureDesktopIdentityReady,
    closeE2EUnauthenticated,
    closeE2EUnavailable,
    initE2EKeyExchange,
    completeE2EKeyExchange,
    sendEncryptedOutput,
    decryptInput,
    isValidKeyId,
    isValidPairingJwk,
    getStoredPairedKeys,
    getAuthorizedPairedKeys,
    computeKeyIdFromJwk,
    verifySignatureWithJwk,
} = cryptoPairing;
let sendLocalChatEventRef = () => {};
const activityTracker = initActivityTracker({
    fs,
    path,
    getActivityAssistantName,
    sendEncryptedChannelPayload: (...args) => sendEncryptedChannelPayload(...args),
    sendLocalChatEvent: (...args) => sendLocalChatEventRef(...args),
    syncStateWithRenderer: (...args) => syncStateWithRenderer(...args),
    logDebug,
    channelActivityIdleMs: CHANNEL_ACTIVITY_IDLE_MS,
});
const {
    getChannelReplyPending,
    setChannelReplyPending,
    getLatestChannelActivity,
    hasActiveChannelActivity,
    clearChannelIdleTimer,
    setChannelActivity,
    resetChannelActivity,
    scheduleChannelIdle,
    startClaudeDebugWatcher,
    stopClaudeDebugWatcher,
    startClaudeHookWatcher,
    stopClaudeHookWatcher,
} = activityTracker;
const localChat = initLocalChat({
    fs,
    path,
    pty,
    ChatStore,
    ensureOutboundAttachmentsDir,
    OUTBOUND_ATTACHMENTS_DIR,
    OUTBOUND_ATTACHMENT_GC_GRACE_MS,
    OUTBOUND_ATTACHMENT_SWEEP_INTERVAL_MS,
    getStagedAttachmentPath,
    loadStagedAttachmentBytes,
    stripAttachmentBytes,
    touchAttachmentForGc,
    logDebug,
    getMainWindow: () => mainWindow,
    getTunnelState: (...args) => getTunnelState(...args),
    getLocalChatWindow: () => localChatWindow,
    getLatestChannelActivity,
    getChannelReplyPending,
    getActivityAssistantName,
    getOperatingMode: () => operatingMode,
    getChannelManager: () => channelManager,
    getDynamicMemory: () => dynamicMemory,
    setChannelReplyPending,
    setChannelActivity,
    getActiveClients: () => activeClients,
    getPtyProcess: () => ptyProcess,
    setPtyProcess,
    getOutputBuffer: () => outputBuffer,
    setOutputBuffer,
    sendEncryptedOutput: (...args) => sendEncryptedOutput(...args),
    WebSocket,
    console,
    env: process.env,
});
const {
    initializeChatStore,
    sendLocalChatEventToWindow,
    sendLocalChatEvent,
    buildAttachmentBytesResponsePayload,
    parseStructuredChannelInput,
    buildTransportChannelMessage,
    getLocalChatState,
    startPty,
    markOutboundAttachmentsForGc,
    startOutboundAttachmentSweep,
    stopOutboundAttachmentSweep,
    submitChannelUserMessage,
} = localChat;
sendLocalChatEventRef = sendLocalChatEvent;
let channelRuntime = createInitialChannelRuntime(DEFAULT_ACTIVITY_ASSISTANT_NAME);

// Cursor companion — small dot follows the cursor; Option+Option opens
// a bubble for text input; on Enter, the prompt + a screenshot of the
// cursor area are sent through the existing channel pipeline to Claude
// Code, and the response renders back in the bubble. Initialised here
// so we can pass it into channel-mode for reply forwarding; started
// later in whenReady after the desktop shell comes up.
const cursorCompanion = initCursorCompanion({
    BrowserWindow,
    ipcMain,
    screen,
    app,
    getCursorAttachmentsDir: () => ensureCursorAttachmentsDir(),
    loadRendererWindow,
    submitChannelUserMessage,
    getOperatingMode: () => operatingMode,
    logDebug,
});

function sendEncryptedChannelPayload(payload) {
    const body = JSON.stringify(payload);
    for (const client of activeClients) {
        if (client.readyState === WebSocket.OPEN) {
            sendEncryptedOutput(client, body);
        }
    }
}

const claudeLifecycle = initClaudeLifecycle({
    app,
    fs,
    path,
    pty,
    appDir: __dirname,
    channelIpcPath: CHANNEL_IPC_PATH,
    workspaceDir: WORKSPACE_DIR,
    isDev,
    process,
    ensureWorkspace,
    ensureAttachmentsDir,
    writeSystemPromptFile,
    writeProjectMcpConfig,
    getStore: () => store,
    getActivityAssistantName,
    getOperatingMode: () => operatingMode,
    getIsAppQuitting: () => isAppQuitting,
    getChannelReplyPending,
    getChannelManager: () => channelManager,
    getClaudeProcess: () => claudeProcess,
    setClaudeProcess,
    getChannelStartupTimer: () => channelStartupTimer,
    setChannelStartupTimer,
    getChannelRestartTimer: () => channelRestartTimer,
    setChannelRestartTimer,
    getChannelConfirmTimers: () => channelConfirmTimers,
    setChannelConfirmTimers,
    getChannelStartupAttempt: () => channelStartupAttempt,
    setChannelStartupAttempt,
    setChannelRuntime: (...args) => setChannelRuntime(...args),
    setChannelActivity: (...args) => setChannelActivity(...args),
    resetChannelActivity: (...args) => resetChannelActivity(...args),
    startClaudeDebugWatcher: (...args) => startClaudeDebugWatcher(...args),
    stopClaudeDebugWatcher: (...args) => stopClaudeDebugWatcher(...args),
    startClaudeHookWatcher: (...args) => startClaudeHookWatcher(...args),
    stopClaudeHookWatcher: (...args) => stopClaudeHookWatcher(...args),
    logDebug,
    recordPid,
    channelStartupTimeoutMs: CHANNEL_STARTUP_TIMEOUT_MS,
    channelRestartDelayMs: CHANNEL_RESTART_DELAY_MS,
});
const {
    clearChannelConfirmTimers,
    clearChannelStartupTimer,
    clearChannelRestartTimer,
    prepareStartupEnvironment,
    spawnClaudeCode,
    killClaudeCode,
} = claudeLifecycle;

const channelMode = initChannelModeModule({
    crypto,
    fs,
    ChannelManager,
    Scheduler,
    channelIpcPath: CHANNEL_IPC_PATH,
    defaultActivityAssistantName: DEFAULT_ACTIVITY_ASSISTANT_NAME,
    WebSocket,
    getStore: () => store,
    getClaudeProcess: () => claudeProcess,
    getIsAppQuitting: () => isAppQuitting,
    getChannelReplyPending,
    getLatestChannelActivity,
    getDynamicMemory: () => dynamicMemory,
    getChatStore: () => chatStore,
    getActiveClients: () => activeClients,
    getPtyProcess: () => ptyProcess,
    setPtyProcess,
    setOutputBuffer,
    getMainWindow: () => mainWindow,
    getTunnelState: (...args) => getTunnelState(...args),
    logDebug,
    getActivityAssistantName,
    syncStateWithRenderer: (...args) => syncStateWithRenderer(...args),
    setChannelActivity: (...args) => setChannelActivity(...args),
    resetChannelActivity: (...args) => resetChannelActivity(...args),
    scheduleChannelIdle: (...args) => scheduleChannelIdle(...args),
    clearChannelRestartTimer,
    clearChannelStartupTimer,
    clearChannelConfirmTimers,
    clearChannelIdleTimer,
    stopClaudeDebugWatcher: (...args) => stopClaudeDebugWatcher(...args),
    stopClaudeHookWatcher: (...args) => stopClaudeHookWatcher(...args),
    clearPid,
    spawnClaudeCode,
    killClaudeCode,
    killOrphanClaudeIfAny,
    startPty: (...args) => startPty(...args),
    stageOutboundAttachments,
    stripAttachmentBytes,
    markOutboundAttachmentsForGc,
    buildTransportChannelMessage,
    sendEncryptedOutput: (...args) => sendEncryptedOutput(...args),
    sendLocalChatEvent,
    notifyAssistantReply,
    forwardToCursorCompanion: (payload) => cursorCompanion.handleChannelReply(payload),
    outboundAttachmentsDir: OUTBOUND_ATTACHMENTS_DIR,
    initialOperatingMode: operatingMode,
    getOperatingMode: () => operatingMode,
    setOperatingModeState,
    getChannelManager: () => channelManager,
    setChannelManager: setChannelManagerRef,
    getScheduler: () => scheduler,
    setScheduler: setSchedulerRef,
    getChannelRuntime: () => channelRuntime,
    setChannelRuntimeState: setChannelRuntimeRef,
    getChannelStartupAttempt: () => channelStartupAttempt,
    setChannelStartupAttempt,
});
const {
    setChannelRuntime,
    getChannelStatus,
    initChannelMode,
    teardownChannelMode,
    setOperatingMode,
} = channelMode;
// Remote app control — invoked from the paired-device security panel so the
// user can recover from a stale session without physical access to the Mac.
// Production: app.relaunch() schedules a fresh packaged-app instance, then
// app.quit() ends the current one (500ms grace lets the WS ack flush).
// Dev: app.relaunch() can't bring back the npm/concurrently/vite tree, so
// we hand off to a detached worker script that kills the dev tree and
// spawns a fresh `npm run dev:app` with RO_AUTO_START_TUNNEL=1.
function spawnDevRestartWorker() {
    const scriptPath = path.join(__dirname, 'scripts', 'dev-restart.sh');
    const child = spawn('/bin/bash', [scriptPath], {
        detached: true,
        stdio: 'ignore',
        cwd: __dirname,
        env: {
            ...process.env,
            RO_DEV_REPO_DIR: __dirname,
        },
    });
    child.unref();
}

function requestAppRestart() {
    if (isDev) {
        logDebug('[APP] Remote restart in dev mode — spawning detached worker');
        try {
            spawnDevRestartWorker();
        } catch (error) {
            logDebug(`[APP] dev restart worker spawn failed: ${error && error.message}`);
        }
        return;
    }
    logDebug('[APP] Remote restart queued (production)');
    // Persist the intent so the relaunched app auto-starts the tunnel.
    // Without this, app.relaunch() brings back the tray but tunnel + Claude
    // stay idle, defeating remote recovery. Object form carries TTL +
    // attempt cap; cleared on successful tunnel-up in whenReady.
    try {
        if (store) {
            const TEN_MIN_MS = 10 * 60 * 1000;
            store.set('pendingTunnelAutoStart', {
                requestedAt: Date.now(),
                expiresAt: Date.now() + TEN_MIN_MS,
                attempts: 0,
            });
        }
    } catch (error) {
        logDebug(`[APP] persist auto-start intent failed: ${error && error.message}`);
    }
    try {
        app.relaunch();
    } catch (error) {
        logDebug(`[APP] relaunch() failed: ${error && error.message}`);
    }
    setTimeout(() => {
        try {
            app.quit();
        } catch (error) {
            logDebug(`[APP] quit() failed during restart: ${error && error.message}`);
        }
    }, 500);
}

function requestAppExit() {
    logDebug('[APP] Remote exit queued');
    setTimeout(() => {
        try {
            app.quit();
        } catch (error) {
            logDebug(`[APP] quit() failed during exit: ${error && error.message}`);
        }
    }, 500);
}

const websocketBridge = initWebsocketBridge({
    fs,
    path,
    crypto,
    WebSocket,
    logDebug,
    getStore: () => store,
    getOperatingMode: () => operatingMode,
    setOperatingMode,
    getPtyProcess: () => ptyProcess,
    getStoredPairedKeys,
    getAuthorizedPairedKeys,
    getActiveClients: () => activeClients,
    startPty: (...args) => startPty(...args),
    ensureAttachmentsDir,
    submitChannelUserMessage,
    parseStructuredChannelInput,
    buildAttachmentBytesResponsePayload,
    sendNotificationState,
    upsertPushSubscription,
    removePushSubscriptionsForKid,
    toPublicPairingJwk,
    assertNoPrivatePairingJwkMaterial,
    getDesktopIdentityKeyPair,
    closeE2EUnavailable,
    closeE2EUnauthenticated,
    initE2EKeyExchange,
    completeE2EKeyExchange,
    sendEncryptedOutput,
    decryptInput,
    isValidKeyId,
    isValidPairingJwk,
    computeKeyIdFromJwk,
    verifySignatureWithJwk,
    attachmentsDir: ATTACHMENTS_DIR,
    requestAppRestart,
    requestAppExit,
});
const {
    handleConnection: websocketHandleConnection,
    getPendingPairings: getWebsocketPendingPairings,
    settlePendingPairingApproval: settleWebsocketPendingPairingApproval,
    revokeClientConnection: revokeWebsocketClientConnection,
    resetState: resetWebsocketBridgeState,
    getLimits: getWebsocketBridgeLimits,
} = websocketBridge;
const tunnel = initTunnel({
    fs,
    path,
    crypto,
    keytar,
    cloudflared,
    WebSocket,
    appDir: __dirname,
    isDev,
    keytarService: KEYTAR_SERVICE,
    keytarCfToken: KEYTAR_CF_TOKEN,
    keytarTunnelToken: KEYTAR_TUNNEL_TOKEN,
    keytarWorkerPrivateKey: KEYTAR_WORKER_PRIVATE_KEY,
    getStore: () => store,
    getMainWindow: () => mainWindow,
    syncStateWithRenderer,
    getOperatingMode: () => operatingMode,
    initChannelMode,
    teardownChannelMode,
    handleConnection: websocketHandleConnection,
    getCurrentTunnelUrl: () => currentTunnelUrl,
    setCurrentTunnelUrl,
    getIsConnecting: () => isConnecting,
    setIsConnecting: setIsConnectingState,
    getServer: () => server,
    setServer: setServerState,
    getWebSocketServer: () => wss,
    setWebSocketServer,
    getTunnelProcess: () => tunnelProcess,
    setTunnelProcess: setTunnelProcessState,
    getWakeLock: () => wakeLock,
    setWakeLock,
    getPtyProcess: () => ptyProcess,
    setPtyProcess,
    setOutputBuffer,
    clearActiveClients: () => activeClients.clear(),
    clearPendingPairings: () => resetWebsocketBridgeState(),
    setCurrentFingerprint,
    setCurrentSessionStartedAt,
    logDebug,
});
const {
    getMachineId,
    customizeSubdomain,
    getStoredTunnelSettings,
    startBridge,
    stopBridge,
} = tunnel;

app.whenReady().then(async () => {
    console.log('App Ready');
    const { default: ES } = await import('electron-store');
    store = new ES();
    ensureDesktopIdentityReady();
    configureWebPush();
    setLogFile(path.join(app.getPath('userData'), 'pocket_bridge_debug.log'));
    updater = new AppUpdater({
        packaged: app.isPackaged,
        logger: {
            info: logDebug,
            warn: logDebug,
            error: logDebug,
        },
        canInstallNow: getUpdateInstallGate,
    });
    updater.on('state', () => {
        syncStateWithRenderer();
    });

    await prepareStartupEnvironment(fixPath);

    const { chatHistoryPath } = ensureWorkspaceChatHistory();
    chatStore = initializeChatStore(chatHistoryPath);
    startOutboundAttachmentSweep();

    try {
        dynamicMemory = new DynamicMemory(WORKSPACE_DIR, process.resourcesPath);
        dynamicMemory.setLogger(logDebug);
        await dynamicMemory.init(store);
        // Only warm the embedder eagerly when indexing is ON. With the toggle
        // OFF the user has opted into "quiet mode" — no background CPU, no
        // ~300MB model in RAM. The first tool call pays the one-time cold
        // load; subsequent calls are fast.
        if (dynamicMemory.isIndexingEnabled()) {
            dynamicMemory.warmup();
        }
    } catch (error) {
        logDebug(`[MEMORY] Failed to initialize: ${error.message}`);
        dynamicMemory = null;
    }

    initializeDesktopShell({
        createTray,
        registerGlobalShortcuts,
        initDoubleShiftShortcut,
        toggleLocalChatWindow,
        setTray: (value) => { tray = value; },
    });
    updater.start();

    // Start the cursor companion after the desktop shell is up: dot
    // window + cursor poll, then attach the Option+Option listener to
    // the same uIOhook instance the tray's double-Shift shortcut starts.
    // Order matters — initDoubleShiftShortcut (called inside
    // initializeDesktopShell) is what spins up uIOhook; attaching the
    // Option listener after that ensures we're hooking the running
    // singleton, not creating a competing one.
    try {
        cursorCompanion.start();
        cursorCompanion.attachOptionListener();
    } catch (error) {
        logDebug(`[CURSOR] Companion failed to start: ${error.message}`);
    }

    // Auto-start priority gate. Three paths can fire on launch; only the
    // highest-priority one runs, the others are suppressed:
    //   1. RO_AUTO_START_TUNNEL=1 env var  (dev/launchd restart hook)
    //   2. pendingTunnelAutoStart flag     (production lock-popup Restart)
    //   3. autoStartTunnelOnLaunch setting (cold-launch default-ON)
    let autoStartTriggered = false;

    // (1) RO_AUTO_START_TUNNEL=1 — explicit script signal from dev-restart.sh
    // or a launchd hook. Highest priority; bypasses crash-loop protection
    // because the script is asserting "I just started you, bring the tunnel
    // up" and any failure surfaces in the script's own logs.
    if (process.env.RO_AUTO_START_TUNNEL === '1') {
        autoStartTriggered = true;
        setTimeout(async () => {
            try {
                const cfSettings = await getStoredTunnelSettings();
                await startBridge(cfSettings);
                logDebug('[AUTO-START] Tunnel started via RO_AUTO_START_TUNNEL');
            } catch (error) {
                logDebug(`[AUTO-START] Tunnel failed to start: ${error.message}`);
            }
        }, 2000);
    }

    // (2) pendingTunnelAutoStart — recovery from a remote Restart triggered
    // via the lock popup. The previous session persisted the flag before
    // `app.relaunch()`; here we honor it so the tunnel comes back up and
    // Claude re-spawns through the channel-bridge cascade. TTL + attempt cap
    // protect against surprise auto-starts after long delays or repeated
    // boot failures.
    if (!autoStartTriggered) {
        try {
            const pending = store.get('pendingTunnelAutoStart', null);
            if (pending && typeof pending === 'object') {
                const now = Date.now();
                const expired = pending.expiresAt && now > pending.expiresAt;
                const attempts = Number.isFinite(pending.attempts) ? pending.attempts : 0;
                const tooManyAttempts = attempts >= 3;
                if (expired || tooManyAttempts) {
                    store.delete('pendingTunnelAutoStart');
                    // The attempt cap exists to stop a relaunch→fail loop. If we
                    // discard for tooManyAttempts, the cold-launch path must NOT
                    // step in and start the tunnel anyway — that would defeat
                    // the cap. Expired-but-not-capped is benign; suppressing
                    // cold-launch in that case is conservative but consistent.
                    autoStartTriggered = true;
                    logDebug(`[AUTO-START] discarded stale pendingTunnelAutoStart (expired=${!!expired}, attempts=${attempts}); cold-launch suppressed for this boot`);
                } else {
                    autoStartTriggered = true;
                    // Bump attempts up-front so a crash inside startBridge doesn't
                    // produce an unbounded relaunch→fail loop on next boot.
                    store.set('pendingTunnelAutoStart', { ...pending, attempts: attempts + 1 });

                    setTimeout(async () => {
                        // Race: user hit Cmd+Shift+J or tray Start while we waited.
                        // Treat that as already-satisfied and clear the flag.
                        if (isConnecting || server || tunnelProcess) {
                            try { store.delete('pendingTunnelAutoStart'); } catch (_) {}
                            logDebug('[AUTO-START] tunnel already running, clearing pending flag');
                            return;
                        }
                        try {
                            const cfSettings = await getStoredTunnelSettings();
                            await startBridge(cfSettings);
                            try { store.delete('pendingTunnelAutoStart'); } catch (_) {}
                            logDebug('[AUTO-START] Tunnel started after remote restart');
                        } catch (error) {
                            // Mirror the IPC START handler: clean up partial state
                            // so the next attempt starts from a known-good zero.
                            try { stopBridge(); } catch (_) {}
                            logDebug(`[AUTO-START] post-restart tunnel failed: ${error.message}`);
                        }
                    }, 2000);
                }
            }
        } catch (error) {
            logDebug(`[AUTO-START] pendingTunnelAutoStart check failed: ${error.message}`);
        }
    }

    // (3) Cold-launch auto-start — default-ON setting that brings the tunnel
    // up on plain `open the app` launches. Suppressed if either higher-
    // priority path fired, if the user toggled it off, or if we detect a
    // quick-exit crash loop. Also tracks lastLaunchAt so the next boot can
    // detect a quick exit.
    if (!autoStartTriggered) {
        try {
            const QUICK_EXIT_MS = 30_000;
            const QUICK_EXIT_THRESHOLD = 3;

            const enabled = store.get('autoStartTunnelOnLaunch', true);
            const lastLaunchAt = Number(store.get('lastLaunchAt', 0)) || 0;
            const previousQuickExitCount = Number(store.get('quickExitCount', 0)) || 0;

            const now = Date.now();
            const previousLaunchWasQuickExit = lastLaunchAt && (now - lastLaunchAt < QUICK_EXIT_MS);
            const quickExitCount = previousLaunchWasQuickExit ? previousQuickExitCount + 1 : 0;

            store.set('lastLaunchAt', now);
            store.set('quickExitCount', quickExitCount);

            // After 30s of stable running, declare this session healthy and
            // reset the counter so a single legitimate quick-exit doesn't
            // permanently disable auto-start.
            setTimeout(() => {
                try { store.set('quickExitCount', 0); } catch (_) {}
            }, QUICK_EXIT_MS);

            const inCrashLoop = quickExitCount >= QUICK_EXIT_THRESHOLD;

            if (!enabled) {
                logDebug('[AUTO-START] cold-launch skipped: autoStartTunnelOnLaunch=false');
            } else if (inCrashLoop) {
                logDebug(`[AUTO-START] cold-launch skipped: ${quickExitCount} quick exits in a row — counter resets after 30s of stable runtime`);
            } else {
                autoStartTriggered = true;
                setTimeout(async () => {
                    if (isConnecting || server || tunnelProcess) {
                        logDebug('[AUTO-START] cold-launch suppressed: tunnel already running');
                        return;
                    }
                    try {
                        const cfSettings = await getStoredTunnelSettings();
                        await startBridge(cfSettings);
                        logDebug('[AUTO-START] Tunnel started on cold launch');
                    } catch (error) {
                        try { stopBridge(); } catch (_) {}
                        logDebug(`[AUTO-START] cold-launch tunnel failed: ${error.message}`);
                    }
                }, 2000);
            }
        } catch (error) {
            logDebug(`[AUTO-START] cold-launch check failed: ${error.message}`);
        }
    }
});

app.on('will-quit', () => {
    resetCachedPushVapidKeys();
    globalShortcut.unregisterAll();
    stopDoubleShiftShortcut();
    stopOutboundAttachmentSweep();
    try { cursorCompanion.stop(); } catch (_) { /* ignore */ }
    clearPid();
    clearDesktopIdentityKeyPairCache();
    currentFingerprint = null;
    currentSessionStartedAt = null;
});

// 4. CONNECTION HANDLER (The Auth Logic)
const websocketBridgeLimits = getWebsocketBridgeLimits();
initIpcHandlers({
    ipcMain,
    BrowserWindow,
    app,
    fs,
    path,
    keytar,
    crypto,
    getStore: () => store,
    getUpdater: () => updater,
    syncStateWithRenderer,
    startBridge,
    stopBridge,
    getTunnelState,
    getUpdateState,
    createLocalChatWindow,
    getLocalChatState,
    normalizeViewerInitState,
    createAttachmentViewerWindow,
    getAttachmentViewerContext,
    normalizeViewerResultPayload,
    buildAttachmentBytesResponsePayload,
    submitChannelUserMessage,
    ensureAttachmentsDir,
    attachmentsDir: ATTACHMENTS_DIR,
    maxFileSize: websocketBridgeLimits.maxFileSize,
    blockedFileExtensions: websocketBridgeLimits.blockedFileExtensions,
    sendLocalChatEventToWindow,
    getLocalChatWindow: () => localChatWindow,
    getMainWindow: () => mainWindow,
    dismissUpdateBanner,
    getDynamicMemory: () => dynamicMemory,
    setOperatingMode,
    getOperatingMode: () => operatingMode,
    setAppQuitting: setAppQuittingState,
    setTrayIconState,
    keytarService: KEYTAR_SERVICE,
    keytarCfToken: KEYTAR_CF_TOKEN,
    getTunnelProcess: () => tunnelProcess,
    getServer: () => server,
    customizeSubdomain,
    getMachineId,
    getPendingPairings: getWebsocketPendingPairings,
    pairingCodeExpiryMs: websocketBridgeLimits.pairingCodeExpiryMs,
    challengeExpiryMs: websocketBridgeLimits.challengeExpiryMs,
    webSocketOpenState: WebSocket.OPEN,
    toPublicPairingJwk,
    settlePendingPairingApproval: settleWebsocketPendingPairingApproval,
    removePushSubscriptionsForKid,
    getActiveClients: () => activeClients,
    revokeClientConnection: revokeWebsocketClientConnection,
    logDebug,
});

app.on('before-quit', () => {
    setAppQuittingState(true);
    if (updater) {
        updater.stop();
    }
    stopBridge();
    if (dynamicMemory) {
        try { dynamicMemory.close(); } catch (err) { /* ignore */ }
    }
});
