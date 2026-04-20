/**
 * ROOT OPERATOR - MAIN PROCESS
 */
const path = require('path');
const { app, BrowserWindow, ipcMain, shell, Tray, Menu, globalShortcut, nativeImage, Notification, safeStorage } = require('electron');
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
    ATTACHMENTS_DIR,
    OUTBOUND_ATTACHMENTS_DIR,
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
        // Non-blocking embedder warmup: on Intel Macs the cold load can eat
        // the entire enrichment timeout budget, so first-turn enrichment
        // would silently miss. Running it in the background during app init
        // makes the first real user turn hit a hot embedder.
        dynamicMemory.warmup();
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
});

app.on('will-quit', () => {
    resetCachedPushVapidKeys();
    globalShortcut.unregisterAll();
    stopDoubleShiftShortcut();
    stopOutboundAttachmentSweep();
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
