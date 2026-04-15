/**
 * ROOT OPERATOR - MAIN PROCESS
 */
const path = require('path');
const { app, BrowserWindow, ipcMain, shell, Tray, Menu, globalShortcut, nativeImage, Notification, safeStorage } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const fixPath = async () => {
    const { default: fp } = await import('fix-path');
    fp();
};
const WebSocket = require('ws');
const pty = require('node-pty');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const cloudflared = require('cloudflared');
const keytar = require('keytar');
const webpush = require('web-push');
const { ChannelManager } = require('./src/channel-manager');
const { ChatStore } = require('./src/chat-store');
const { Scheduler } = require('./src/scheduler');
const { AppUpdater, defaultUpdateState } = require('./src/updater');
const { ensureWorkspace, writeSystemPromptFile, writeProjectMcpConfig, ensureWorkspaceChatHistory, ensureAttachmentsDir, ATTACHMENTS_DIR, WORKSPACE_DIR } = require('./src/workspace');
const { DynamicMemory } = require('./src/dynamic-memory');
const {
    DispatchStore: SupervisorDispatchStore,
    Runtime: SupervisorRuntime,
    IncidentLogger: SupervisorIncidentLogger,
    createSupervisor,
} = require('./src/claude-session-supervisor');

let store;
let dynamicMemory = null;
let supervisor = null;
let supervisorStore = null;
const isDev = !app.isPackaged;

if (isDev) {
    require('dotenv').config({ path: path.join(__dirname, '.env') });
}

function loadRuntimeConfig() {
    const configPath = path.join(__dirname, 'runtime-config.json');

    try {
        if (!fs.existsSync(configPath)) {
            return {};
        }

        const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
        console.warn(`[CONFIG] Failed to load runtime-config.json: ${error.message}`);
        return {};
    }
}

const runtimeConfig = loadRuntimeConfig();

// Fix cloudflared binary path for packaged app (binary is in app.asar.unpacked)
if (!isDev) {
    const unpackedBin = path.join(
        __dirname.replace('app.asar', 'app.asar.unpacked'),
        'node_modules', 'cloudflared', 'bin', 'cloudflared'
    );
    cloudflared.use(unpackedBin);
}

// Server configuration (can be overridden via environment variables)
const INTERNAL_PORT = parseInt(process.env.INTERNAL_PORT || runtimeConfig.INTERNAL_PORT, 10) || 22000;
const VITE_CLIENT_PORT = parseInt(process.env.VITE_CLIENT_PORT || runtimeConfig.VITE_CLIENT_PORT, 10) || 5175;
const VITE_RENDERER_PORT = parseInt(process.env.VITE_RENDERER_PORT || runtimeConfig.VITE_RENDERER_PORT, 10) || 5174;

// Secure credential storage constants
const KEYTAR_SERVICE = 'RootOperator';
const KEYTAR_CF_TOKEN = 'cloudflare-token';
const KEYTAR_TUNNEL_TOKEN = 'tunnel-token';
const KEYTAR_WORKER_PRIVATE_KEY = 'worker-private-key';
const DESKTOP_IDENTITY_PRIVATE_JWK_STORE_KEY = 'desktopIdentityPrivateJwk';
const DESKTOP_IDENTITY_PUBLIC_JWK_STORE_KEY = 'desktopIdentityPublicJwk';
const DESKTOP_IDENTITY_KEY_STORE_KEY = 'desktopIdentityKey';

// Worker API configuration (loaded from .env file)
const WORKER_BASE_URL = process.env.WORKER_BASE_URL || runtimeConfig.WORKER_BASE_URL || '';
const WORKER_DOMAIN = process.env.WORKER_DOMAIN || runtimeConfig.WORKER_DOMAIN || '';
const UPDATE_BANNER_DISMISSED_VERSION_KEY = 'updateBannerDismissedVersion';
const DOUBLE_SHIFT_WINDOW_MS = 300;

if (!WORKER_BASE_URL || !WORKER_DOMAIN) {
    console.warn('[CONFIG] WORKER_BASE_URL or WORKER_DOMAIN is missing. Tunnel provisioning features will be unavailable.');
}

// GLOBAL STATE
let mainWindow;
let localChatWindow;
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

// Channel mode state
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
const PUSH_SUBSCRIPTIONS_STORE_KEY = 'pushSubscriptions';
const PUSH_VAPID_KEYS_STORE_KEY = 'pushVapidKeys';
const PUSH_NOTIFICATION_TARGET_URL = '/';
const PUSH_NOTIFICATION_SUBJECT = 'https://github.com/hjertefolger/Root_Operator';
let cachedPushVapidKeys = undefined;
let cachedDesktopIdentityKeyPair = undefined;
let channelStartupTimer = null;
let channelRestartTimer = null;
let channelConfirmTimers = [];
let channelStartupAttempt = 0;
let isAppQuitting = false;
let channelReplyPending = false;
let latestChannelActivity = null;
let lastChannelActivityKey = '';
let lastChannelActivityAt = 0;
let claudeDebugFilePath = '';
let claudeDebugPollTimer = null;
let claudeDebugReadOffset = 0;
let claudeDebugLineBuffer = '';
let claudeHookFilePath = '';
let claudeHookPollTimer = null;
let claudeHookReadOffset = 0;
let shortcutHook = null;
let shiftKeyCodes = [];
let shiftShortcutStarted = false;
let lastShiftKeyUpCode = null;
let lastShiftKeyUpTime = 0;
let hadOtherKeyBetweenShiftTaps = false;
let shiftToggleCallback = null;

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
        && now - lastShiftKeyUpTime <= DOUBLE_SHIFT_WINDOW_MS
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
let claudeHookLineBuffer = '';
let channelIdleTimer = null;
let channelRuntime = {
    phase: 'stopped',
    level: 'red',
    label: 'Chat offline',
    detail: `${DEFAULT_ACTIVITY_ASSISTANT_NAME} is not running.`,
    attempt: 0,
    claudeRunning: false,
    bridgeConnected: false,
    lastError: '',
};

// Pairing system state
let pendingPairings = new Map(); // code -> {ws, kid, jwk, createdAt, sourceKey}
const PAIRING_CODE_EXPIRY_MS = 120000; // 2 minutes
const MAX_PENDING_PAIRINGS = 5;
const MAX_PENDING_PAIRINGS_PER_SOURCE = 2;
const PAIRING_CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // No ambiguous chars

// ANSI ESCAPE SEQUENCE SANITIZER
// Blocks dangerous sequences while preserving normal terminal functionality
// Reference: https://www.cyberark.com/resources/threat-research-blog/dont-trust-this-title-abusing-terminal-emulators-with-ansi-escape-characters
function sanitizeTerminalOutput(data) {
    // OSC (Operating System Command) sequences: ESC ] ... (ST or BEL)
    // ST = ESC \ or 0x9C, BEL = 0x07
    // Dangerous: OSC 52 (clipboard), OSC 0/1/2 (title - can be used for phishing)

    // Pattern matches OSC sequences: ESC ] <number> ; <content> (BEL or ESC \)
    const oscPattern = /\x1b\](\d+);[^\x07\x1b]*(?:\x07|\x1b\\)/g;

    // DCS (Device Control String): ESC P ... ST - can execute commands on some terminals
    const dcsPattern = /\x1bP[^\x1b]*\x1b\\/g;

    // APC (Application Program Command): ESC _ ... ST
    const apcPattern = /\x1b_[^\x1b]*\x1b\\/g;

    // PM (Privacy Message): ESC ^ ... ST
    const pmPattern = /\x1b\^[^\x1b]*\x1b\\/g;

    // SOS (Start of String): ESC X ... ST
    const sosPattern = /\x1bX[^\x1b]*\x1b\\/g;

    let sanitized = data;

    // Filter OSC sequences - allow only safe ones (color palette: 4, 10, 11, 12, 104, 110, 111, 112)
    sanitized = sanitized.replace(oscPattern, (match, oscNum) => {
        const num = parseInt(oscNum, 10);
        // Safe OSC codes for color configuration
        const safeOsc = [4, 10, 11, 12, 104, 110, 111, 112, 17, 19];
        if (safeOsc.includes(num)) {
            return match; // Allow color-related OSC
        }
        logDebug(`[SECURITY] Blocked OSC ${num} sequence`);
        return ''; // Block title changes (0,1,2), clipboard (52), and others
    });

    // Block all DCS sequences (rarely needed, high risk)
    sanitized = sanitized.replace(dcsPattern, (match) => {
        logDebug('[SECURITY] Blocked DCS sequence');
        return '';
    });

    // Block APC sequences
    sanitized = sanitized.replace(apcPattern, (match) => {
        logDebug('[SECURITY] Blocked APC sequence');
        return '';
    });

    // Block PM sequences
    sanitized = sanitized.replace(pmPattern, (match) => {
        logDebug('[SECURITY] Blocked PM sequence');
        return '';
    });

    // Block SOS sequences
    sanitized = sanitized.replace(sosPattern, (match) => {
        logDebug('[SECURITY] Blocked SOS sequence');
        return '';
    });

    return sanitized;
}

// E2E ENCRYPTION MODULE
// Provides zero-knowledge encryption using authenticated ECDH + AES-256-GCM

// Global state for current session fingerprint (shown in tray)
let currentFingerprint = null;
let currentSessionStartedAt = null;
let desktopIdentityKeyPair = null;
const PAIRING_JWK_PRIVATE_FIELDS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth'];
const loggedInvalidStoredPairingKids = new Set();

const E2E_INFO = Buffer.from('root-operator-e2e-v2');

function canonicalizeJwk(jwk) {
    return JSON.stringify(jwk);
}

function canonicalizeJwkBuffer(jwk) {
    return Buffer.from(canonicalizeJwk(jwk), 'utf8');
}

function buildE2ETranscript(clientEcdhPubJwk, serverEcdhPubJwk) {
    return Buffer.concat([
        canonicalizeJwkBuffer(clientEcdhPubJwk),
        canonicalizeJwkBuffer(serverEcdhPubJwk),
    ]);
}

function deriveE2ETranscriptSalt(clientEcdhPubJwk, serverEcdhPubJwk) {
    return crypto.createHash('sha256').update(
        buildE2ETranscript(clientEcdhPubJwk, serverEcdhPubJwk)
    ).digest();
}

function isValidRsaPssJwk(jwk) {
    return Boolean(
        jwk
        && typeof jwk === 'object'
        && jwk.kty === 'RSA'
        && typeof jwk.n === 'string'
        && jwk.n
        && typeof jwk.e === 'string'
        && jwk.e
    );
}

function isValidRsaPrivateJwk(jwk) {
    return Boolean(
        isValidRsaPssJwk(jwk)
        && typeof jwk.d === 'string'
        && jwk.d
    );
}

function hasForbiddenPairingJwkFields(jwk) {
    if (!jwk || typeof jwk !== 'object') {
        return false;
    }

    return PAIRING_JWK_PRIVATE_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(jwk, field));
}

function toPublicPairingJwk(jwk) {
    if (!isValidRsaPssJwk(jwk)) {
        return null;
    }

    return {
        kty: jwk.kty,
        n: jwk.n,
        e: jwk.e,
    };
}

function assertNoPrivatePairingJwkMaterial(jwk) {
    if (hasForbiddenPairingJwkFields(jwk)) {
        throw new Error('refuse to store private JWK material');
    }
}

function isEncryptedDesktopIdentityKeyRecord(value) {
    return (
        value
        && isValidRsaPssJwk(value.publicJwk)
        && typeof value.privateJwkEncrypted === 'string'
        && value.privateJwkEncrypted
        && !Object.prototype.hasOwnProperty.call(value, 'privateJwk')
    );
}

function storeEncryptedDesktopIdentityKeyPair(keyPair) {
    const storedKeyPair = {
        publicJwk: keyPair.publicKeyJwk,
        privateJwkEncrypted: safeStorage.encryptString(JSON.stringify(keyPair.privateKeyJwk)).toString('base64'),
    };

    store.set(DESKTOP_IDENTITY_KEY_STORE_KEY, storedKeyPair);

    const verified = store.get(DESKTOP_IDENTITY_KEY_STORE_KEY, null);
    if (
        !isEncryptedDesktopIdentityKeyRecord(verified)
        || canonicalizeJwk(verified.publicJwk) !== canonicalizeJwk(storedKeyPair.publicJwk)
        || verified.privateJwkEncrypted !== storedKeyPair.privateJwkEncrypted
    ) {
        throw new Error('Failed to verify stored desktop identity key record');
    }

    return storedKeyPair;
}

function decryptStoredDesktopIdentityKeyPair(storedKeyPair) {
    const privateKeyJwk = JSON.parse(
        safeStorage.decryptString(Buffer.from(storedKeyPair.privateJwkEncrypted, 'base64'))
    );

    if (!isValidRsaPssJwk(storedKeyPair.publicJwk) || !isValidRsaPrivateJwk(privateKeyJwk)) {
        throw new Error('Invalid desktop identity key material');
    }

    return {
        publicKeyJwk: storedKeyPair.publicJwk,
        privateKeyJwk,
    };
}

function isValidEcdhPublicJwk(jwk) {
    return Boolean(
        jwk
        && typeof jwk === 'object'
        && jwk.kty === 'EC'
        && jwk.crv === 'P-256'
        && typeof jwk.x === 'string'
        && jwk.x
        && typeof jwk.y === 'string'
        && jwk.y
        && typeof jwk.d !== 'string'
    );
}

function generateDesktopIdentityKeyPair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicExponent: 0x10001,
    });

    return {
        publicKeyJwk: publicKey.export({ format: 'jwk' }),
        privateKeyJwk: privateKey.export({ format: 'jwk' }),
    };
}

function getOrCreateDesktopIdentityKeyPair() {
    if (cachedDesktopIdentityKeyPair !== undefined) {
        return cachedDesktopIdentityKeyPair;
    }

    if (!safeStorage.isEncryptionAvailable()) {
        logDebug('[SECURITY] safeStorage unavailable, desktop identity cannot be secured. E2E disabled.');
        cachedDesktopIdentityKeyPair = null;
        return null;
    }

    const encryptedRecord = store.get(DESKTOP_IDENTITY_KEY_STORE_KEY, null);
    if (isEncryptedDesktopIdentityKeyRecord(encryptedRecord)) {
        try {
            cachedDesktopIdentityKeyPair = decryptStoredDesktopIdentityKeyPair(encryptedRecord);
            return cachedDesktopIdentityKeyPair;
        } catch (error) {
            logDebug('[SECURITY] Failed to decrypt desktop identity private key — regenerating');
            const regeneratedKeyPair = generateDesktopIdentityKeyPair();
            storeEncryptedDesktopIdentityKeyPair(regeneratedKeyPair);
            cachedDesktopIdentityKeyPair = regeneratedKeyPair;
            return cachedDesktopIdentityKeyPair;
        }
    }

    const storedPublicJwk = store.get(DESKTOP_IDENTITY_PUBLIC_JWK_STORE_KEY);
    const storedPrivateJwk = store.get(DESKTOP_IDENTITY_PRIVATE_JWK_STORE_KEY);

    if (isValidRsaPssJwk(storedPublicJwk) && isValidRsaPrivateJwk(storedPrivateJwk)) {
        const migratedKeyPair = {
            publicKeyJwk: storedPublicJwk,
            privateKeyJwk: storedPrivateJwk,
        };

        storeEncryptedDesktopIdentityKeyPair(migratedKeyPair);
        store.delete(DESKTOP_IDENTITY_PRIVATE_JWK_STORE_KEY);
        store.delete(DESKTOP_IDENTITY_PUBLIC_JWK_STORE_KEY);

        const verifiedRecord = store.get(DESKTOP_IDENTITY_KEY_STORE_KEY, null);
        const verifiedKeyPair = decryptStoredDesktopIdentityKeyPair(verifiedRecord);
        if (
            !isEncryptedDesktopIdentityKeyRecord(verifiedRecord)
            || canonicalizeJwk(verifiedKeyPair.publicKeyJwk) !== canonicalizeJwk(migratedKeyPair.publicKeyJwk)
            || canonicalizeJwk(verifiedKeyPair.privateKeyJwk) !== canonicalizeJwk(migratedKeyPair.privateKeyJwk)
        ) {
            throw new Error('Failed to verify migrated desktop identity key record');
        }

        logDebug('[SECURITY] Migrated desktop identity private key to safeStorage');
        cachedDesktopIdentityKeyPair = migratedKeyPair;
        return cachedDesktopIdentityKeyPair;
    }

    logDebug('[E2E] Generating desktop identity keypair');
    const keyPair = generateDesktopIdentityKeyPair();
    storeEncryptedDesktopIdentityKeyPair(keyPair);
    cachedDesktopIdentityKeyPair = keyPair;
    return cachedDesktopIdentityKeyPair;
}

function signRsaPssPayload(privateJwk, payload) {
    const privateKey = crypto.createPrivateKey({ key: privateJwk, format: 'jwk' });
    const signature = crypto.sign(
        'sha256',
        payload,
        {
            key: privateKey,
            padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
            saltLength: 32,
        }
    );

    return signature.toString('base64');
}

function closeE2EUnauthenticated(ws, reason) {
    logDebug(`[E2E] ${reason}`);

    if (ws.e2eTimeout) {
        clearTimeout(ws.e2eTimeout);
        ws.e2eTimeout = null;
    }

    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(E2E_UNAUTHENTICATED_CLOSE_CODE, E2E_UNAUTHENTICATED_CLOSE_REASON);
    }
}

function closeE2EUnavailable(ws, reason) {
    logDebug(`[E2E] ${reason}`);

    if (ws.e2eTimeout) {
        clearTimeout(ws.e2eTimeout);
        ws.e2eTimeout = null;
    }

    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(E2E_UNAVAILABLE_CLOSE_CODE, E2E_UNAVAILABLE_CLOSE_REASON);
    }
}

// Generate ECDH key pair for key exchange
async function generateECDHKeyPair() {
    const keyPair = await crypto.webcrypto.subtle.generateKey(
        {
            name: 'ECDH',
            namedCurve: 'P-256',
        },
        true,
        ['deriveBits']
    );

    const publicJwk = await crypto.webcrypto.subtle.exportKey('jwk', keyPair.publicKey);

    return {
        keyPair,
        publicJwk,
    };
}

// Derive shared secret from ECDH
async function deriveSharedSecret(privateKey, otherPublicKeyJwk) {
    const otherPublicKey = await crypto.webcrypto.subtle.importKey(
        'jwk',
        otherPublicKeyJwk,
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        []
    );

    const sharedSecret = await crypto.webcrypto.subtle.deriveBits(
        { name: 'ECDH', public: otherPublicKey },
        privateKey,
        256
    );

    return Buffer.from(sharedSecret);
}

// Derive AES-256-GCM key using HKDF
function deriveSessionKey(sharedSecret, salt) {
    // Use HKDF to derive a 256-bit key
    const key = crypto.hkdfSync('sha256', sharedSecret, salt, E2E_INFO, 32);
    return Buffer.from(key);
}

// Generate hex fingerprint from key material (8 bytes = 16 hex chars)
// Matches the client-side generateFingerprintHex() in useE2E.js
function generateFingerprint(sharedSecret, salt) {
    const combined = Buffer.concat([sharedSecret, salt]);
    const hash = crypto.createHash('sha256').update(combined).digest();
    return hash.subarray(0, 8).toString('hex');
}

// Encrypt message with AES-256-GCM
function encryptMessage(plaintext, sessionKey) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', sessionKey, iv);

    const encrypted = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final()
    ]);
    const authTag = cipher.getAuthTag();

    return {
        iv: iv.toString('base64'),
        data: encrypted.toString('base64'),
        tag: authTag.toString('base64')
    };
}

// Decrypt message with AES-256-GCM
function decryptMessage(encrypted, sessionKey) {
    try {
        const iv = Buffer.from(encrypted.iv, 'base64');
        const data = Buffer.from(encrypted.data, 'base64');
        const authTag = Buffer.from(encrypted.tag, 'base64');

        const decipher = crypto.createDecipheriv('aes-256-gcm', sessionKey, iv);
        decipher.setAuthTag(authTag);

        const decrypted = Buffer.concat([
            decipher.update(data),
            decipher.final()
        ]);

        return decrypted.toString('utf8');
    } catch (e) {
        logDebug(`[E2E] Decryption failed: ${e.message}`);
        return null;
    }
}

// E2E setup timeout (10 seconds)
const E2E_SETUP_TIMEOUT_MS = 10000;

// Initialize E2E for a WebSocket connection
async function initE2EKeyExchange(ws) {
    if (!desktopIdentityKeyPair?.privateKeyJwk || !desktopIdentityKeyPair?.publicKeyJwk) {
        logDebug('[E2E] FATAL: desktop identity keypair unavailable; refusing authenticated E2E setup');
        closeE2EUnavailable(ws, 'Desktop identity keypair unavailable');
        return false;
    }

    const keyPair = await generateECDHKeyPair();

    // Store on ws object for later use
    ws.e2e = {
        keyPair: keyPair.keyPair,
        publicJwk: keyPair.publicJwk,
        sessionKey: null,
        fingerprint: null,
        ready: false
    };

    // Set E2E setup timeout - disconnect if not completed in time
    ws.e2eTimeout = setTimeout(() => {
        if (!ws.e2e?.ready) {
            logDebug('[SECURITY] E2E setup timeout, closing connection');
            ws.close(1008, 'E2E setup timeout');
        }
    }, E2E_SETUP_TIMEOUT_MS);

    logDebug('[E2E] Authenticated key exchange ready; awaiting client key');
    return true;
}

// Complete E2E setup when we receive client's public key
async function completeE2EKeyExchange(ws, clientEcdhPubJwk, clientSignature) {
    if (!ws.e2e || !ws.e2e.keyPair?.privateKey || !ws.e2e.publicJwk) {
        closeE2EUnauthenticated(ws, 'Missing ECDH context for this connection');
        return false;
    }

    try {
        if (!isValidEcdhPublicJwk(clientEcdhPubJwk) || typeof clientSignature !== 'string' || !clientSignature) {
            closeE2EUnauthenticated(ws, 'Rejected malformed client E2E payload');
            return false;
        }

        const authorized = getAuthorizedPairedKeys();
        const pairedDevice = authorized.find((key) => key.kid === ws.kid);
        const clientPayload = canonicalizeJwkBuffer(clientEcdhPubJwk);

        if (!pairedDevice?.jwk) {
            closeE2EUnauthenticated(ws, `No paired RSA key available for device ${ws.kid || 'unknown'}`);
            return false;
        }

        if (!verifySignatureWithJwk(pairedDevice.jwk, clientSignature, clientPayload, 'base64')) {
            closeE2EUnauthenticated(ws, `Rejected unauthenticated client E2E key for ${ws.kid.substring(0, 8)}...`);
            return false;
        }

        // Bind both ephemeral keys into the signature transcript so a MITM cannot splice halves.
        const transcriptSalt = deriveE2ETranscriptSalt(clientEcdhPubJwk, ws.e2e.publicJwk);
        const sharedSecret = await deriveSharedSecret(ws.e2e.keyPair.privateKey, clientEcdhPubJwk);
        ws.e2e.sessionKey = deriveSessionKey(sharedSecret, transcriptSalt);
        ws.e2e.fingerprint = generateFingerprint(sharedSecret, transcriptSalt);
        ws.e2e.ready = true;

        // Clear E2E setup timeout
        if (ws.e2eTimeout) {
            clearTimeout(ws.e2eTimeout);
            ws.e2eTimeout = null;
        }

        // Update global fingerprint for tray display
        currentFingerprint = ws.e2e.fingerprint;
        currentSessionStartedAt = new Date().toISOString();

        logDebug(`[E2E] Key exchange complete. Fingerprint: ${ws.e2e.fingerprint}`);

        const serverSignature = signRsaPssPayload(
            desktopIdentityKeyPair.privateKeyJwk,
            buildE2ETranscript(clientEcdhPubJwk, ws.e2e.publicJwk)
        );

        // Send the signed server ephemeral key before any encrypted payloads.
        ws.send(JSON.stringify({
            type: 'e2e_server_key',
            serverEcdhPubJwk: ws.e2e.publicJwk,
            serverSignature,
        }));

        // Send operating mode so client shows the right UI
        ws.send(JSON.stringify({
            type: 'operating_mode',
            mode: operatingMode,
        }));

        // Flush buffered output after the signed server key. WebSocket preserves
        // ordering, so the client verifies the transcript before decrypting these.
        if (ws.pendingOutput && ws.pendingOutput.length > 0) {
            logDebug(`[E2E] Flushing ${ws.pendingOutput.length} buffered messages`);
            for (const data of ws.pendingOutput) {
                sendEncryptedOutput(ws, data);
            }
            ws.pendingOutput = [];
        }

        // Notify renderer to show fingerprint + session timestamp
        if (mainWindow) {
            mainWindow.webContents.send('E2E_FINGERPRINT', ws.e2e.fingerprint, new Date().toISOString());
        }

        return true;
    } catch (e) {
        closeE2EUnauthenticated(ws, `Key exchange failed: ${e.message}`);
        return false;
    }
}

// Send encrypted output to client
function sendEncryptedOutput(ws, data) {
    if (!ws.e2e || !ws.e2e.ready) {
        // Buffer output until E2E is ready - NO UNENCRYPTED FALLBACK
        if (!ws.pendingOutput) ws.pendingOutput = [];
        ws.pendingOutput.push(data);
        logDebug(`[E2E] Buffering output (${data.length} bytes) until E2E ready`);
        return;
    }

    const encrypted = encryptMessage(data, ws.e2e.sessionKey);
    ws.send(JSON.stringify({
        type: 'e2e_output',
        ...encrypted
    }));
}

// Decrypt input from client
function decryptInput(ws, encrypted) {
    if (!ws.e2e || !ws.e2e.ready) {
        return null;
    }
    return decryptMessage(encrypted, ws.e2e.sessionKey);
}

// WORKER AUTHENTICATION MODULE
// ECDSA P-256 key generation and signing for Worker API authentication

/**
 * Get or create machine ID (persistent UUID)
 */
function getMachineId() {
    let machineId = store.get('machineId');
    if (!machineId) {
        machineId = crypto.randomUUID();
        store.set('machineId', machineId);
        logDebug(`[WORKER] Generated new machine ID: ${machineId.substring(0, 8)}...`);
    }
    return machineId;
}

/**
 * Generate ECDSA P-256 keypair for Worker authentication using Web Crypto API
 */
async function generateWorkerKeyPair() {
    const { publicKey, privateKey } = await crypto.webcrypto.subtle.generateKey(
        {
            name: 'ECDSA',
            namedCurve: 'P-256'
        },
        true,
        ['sign', 'verify']
    );

    // Export keys as JWK
    const publicKeyJWK = await crypto.webcrypto.subtle.exportKey('jwk', publicKey);
    const privateKeyJWK = await crypto.webcrypto.subtle.exportKey('jwk', privateKey);

    return { publicKeyJWK, privateKeyJWK };
}

/**
 * Sign a message with ECDSA P-256 private key using Web Crypto API
 */
async function signMessage(privateKeyJWK, message) {
    // Import the private key
    const privateKey = await crypto.webcrypto.subtle.importKey(
        'jwk',
        privateKeyJWK,
        {
            name: 'ECDSA',
            namedCurve: 'P-256'
        },
        false,
        ['sign']
    );

    // Sign the message
    const encoder = new TextEncoder();
    const data = encoder.encode(message);
    const signature = await crypto.webcrypto.subtle.sign(
        {
            name: 'ECDSA',
            hash: 'SHA-256'
        },
        privateKey,
        data
    );

    // Convert ArrayBuffer to base64
    return Buffer.from(signature).toString('base64');
}

/**
 * Get or create Worker authentication keypair
 * Private key stored in Keychain as JSON, public key in electron-store
 */
async function getOrCreateWorkerKeyPair() {
    // Try to get existing private key from Keychain
    const privateKeyJson = await keytar.getPassword(KEYTAR_SERVICE, KEYTAR_WORKER_PRIVATE_KEY);
    let publicKeyJWK = store.get('workerPublicKeyJWK');

    if (privateKeyJson && publicKeyJWK) {
        const privateKeyJWK = JSON.parse(privateKeyJson);
        return { privateKeyJWK, publicKeyJWK };
    }

    // Generate new keypair
    logDebug('[WORKER] Generating new authentication keypair...');
    const keypair = await generateWorkerKeyPair();

    // Store private key JWK in Keychain as JSON
    await keytar.setPassword(KEYTAR_SERVICE, KEYTAR_WORKER_PRIVATE_KEY, JSON.stringify(keypair.privateKeyJWK));
    // Store public key JWK in electron-store
    store.set('workerPublicKeyJWK', keypair.publicKeyJWK);

    logDebug('[WORKER] Authentication keypair generated and stored');
    return { privateKeyJWK: keypair.privateKeyJWK, publicKeyJWK: keypair.publicKeyJWK };
}

/**
 * Request tunnel from Worker API
 * Returns { tunnelToken, subdomain, hostname } on success
 */
async function requestTunnelFromWorker() {
    const machineId = getMachineId();
    const { privateKeyJWK, publicKeyJWK } = await getOrCreateWorkerKeyPair();

    // Generate challenge and timestamp
    const challenge = crypto.randomBytes(32).toString('hex');
    const timestamp = Date.now();

    // Sign: machineId:challenge:timestamp
    const message = `${machineId}:${challenge}:${timestamp}`;
    const signature = await signMessage(privateKeyJWK, message);

    logDebug(`[WORKER] Requesting tunnel for machine ${machineId.substring(0, 8)}...`);

    const response = await fetch(`${WORKER_BASE_URL}/api/v1/tunnel/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            machineId,
            publicKeyJWK,
            signature,
            challenge,
            timestamp
        })
    });

    const data = await response.json();

    if (!response.ok) {
        throw new Error(data.error || `Worker API error: ${response.status}`);
    }

    if (!data.success) {
        throw new Error(data.error || 'Unknown Worker error');
    }

    logDebug(`[WORKER] Tunnel assigned: ${data.hostname}`);

    // Cache the tunnel token in Keychain
    await keytar.setPassword(KEYTAR_SERVICE, KEYTAR_TUNNEL_TOKEN, data.tunnelToken);
    // Cache subdomain in store
    store.set('tunnelSubdomain', data.subdomain);

    return {
        tunnelToken: data.tunnelToken,
        subdomain: data.subdomain,
        hostname: data.hostname
    };
}

/**
 * Customize subdomain via Worker API
 */
async function customizeSubdomain(newSubdomain) {
    const machineId = getMachineId();
    const { privateKeyJWK } = await getOrCreateWorkerKeyPair();

    const challenge = crypto.randomBytes(32).toString('hex');
    const timestamp = Date.now();

    // Sign: machineId:newSubdomain:challenge:timestamp
    const message = `${machineId}:${newSubdomain.toLowerCase()}:${challenge}:${timestamp}`;
    const signature = await signMessage(privateKeyJWK, message);

    logDebug(`[WORKER] Customizing subdomain to: ${newSubdomain}`);

    const response = await fetch(`${WORKER_BASE_URL}/api/v1/tunnel/customize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            machineId,
            newSubdomain: newSubdomain.toLowerCase(),
            signature,
            challenge,
            timestamp
        })
    });

    const data = await response.json();

    if (!response.ok) {
        throw new Error(data.error || `Worker API error: ${response.status}`);
    }

    // Update cached subdomain
    store.set('tunnelSubdomain', data.subdomain);

    return {
        subdomain: data.subdomain,
        hostname: data.hostname,
        oldSubdomain: data.oldSubdomain
    };
}

/**
 * Get cached tunnel credentials (for offline mode)
 */
async function getCachedTunnelCredentials() {
    const tunnelToken = await keytar.getPassword(KEYTAR_SERVICE, KEYTAR_TUNNEL_TOKEN);
    const subdomain = store.get('tunnelSubdomain');

    if (tunnelToken && subdomain) {
        return {
            tunnelToken,
            subdomain,
            hostname: `${subdomain}.${WORKER_DOMAIN}`
        };
    }
    return null;
}

// 1. GUI SETUP
function createWindow() {
    mainWindow = new BrowserWindow({
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
            preload: path.join(__dirname, 'preload.js'),
            sandbox: true
        }
    });

    // In development, load from Vite dev server for HMR
    // In production, load from built file
    if (isDev) {
        mainWindow.loadURL(`http://localhost:${VITE_RENDERER_PORT}/renderer.html`);
        // Open DevTools in dev mode for debugging
        // mainWindow.webContents.openDevTools({ mode: 'detach' });
    } else {
        mainWindow.loadFile('ui/dist/renderer.html');
    }

    // Hide when it loses focus
    mainWindow.on('blur', () => {
        if (!mainWindow.webContents.isDevToolsOpened()) {
            mainWindow.hide();
        }
    });

    // Sync state when renderer reloads
    mainWindow.webContents.on('did-finish-load', () => {
        syncStateWithRenderer();
    });
}

function getDevDockIconPath() {
    if (!isDev) {
        return null;
    }

    const preferredIconPath = path.join(__dirname, 'public', 'icon-macos-dock.png');
    if (fs.existsSync(preferredIconPath)) {
        return preferredIconPath;
    }

    const fallbackIconPath = path.join(__dirname, 'public', 'icon-512-v3.png');
    return fs.existsSync(fallbackIconPath) ? fallbackIconPath : null;
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

function syncDockVisibility() {
    if (!app.dock) {
        return;
    }

    const localChatVisible = Boolean(
        localChatWindow
        && !localChatWindow.isDestroyed()
        && localChatWindow.isVisible()
    );
    const fallbackMainVisible = Boolean(
        mainWindow
        && !mainWindow.isDestroyed()
        && mainWindow.isVisible()
        && !tray
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

function toggleLocalChatWindow() {
    if (localChatWindow && !localChatWindow.isDestroyed() && localChatWindow.isVisible()) {
        localChatWindow.hide();
        syncDockVisibility();
        return localChatWindow;
    }

    return createLocalChatWindow();
}

function createLocalChatWindow() {
    if (localChatWindow && !localChatWindow.isDestroyed()) {
        localChatWindow.show();
        localChatWindow.focus();
        return localChatWindow;
    }

    localChatWindow = new BrowserWindow({
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
            preload: path.join(__dirname, 'preload.js'),
            sandbox: true
        }
    });

    if (process.platform === 'darwin') {
        localChatWindow.setWindowButtonVisibility(false);
    }

    if (isDev) {
        localChatWindow.loadURL(`http://localhost:${VITE_RENDERER_PORT}/renderer.html?view=chat`);
    } else {
        localChatWindow.loadFile('ui/dist/renderer.html', { search: '?view=chat' });
    }

    localChatWindow.once('ready-to-show', () => {
        if (localChatWindow && !localChatWindow.isDestroyed()) {
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
        localChatWindow = null;
        syncDockVisibility();
    });

    localChatWindow.webContents.on('did-finish-load', () => {
        if (localChatWindow && !localChatWindow.isDestroyed()) {
            localChatWindow.webContents.send('SYNC_STATE', getTunnelState());
        }
    });

    return localChatWindow;
}

function registerGlobalShortcuts() {
    const startTunnelRegistered = globalShortcut.register('CommandOrControl+Shift+J', async () => {
        if (isConnecting || server || tunnelProcess) {
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

async function getStoredTunnelSettings() {
    const settings = store?.get('cfSettings', {}) || {};
    let token = '';

    try {
        token = (await keytar.getPassword(KEYTAR_SERVICE, KEYTAR_CF_TOKEN)) || '';
    } catch (error) {
        logDebug(`[SYSTEM] Failed to read secure tunnel token: ${error.message}`);
    }

    return {
        token,
        domain: settings?.domain || '',
    };
}

function getActivityAssistantName() {
    const rawName = store?.get('cfSettings', {})?.assistantName;
    if (typeof rawName !== 'string') {
        return DEFAULT_ACTIVITY_ASSISTANT_NAME;
    }

    const trimmedName = rawName.trim();
    return trimmedName || DEFAULT_ACTIVITY_ASSISTANT_NAME;
}

function buildNotificationPreviewBody(content = '') {
    if (typeof content !== 'string') {
        return `${getActivityAssistantName()} sent a new message`;
    }

    const cleaned = content
        .replace(/\s+/g, ' ')
        .replace(/[`*_>#-]+/g, ' ')
        .trim();

    if (!cleaned) {
        return `${getActivityAssistantName()} sent a new message`;
    }

    const maxLength = 140;
    return cleaned.length > maxLength
        ? `${cleaned.slice(0, maxLength - 1).trimEnd()}…`
        : cleaned;
}

function getPushAssistantNotificationPayload(message = {}) {
    const assistantName = getActivityAssistantName();
    const title = assistantName || 'New message';
    const body = buildNotificationPreviewBody(message.content);
    return {
        // Standard fields for our service worker
        title,
        body,
        tag: 'root-operator-assistant-reply',
        url: PUSH_NOTIFICATION_TARGET_URL,
        assistantName,
        ts: message.ts || new Date().toISOString(),
        icon: '/icon-192-v3.png',
        badge: '/icon-192-v3.png',
        // Declarative Web Push (iOS 18.4+) — browser shows this notification
        // directly if the service worker fails or times out.
        // Per WebKit spec: 'navigate' is top-level, not inside 'notification'.
        web_push: 8030,
        navigate: PUSH_NOTIFICATION_TARGET_URL,
        notification: {
            title,
            body,
            icon: '/icon-192-v3.png',
            badge: '/icon-192-v3.png',
            tag: 'root-operator-assistant-reply',
        },
    };
}

function getDesktopAssistantNotificationPayload(message = {}) {
    return {
        title: 'Root Operator',
        subtitle: getActivityAssistantName(),
        body: buildNotificationPreviewBody(message.content),
    };
}

function getStoredPushSubscriptions() {
    if (!store) {
        return [];
    }

    const subscriptions = store.get(PUSH_SUBSCRIPTIONS_STORE_KEY, []);
    return Array.isArray(subscriptions) ? subscriptions : [];
}

function savePushSubscriptions(subscriptions) {
    if (!store) {
        return;
    }

    store.set(PUSH_SUBSCRIPTIONS_STORE_KEY, Array.isArray(subscriptions) ? subscriptions : []);
}

function isEncryptedPushVapidKeysRecord(value) {
    return (
        value
        && typeof value.publicKey === 'string'
        && value.publicKey
        && typeof value.privateKeyEncrypted === 'string'
        && value.privateKeyEncrypted
        && typeof value.privateKey !== 'string'
    );
}

function isPlaintextPushVapidKeysRecord(value) {
    return (
        value
        && typeof value.publicKey === 'string'
        && value.publicKey
        && typeof value.privateKey === 'string'
        && value.privateKey
    );
}

function storeEncryptedPushVapidKeys(vapidKeys) {
    const storedVapidKeys = {
        publicKey: vapidKeys.publicKey,
        privateKeyEncrypted: safeStorage.encryptString(vapidKeys.privateKey).toString('base64'),
    };

    store.set(PUSH_VAPID_KEYS_STORE_KEY, storedVapidKeys);

    const verified = store.get(PUSH_VAPID_KEYS_STORE_KEY, null);
    if (
        !isEncryptedPushVapidKeysRecord(verified)
        || verified.publicKey !== storedVapidKeys.publicKey
        || verified.privateKeyEncrypted !== storedVapidKeys.privateKeyEncrypted
    ) {
        throw new Error('Failed to verify stored VAPID key record');
    }

    return storedVapidKeys;
}

function decryptStoredPushVapidKeys(storedVapidKeys) {
    return {
        publicKey: storedVapidKeys.publicKey,
        privateKey: safeStorage.decryptString(Buffer.from(storedVapidKeys.privateKeyEncrypted, 'base64')),
    };
}

function getStoredPushVapidKeys() {
    if (cachedPushVapidKeys !== undefined) {
        return cachedPushVapidKeys;
    }

    if (!store) {
        return null;
    }

    if (!safeStorage.isEncryptionAvailable()) {
        logDebug('[SECURITY] safeStorage unavailable, push notifications disabled');
        cachedPushVapidKeys = null;
        return null;
    }

    try {
        const existing = store.get(PUSH_VAPID_KEYS_STORE_KEY, null);
        if (isEncryptedPushVapidKeysRecord(existing)) {
            try {
                cachedPushVapidKeys = decryptStoredPushVapidKeys(existing);
                return cachedPushVapidKeys;
            } catch (error) {
                logDebug('[SECURITY] Failed to decrypt VAPID private key — regenerating');
                const regenerated = webpush.generateVAPIDKeys();
                storeEncryptedPushVapidKeys(regenerated);
                // Old subscriptions are bound to the old VAPID key — clear them
                savePushSubscriptions([]);
                logDebug('[NOTIFICATIONS] Generated VAPID keys — cleared stale subscriptions');
                cachedPushVapidKeys = regenerated;
                return cachedPushVapidKeys;
            }
        }

        if (isPlaintextPushVapidKeysRecord(existing)) {
            const migrated = {
                publicKey: existing.publicKey,
                privateKey: existing.privateKey,
            };
            storeEncryptedPushVapidKeys(migrated);
            logDebug('[SECURITY] Migrated VAPID private key to safeStorage');
            cachedPushVapidKeys = migrated;
            return cachedPushVapidKeys;
        }

        const generated = webpush.generateVAPIDKeys();
        storeEncryptedPushVapidKeys(generated);
        logDebug('[NOTIFICATIONS] Generated VAPID keys');
        cachedPushVapidKeys = generated;
        return cachedPushVapidKeys;
    } catch (error) {
        logDebug(`[NOTIFICATIONS] Failed to initialize VAPID keys: ${error.message}`);
        cachedPushVapidKeys = null;
        return null;
    }
}

function configureWebPush() {
    const vapidKeys = getStoredPushVapidKeys();
    if (!vapidKeys) {
        return null;
    }

    webpush.setVapidDetails(
        PUSH_NOTIFICATION_SUBJECT,
        vapidKeys.publicKey,
        vapidKeys.privateKey,
    );

    return vapidKeys;
}

function normalizePushSubscription(subscription) {
    if (!subscription || typeof subscription !== 'object') {
        return null;
    }

    const endpoint = typeof subscription.endpoint === 'string' ? subscription.endpoint.trim() : '';
    const keys = subscription.keys && typeof subscription.keys === 'object' ? subscription.keys : {};
    const p256dh = typeof keys.p256dh === 'string' ? keys.p256dh.trim() : '';
    const auth = typeof keys.auth === 'string' ? keys.auth.trim() : '';

    if (!endpoint || !p256dh || !auth) {
        return null;
    }

    return {
        endpoint,
        expirationTime: typeof subscription.expirationTime === 'number' ? subscription.expirationTime : null,
        keys: { p256dh, auth },
    };
}

function getPairedDeviceLabel(kid) {
    if (!kid) {
        return 'Unknown device';
    }

    const keys = store?.get('keys', []) || [];
    const device = keys.find((item) => item.kid === kid);
    return device?.name || kid.substring(0, 12);
}

function getStoredPairedKeys() {
    if (!store) {
        return [];
    }

    const keys = store.get('keys', []);
    return Array.isArray(keys) ? keys : [];
}

function getAuthorizedPairedKeys() {
    return getStoredPairedKeys().filter((keyRecord) => {
        if (isValidKeyId(keyRecord?.kid) && isValidPairingJwk(keyRecord?.jwk)) {
            return true;
        }

        const warningKey = typeof keyRecord?.kid === 'string' && keyRecord.kid
            ? keyRecord.kid
            : 'unknown-invalid-pairing-key';
        const warningLabel = typeof keyRecord?.kid === 'string' && keyRecord.kid
            ? keyRecord.kid.substring(0, 8)
            : 'unknown';
        if (!loggedInvalidStoredPairingKids.has(warningKey)) {
            loggedInvalidStoredPairingKids.add(warningKey);
            logDebug(`[SECURITY] Stored pairing JWK failed validation; refusing device until re-paired (${warningLabel})`);
        }
        return false;
    });
}

function buildNotificationStatePayload(kid) {
    const vapidKeys = configureWebPush();
    const subscriptions = getStoredPushSubscriptions();

    return {
        type: 'notifications_state',
        supported: Boolean(vapidKeys?.publicKey),
        vapidPublicKey: vapidKeys?.publicKey || '',
        subscribed: Boolean(kid && subscriptions.some((entry) => entry.kid === kid)),
    };
}

function sendNotificationState(ws) {
    if (!ws || ws.readyState !== WebSocket.OPEN || !ws.authenticated) {
        return;
    }

    try {
        ws.send(JSON.stringify(buildNotificationStatePayload(ws.kid || '')));
    } catch (error) {
        logDebug(`[NOTIFICATIONS] Failed to send notification state: ${error.message}`);
    }
}

function upsertPushSubscription({ kid, subscription, platform = '', userAgent = '' }) {
    const normalized = normalizePushSubscription(subscription);
    if (!kid || !normalized) {
        return false;
    }

    const now = new Date().toISOString();
    const subscriptions = getStoredPushSubscriptions();
    const existing = subscriptions.find((entry) => entry.kid === kid);
    const next = subscriptions.filter((entry) => entry.kid !== kid && entry.subscription?.endpoint !== normalized.endpoint);

    next.push({
        kid,
        name: getPairedDeviceLabel(kid),
        subscription: normalized,
        platform: typeof platform === 'string' ? platform.trim() : '',
        userAgent: typeof userAgent === 'string' ? userAgent.trim() : '',
        createdAt: existing?.createdAt || now,
        updatedAt: now,
    });

    savePushSubscriptions(next);
    logDebug(`[NOTIFICATIONS] Registered push subscription for ${kid.substring(0, 8)}...`);
    return true;
}

function removePushSubscriptionsForKid(kid) {
    if (!kid) {
        return;
    }

    const subscriptions = getStoredPushSubscriptions();
    const next = subscriptions.filter((entry) => entry.kid !== kid);
    if (next.length !== subscriptions.length) {
        savePushSubscriptions(next);
        logDebug(`[NOTIFICATIONS] Removed push subscriptions for ${kid.substring(0, 8)}...`);
    }
}

function removePushSubscriptionByEndpoint(endpoint) {
    if (!endpoint) {
        return;
    }

    const subscriptions = getStoredPushSubscriptions();
    const next = subscriptions.filter((entry) => entry.subscription?.endpoint !== endpoint);
    if (next.length !== subscriptions.length) {
        savePushSubscriptions(next);
        logDebug('[NOTIFICATIONS] Removed stale push subscription');
    }
}

function shouldSuppressDesktopNotification() {
    const focusedWindow = BrowserWindow.getFocusedWindow();
    return Boolean(
        focusedWindow
        && !focusedWindow.isDestroyed()
        && (focusedWindow === localChatWindow || focusedWindow === mainWindow)
    );
}

function showDesktopAssistantNotification(message) {
    if (!Notification.isSupported() || shouldSuppressDesktopNotification()) {
        return;
    }

    const payload = getDesktopAssistantNotificationPayload(message);
    const notification = new Notification({
        title: payload.title,
        subtitle: payload.subtitle,
        body: payload.body,
        icon: path.join(__dirname, 'public', 'icon-192-v3.png'),
        silent: false,
    });

    notification.on('click', () => {
        app.focus({ steal: true });
        createLocalChatWindow();
    });

    notification.show();
}

async function sendPushNotification(entry, payload) {
    try {
        await webpush.sendNotification(entry.subscription, JSON.stringify(payload), {
            TTL: 86400,
            urgency: 'high',
        });
    } catch (error) {
        if (error.statusCode === 404 || error.statusCode === 410) {
            removePushSubscriptionByEndpoint(entry.subscription?.endpoint);
        }
        throw error;
    }
}

async function notifyPushSubscribers(message) {
    const subscriptions = getStoredPushSubscriptions();
    if (subscriptions.length === 0) {
        return;
    }

    // Skip push only for devices with a genuinely active WebSocket connection.
    // iOS suspends WebSockets when the PWA is backgrounded without closing them,
    // so readyState alone is not reliable. A connection is considered active only if:
    // (a) the socket is open AND authenticated, AND
    // (b) the client reported itself as visible (not backgrounded), AND
    // (c) we received a heartbeat ping within the last 35 seconds (one heartbeat cycle).
    //     Uses lastHeartbeat (not lastActivity) because client_visible messages are
    //     fire-and-forget — if iOS drops one, lastActivity would be artificially fresh.
    const STALE_THRESHOLD_MS = 35000;
    const now = Date.now();
    const activeKids = new Set(
        [...activeClients]
            .filter((c) => (
                c.readyState === 1
                && c.authenticated
                && c.clientVisible === true
                && (now - (c.lastHeartbeat || 0)) < STALE_THRESHOLD_MS
            ))
            .map((c) => c.kid)
            .filter(Boolean),
    );

    // Log each client's state for debugging push routing — show which
    // condition(s) caused it to be excluded from activeKids
    for (const c of activeClients) {
        const hbAge = c.lastHeartbeat ? now - c.lastHeartbeat : 'never';
        const kid8 = (c.kid || '?').substring(0, 8);
        const isOpen = c.readyState === 1;
        const isAuth = !!c.authenticated;
        const isVis = c.clientVisible === true;
        const hbFresh = (now - (c.lastHeartbeat || 0)) < STALE_THRESHOLD_MS;
        const suppressed = isOpen && isAuth && isVis && hbFresh;
        const reason = suppressed
            ? 'SUPPRESSED (active)'
            : `PUSH (open=${isOpen} auth=${isAuth} vis=${isVis} hbFresh=${hbFresh})`;
        logDebug(`[NOTIFICATIONS] Client ${kid8}: ${reason} hbAge=${hbAge}ms`);
    }

    const targets = subscriptions.filter((entry) => !activeKids.has(entry.kid));
    logDebug(`[NOTIFICATIONS] Push routing: ${subscriptions.length} subs, ${activeKids.size} active, ${targets.length} targets`);
    if (targets.length === 0) {
        logDebug('[NOTIFICATIONS] All devices have active WS — push suppressed');
        return;
    }

    for (const t of targets) {
        logDebug(`[NOTIFICATIONS] Sending push to ${(t.kid || '?').substring(0, 8)} (${t.platform || 'unknown'})`);
    }

    const payload = getPushAssistantNotificationPayload(message);
    const results = await Promise.allSettled(targets.map((entry) => sendPushNotification(entry, payload)));
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length > 0) {
        for (const f of failures) {
            logDebug(`[NOTIFICATIONS] Push delivery failure: ${f.reason?.message || f.reason}`);
        }
    }
}

function notifyAssistantReply(message) {
    showDesktopAssistantNotification(message);
    notifyPushSubscribers(message).catch((error) => {
        logDebug(`[NOTIFICATIONS] Failed to deliver push notifications: ${error.message}`);
    });
}

function createTray() {
    try {
        console.log('Creating tray...');
        const iconPath = path.join(__dirname, 'tray_iconTemplate.png');

        if (!fs.existsSync(iconPath)) {
            console.error('Tray icon DOES NOT EXIST at:', iconPath);
            if (app.dock) app.dock.show();
            mainWindow.show();
            return;
        }

        tray = new Tray(iconPath);
        tray.setToolTip('Root Operator');
        tray.setIgnoreDoubleClickEvents(true);

        // Left click: toggle window only
        tray.on('click', () => {
            console.log('Tray clicked');
            toggleWindow();
        });

        // Right click: show context menu
        tray.on('right-click', () => {
            const contextMenu = buildTrayMenu();
            tray.popUpContextMenu(contextMenu);
        });

        syncStateWithRenderer();
        console.log('Tray created successfully');
    } catch (err) {
        console.error('Failed to create tray:', err);
        if (app.dock) app.dock.show();
        mainWindow.show();
    }
}

function toggleWindow() {
    if (mainWindow.isVisible()) {
        mainWindow.hide();
    } else {
        showWindow();
    }
}

function showWindow() {
    const trayBounds = tray.getBounds();
    const windowBounds = mainWindow.getBounds();

    const x = Math.round(trayBounds.x + (trayBounds.width / 2) - (windowBounds.width / 2));
    const y = Math.round(trayBounds.y + trayBounds.height + 4);

    mainWindow.setPosition(x, y, false);
    mainWindow.show();
    mainWindow.focus();

    // Sync state with renderer
    syncStateWithRenderer();
}

function clearChannelConfirmTimers() {
    for (const timer of channelConfirmTimers) {
        clearTimeout(timer);
    }
    channelConfirmTimers = [];
}

function clearChannelStartupTimer() {
    if (channelStartupTimer) {
        clearTimeout(channelStartupTimer);
        channelStartupTimer = null;
    }
}

function clearChannelRestartTimer() {
    if (channelRestartTimer) {
        clearTimeout(channelRestartTimer);
        channelRestartTimer = null;
    }
}

function clearChannelIdleTimer() {
    if (channelIdleTimer) {
        clearTimeout(channelIdleTimer);
        channelIdleTimer = null;
    }
}

function shellEscapeArg(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function removeChannelSocket() {
    try {
        if (fs.existsSync(CHANNEL_IPC_PATH)) {
            fs.unlinkSync(CHANNEL_IPC_PATH);
        }
    } catch (error) {
        logDebug(`[CHANNEL] Failed to remove socket: ${error.message}`);
    }
}

function sendEncryptedChannelPayload(payload) {
    const body = JSON.stringify(payload);
    for (const client of activeClients) {
        if (client.readyState === WebSocket.OPEN) {
            sendEncryptedOutput(client, body);
        }
    }
}

function formatClaudeToolLabel(toolName) {
    if (!toolName) {
        return 'Tool';
    }

    const alias = {
        Bash: 'Shell',
        MultiEdit: 'Multi Edit',
        TodoRead: 'Todo',
        TodoWrite: 'Todo',
        WebFetch: 'Web Fetch',
        WebSearch: 'Web Search',
        reply: 'Reply',
    };

    const shortName = toolName.split('__').pop() || toolName;
    if (alias[shortName]) {
        return alias[shortName];
    }

    return shortName
        .replace(/[-_]+/g, ' ')
        .trim()
        .split(/\s+/)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
}

function getClaudeToolKey(toolName) {
    if (!toolName) {
        return '';
    }

    return toolName.split('__').pop() || toolName;
}

function getClaudeHookFilePath(event) {
    const toolInput = event?.toolInput && typeof event.toolInput === 'object' ? event.toolInput : {};
    const toolResponse = event?.toolResponse && typeof event.toolResponse === 'object' ? event.toolResponse : {};
    const candidates = [
        toolInput.file_path,
        toolInput.filePath,
        toolResponse.filePath,
        toolResponse.file_path,
        toolInput.path,
        toolResponse.path,
    ];

    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim()) {
            return candidate.trim();
        }
    }

    return '';
}

function formatClaudeActivityFileLabel(filePath, cwd = '') {
    if (!filePath) {
        return '';
    }

    const normalizedFilePath = path.normalize(filePath);
    const normalizedCwd = typeof cwd === 'string' && cwd.trim() ? path.normalize(cwd.trim()) : '';

    if (normalizedCwd) {
        const relativePath = path.relative(normalizedCwd, normalizedFilePath);
        if (relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)) {
            const parts = relativePath.split(path.sep).filter(Boolean);
            if (parts.length >= 2) {
                return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
            }
            return parts[0] || path.basename(normalizedFilePath);
        }
    }

    const baseName = path.basename(normalizedFilePath);
    const parentName = path.basename(path.dirname(normalizedFilePath));
    if (parentName && parentName !== '.' && parentName !== path.sep && parentName !== baseName) {
        return `${parentName}/${baseName}`;
    }

    return baseName || normalizedFilePath;
}

function getClaudeBashCommand(event) {
    const toolInput = event?.toolInput && typeof event.toolInput === 'object' ? event.toolInput : {};
    const candidates = [
        toolInput.command,
        toolInput.cmd,
    ];

    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim()) {
            return candidate.trim();
        }
    }

    return '';
}

function tokenizeShellCommand(command) {
    if (!command) {
        return [];
    }

    const matches = command.match(/"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|`(?:\\.|[^`])*`|[^\s]+/g) || [];
    return matches.map((token) => token.replace(/^["'`]|["'`]$/g, ''));
}

function formatShellCommandPreview(command, maxLength = 72) {
    const normalized = (command || '').replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxLength) {
        return normalized;
    }

    return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function getPrimaryShellCommand(tokens) {
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (!token) {
            continue;
        }

        if (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token)) {
            continue;
        }

        if (token === 'env' || token === '/usr/bin/env' || token === 'command') {
            continue;
        }

        return {
            primary: path.basename(token),
            index,
        };
    }

    return {
        primary: '',
        index: -1,
    };
}

function describeClaudeBashCommand(command) {
    const preview = formatShellCommandPreview(command);
    const tokens = tokenizeShellCommand(command);
    const { primary } = getPrimaryShellCommand(tokens);
    const commandLabel = primary || 'shell command';
    return {
        active: `is running ${commandLabel}`,
        done: `finished ${commandLabel}`,
        failed: `hit an error running ${commandLabel}`,
        detail: preview,
    };
}

function buildClaudeToolActivity(event) {
    const assistantName = getActivityAssistantName();
    const toolName = event.toolName || '';
    const toolKey = getClaudeToolKey(toolName);
    const filePath = getClaudeHookFilePath(event);
    const fileLabel = formatClaudeActivityFileLabel(filePath, event.cwd || '');
    const isActive = event.hookEventName === 'PreToolUse';
    const activityBase = {
        phase: isActive ? 'tool' : 'tool_complete',
        toolName,
        toolUseId: event.toolUseId || '',
        filePath,
        fileLabel,
        ts: event.ts || new Date().toISOString(),
        active: isActive,
    };
    const copyByTool = {
        Read: {
            active: 'is reading',
            done: 'finished reading',
        },
        Write: {
            active: 'is writing',
            done: 'finished writing',
        },
        Edit: {
            active: 'is editing',
            done: 'finished editing',
        },
        MultiEdit: {
            active: 'is editing',
            done: 'finished editing',
        },
        reply: {
            active: 'is preparing a reply',
            done: 'finished preparing a reply',
        },
    };

    if (toolKey === 'Bash') {
        const bashCommand = getClaudeBashCommand(event);
        const bashCopy = describeClaudeBashCommand(bashCommand);
        const action = isActive ? bashCopy.active : bashCopy.done;
        return {
            ...activityBase,
            label: `${assistantName} ${action}`,
            detail: bashCopy.detail || `${assistantName} ${action}.`,
        };
    }

    if (copyByTool[toolKey]) {
        const copy = copyByTool[toolKey];
        const action = isActive ? copy.active : copy.done;
        return {
            ...activityBase,
            label: fileLabel ? `${assistantName} ${action} ${fileLabel}` : `${assistantName} ${action}`,
            detail: filePath || `${assistantName} ${action}.`,
        };
    }

    const toolLabel = formatClaudeToolLabel(toolName);
    return {
        ...activityBase,
        label: isActive
            ? `${assistantName} is using ${toolLabel}`
            : `${assistantName} finished using ${toolLabel}`,
        detail: filePath || `${assistantName} ${isActive ? 'started' : 'finished'} using ${toolLabel}.`,
    };
}

function buildClaudeToolFailureActivity(event) {
    const assistantName = getActivityAssistantName();
    const toolName = event.toolName || '';
    const toolKey = getClaudeToolKey(toolName);
    const filePath = getClaudeHookFilePath(event);
    const fileLabel = formatClaudeActivityFileLabel(filePath, event.cwd || '');
    const copyByTool = {
        Read: 'stopped reading',
        Write: 'stopped writing',
        Edit: 'stopped editing',
        MultiEdit: 'stopped editing',
        reply: 'could not finish the reply',
    };

    if (toolKey === 'Bash') {
        const bashCommand = getClaudeBashCommand(event);
        const bashCopy = describeClaudeBashCommand(bashCommand);
        return {
            phase: 'tool_failed',
            label: `${assistantName} ${bashCopy.failed}`,
            detail: event.error || bashCopy.detail || `${assistantName} ${bashCopy.failed}.`,
            toolName,
            toolUseId: event.toolUseId || '',
            filePath,
            fileLabel,
            ts: event.ts || new Date().toISOString(),
            active: false,
        };
    }

    const fallbackToolLabel = formatClaudeToolLabel(toolName);
    const action = copyByTool[toolKey] || `hit an error using ${fallbackToolLabel}`;

    return {
        phase: 'tool_failed',
        label: fileLabel ? `${assistantName} ${action} ${fileLabel}` : `${assistantName} ${action}`,
        detail: event.error || filePath || `${assistantName} hit an error while using ${fallbackToolLabel}.`,
        toolName,
        toolUseId: event.toolUseId || '',
        filePath,
        fileLabel,
        ts: event.ts || new Date().toISOString(),
        active: false,
    };
}

function resetChannelActivity() {
    clearChannelIdleTimer();
    channelReplyPending = false;
    latestChannelActivity = null;
    lastChannelActivityKey = '';
    lastChannelActivityAt = 0;
    syncStateWithRenderer();
}

function scheduleChannelIdle(detail = `${getActivityAssistantName()} is ready for the next message.`) {
    clearChannelIdleTimer();
    channelIdleTimer = setTimeout(() => {
        channelIdleTimer = null;
        channelReplyPending = false;
        setChannelActivity({
            phase: 'idle',
            label: 'Idle',
            detail,
        }, { force: true });
    }, CHANNEL_ACTIVITY_IDLE_MS);
}

function sendLocalChatEvent(payload) {
    if (localChatWindow && !localChatWindow.isDestroyed()) {
        localChatWindow.webContents.send('LOCAL_CHAT_EVENT', payload);
    }
}

function createChatTimelineItem(activity) {
    const markerTs = activity.ts || new Date().toISOString();
    const activityKey = activity.toolUseId || `${activity.phase || 'idle'}:${activity.label || 'Idle'}:${activity.toolName || ''}:${activity.filePath || ''}`;
    const isActive = activity.active !== false;

    return {
        id: `${markerTs}:${activityKey}`,
        key: activityKey,
        label: activity.label || 'Idle',
        detail: activity.detail || '',
        filePath: activity.filePath || '',
        fileLabel: activity.fileLabel || '',
        active: isActive,
        done: !isActive,
        ts: markerTs,
        completedAt: !isActive ? markerTs : undefined,
    };
}

function getLocalChatState() {
    const messages = chatStore ? chatStore.loadMessages() : [];
    const activities = latestChannelActivity ? [createChatTimelineItem(latestChannelActivity)] : [];

    return {
        messages,
        waiting: channelReplyPending,
        activities,
        alwaysOnTop: Boolean(localChatWindow && !localChatWindow.isDestroyed() && localChatWindow.isAlwaysOnTop()),
    };
}

async function submitChannelUserMessage(chatId, content, userId, options = {}) {
    const { echoToLocalChat = false, senderWs = null } = options;
    const assistantName = getActivityAssistantName();

    if (operatingMode !== 'channel' || !channelManager || !channelManager.connected) {
        return { success: false, error: 'Chat bridge unavailable' };
    }

    const ts = new Date().toISOString();

    // Dynamic Memory: enrich outbound content with a per-turn memory hint
    // before forwarding to the channel bridge. Indexing below still stores
    // the ORIGINAL content so the DB doesn't get polluted with hint wrappers.
    // Bounded by a 500ms Promise.race so a stuck embedder never delays
    // message delivery to Claude.
    let outboundContent = content;
    if (dynamicMemory && dynamicMemory.isEnabled()) {
        const perfStart = Date.now();
        try {
            const memoryBlock = await Promise.race([
                dynamicMemory.buildContextForSpawn(content, chatId, 5),
                new Promise((resolve) => setTimeout(() => resolve(null), 1000)),
            ]);
            if (memoryBlock && typeof memoryBlock === 'string' && memoryBlock.length) {
                // Neutralize envelope-breaking closing tags in interpolated segments.
                // Zero-width space between `<` and `/` keeps the text visually identical
                // to Claude but prevents parsers (here and upstream) from closing the
                // wrapper early when fragments or user text mention these tags literally.
                const sanitizeEnvelope = (s) => String(s).replace(/<\/(system-reminder|memory-context|channel)>/g, '<\u200B/$1>');
                const safeContent = sanitizeEnvelope(content);
                const safeBlock = sanitizeEnvelope(memoryBlock);
                outboundContent = `${safeContent}\n\n<system-reminder>\n<memory-context>\n${safeBlock}\n</memory-context>\n\nReply to the user by calling the mcp__root-operator__reply tool with the chat_id from the <channel> tag above. Do not reply as plain text.\n</system-reminder>`;
            }
            if (process.env.NODE_ENV === 'development' || process.env.DYNAMIC_MEMORY_PERF === '1') {
                const wall = Date.now() - perfStart;
                const hit = outboundContent !== content;
                console.error(`[MEMORY-PERF] enrichment wall=${wall}ms hit=${hit} original_len=${content.length} enriched_len=${outboundContent.length}`);
                logDebug(`[MEMORY-PERF] enrichment wall=${wall}ms hit=${hit} original_len=${content.length} enriched_len=${outboundContent.length}`);
            }
        } catch (err) {
            logDebug(`[MEMORY] Enrichment failed: ${err.message}`);
            outboundContent = content;
        }
    }

    const sentToBridge = channelManager.sendToChannel(chatId, outboundContent, userId || chatId);

    if (dynamicMemory && dynamicMemory.isEnabled()) {
        dynamicMemory.indexMessage('user', content, chatId).catch((err) => {
            logDebug(`[MEMORY] Index (user) error: ${err.message}`);
        });
    }

    channelReplyPending = true;
    setChannelActivity(sentToBridge ? {
        phase: 'bridging',
        label: `Forwarding to ${assistantName}`,
        detail: `The chat bridge accepted your message for ${assistantName}.`,
    } : {
        phase: 'queued',
        label: `Queued for ${assistantName}`,
        detail: `Waiting for the ${assistantName} chat bridge to reconnect.`,
    }, { force: true });

    chatStore.addMessage({ role: 'user', content, ts });

    if (echoToLocalChat) {
        sendLocalChatEvent({
            type: 'channel_message',
            role: 'user',
            content,
            ts,
        });
    }

    // Broadcast to all WebSocket clients except the sender so other clients mirror the message
    const msg = JSON.stringify({ type: 'channel_message', role: 'user', content, ts });
    for (const client of activeClients) {
        if (client !== senderWs && client.readyState === WebSocket.OPEN) {
            sendEncryptedOutput(client, msg);
        }
    }

    return {
        success: true,
        queued: !sentToBridge,
        ts,
    };
}

function setChannelActivity(activity, options = {}) {
    const {
        force = false,
        broadcast = true,
    } = options;

    const normalized = {
        phase: activity.phase || 'idle',
        label: activity.label || 'Idle',
        detail: activity.detail || '',
        toolName: activity.toolName || '',
        toolUseId: activity.toolUseId || '',
        filePath: activity.filePath || '',
        fileLabel: activity.fileLabel || '',
        ts: activity.ts || new Date().toISOString(),
        active: typeof activity.active === 'boolean' ? activity.active : activity.phase !== 'idle',
    };

    const activityKey = normalized.toolUseId || `${normalized.phase}:${normalized.label}:${normalized.toolName}:${normalized.filePath}`;
    const now = Date.now();
    if (!force && activityKey === lastChannelActivityKey && now - lastChannelActivityAt < 900) {
        return;
    }

    lastChannelActivityKey = activityKey;
    lastChannelActivityAt = now;
    latestChannelActivity = normalized.active ? normalized : null;
    if (normalized.phase !== 'idle') {
        clearChannelIdleTimer();
    }

    if (broadcast) {
        sendEncryptedChannelPayload({
            type: 'channel_activity',
            activity: normalized,
        });
    }

    sendLocalChatEvent({
        type: 'channel_activity',
        activity: normalized,
    });

    syncStateWithRenderer();
}

function stopClaudeDebugWatcher() {
    if (claudeDebugPollTimer) {
        clearInterval(claudeDebugPollTimer);
        claudeDebugPollTimer = null;
    }
    claudeDebugReadOffset = 0;
    claudeDebugLineBuffer = '';
    claudeDebugFilePath = '';
}

function stopClaudeHookWatcher() {
    if (claudeHookPollTimer) {
        clearInterval(claudeHookPollTimer);
        claudeHookPollTimer = null;
    }
    claudeHookReadOffset = 0;
    claudeHookLineBuffer = '';
    claudeHookFilePath = '';
}

function handleClaudeDebugLine(line) {
    if (!channelReplyPending) {
        return;
    }

    if (line.includes('Stream started - received first chunk')) {
        const assistantName = getActivityAssistantName();
        setChannelActivity({
            phase: 'thinking',
            label: `${assistantName} is working`,
            detail: `${assistantName} started generating a response.`,
        });
        return;
    }
}

function pollClaudeDebugWatcher() {
    if (!claudeDebugFilePath) {
        return;
    }

    try {
        const stats = fs.statSync(claudeDebugFilePath);
        if (stats.size < claudeDebugReadOffset) {
            claudeDebugReadOffset = 0;
            claudeDebugLineBuffer = '';
        }

        if (stats.size === claudeDebugReadOffset) {
            return;
        }

        const length = stats.size - claudeDebugReadOffset;
        const fd = fs.openSync(claudeDebugFilePath, 'r');
        try {
            const buffer = Buffer.alloc(length);
            const bytesRead = fs.readSync(fd, buffer, 0, length, claudeDebugReadOffset);
            claudeDebugReadOffset += bytesRead;

            const chunk = claudeDebugLineBuffer + buffer.toString('utf8', 0, bytesRead);
            const lines = chunk.split(/\r?\n/);
            claudeDebugLineBuffer = lines.pop() || '';

            for (const line of lines) {
                if (line) {
                    handleClaudeDebugLine(line);
                }
            }
        } finally {
            fs.closeSync(fd);
        }
    } catch (error) {
        if (error.code !== 'ENOENT') {
            logDebug(`[CLAUDE] Failed reading debug log: ${error.message}`);
        }
    }
}

function startClaudeDebugWatcher(filePath) {
    stopClaudeDebugWatcher();
    claudeDebugFilePath = filePath;
    claudeDebugReadOffset = 0;
    claudeDebugLineBuffer = '';
    claudeDebugPollTimer = setInterval(pollClaudeDebugWatcher, 700);
    pollClaudeDebugWatcher();
}

function handleClaudeHookLine(line) {
    let event;
    try {
        event = JSON.parse(line);
    } catch (error) {
        return;
    }

    if (event.hookEventName === 'PreToolUse' || event.hookEventName === 'PostToolUse') {
        setChannelActivity(buildClaudeToolActivity(event), { force: true });
        return;
    }

    if (event.hookEventName === 'PostToolUseFailure') {
        setChannelActivity(buildClaudeToolFailureActivity(event), { force: true });
        return;
    }

    if (event.hookEventName === 'Stop') {
        const assistantName = getActivityAssistantName();
        clearChannelIdleTimer();
        channelReplyPending = false;
        setChannelActivity({
            phase: 'finished',
            label: `${assistantName} finished`,
            detail: `${assistantName} finished this turn.`,
            ts: event.ts || new Date().toISOString(),
            active: false,
        }, { force: true });
        return;
    }

    if (event.hookEventName === 'StopFailure') {
        const assistantName = getActivityAssistantName();
        clearChannelIdleTimer();
        channelReplyPending = false;
        setChannelActivity({
            phase: 'failed',
            label: `${assistantName} stopped with error`,
            detail: `${assistantName} ended the turn with ${event.error || 'an API error'}.`,
            ts: event.ts || new Date().toISOString(),
            active: false,
        }, { force: true });
    }
}

function pollClaudeHookWatcher() {
    if (!claudeHookFilePath) {
        return;
    }

    try {
        const stats = fs.statSync(claudeHookFilePath);
        if (stats.size < claudeHookReadOffset) {
            claudeHookReadOffset = 0;
            claudeHookLineBuffer = '';
        }

        if (stats.size === claudeHookReadOffset) {
            return;
        }

        const length = stats.size - claudeHookReadOffset;
        const fd = fs.openSync(claudeHookFilePath, 'r');
        try {
            const buffer = Buffer.alloc(length);
            const bytesRead = fs.readSync(fd, buffer, 0, length, claudeHookReadOffset);
            claudeHookReadOffset += bytesRead;

            const chunk = claudeHookLineBuffer + buffer.toString('utf8', 0, bytesRead);
            const lines = chunk.split(/\r?\n/);
            claudeHookLineBuffer = lines.pop() || '';

            for (const hookLine of lines) {
                if (hookLine) {
                    handleClaudeHookLine(hookLine);
                }
            }
        } finally {
            fs.closeSync(fd);
        }
    } catch (error) {
        if (error.code !== 'ENOENT') {
            logDebug(`[CLAUDE] Failed reading hook log: ${error.message}`);
        }
    }
}

function startClaudeHookWatcher(filePath) {
    stopClaudeHookWatcher();
    claudeHookFilePath = filePath;
    claudeHookReadOffset = 0;
    claudeHookLineBuffer = '';
    claudeHookPollTimer = setInterval(pollClaudeHookWatcher, 400);
    pollClaudeHookWatcher();
}

function setChannelRuntime(phase, detail, extra = {}) {
    const assistantName = getActivityAssistantName();
    const phaseConfig = {
        stopped: { level: 'red', label: 'Chat offline' },
        starting: { level: 'orange', label: `Starting ${assistantName}` },
        waiting_confirm: { level: 'orange', label: 'Waiting for confirmation' },
        waiting_bridge: { level: 'orange', label: 'Waiting for chat bridge' },
        retrying: { level: 'orange', label: 'Retrying chat startup' },
        ready: { level: 'green', label: 'Chat ready' },
        error: { level: 'red', label: 'Chat unavailable' },
    };

    channelRuntime = {
        ...channelRuntime,
        ...phaseConfig[phase],
        ...extra,
        phase,
        detail,
        claudeRunning: !!claudeProcess,
        bridgeConnected: !!(channelManager && channelManager.connected),
    };

    syncStateWithRenderer();
}

function getChannelStatus() {
    return {
        ...channelRuntime,
        assistantName: getActivityAssistantName(),
        claudeRunning: !!claudeProcess,
        bridgeConnected: !!(channelManager && channelManager.connected),
        socketExists: fs.existsSync(CHANNEL_IPC_PATH),
        activity: latestChannelActivity,
    };
}

function getTunnelHealth() {
    if (currentTunnelUrl) {
        return {
            level: 'green',
            label: 'Tunnel live',
            detail: `Remote clients can reach ${currentTunnelUrl}.`,
        };
    }

    if (isConnecting || tunnelProcess || server) {
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
    if (operatingMode === 'channel') {
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

function syncStateWithRenderer() {
    const state = getTunnelState();

    if (tray) {
        setTrayIconState(state.active);
        tray.setToolTip(formatTrayTooltip(state));
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('SYNC_STATE', state);
    }

    if (localChatWindow && !localChatWindow.isDestroyed()) {
        localChatWindow.webContents.send('SYNC_STATE', state);
    }

    for (const client of activeClients) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
                type: 'system_status',
                state,
            }));
        }
    }
}

function setTrayIconState(isActive) {
    if (!tray) {
        return;
    }

    const iconName = isActive ? 'tray_icon_active.png' : 'tray_iconTemplate.png';
    const iconPath = path.join(__dirname, iconName);
    tray.setImage(iconPath);
}

function getTunnelState() {
    // Active requires both server running AND tunnel established (has URL or process)
    const active = !!(server && (currentTunnelUrl || tunnelProcess));
    const tunnelHealth = getTunnelHealth();
    const channelHealth = getChannelStatus();
    return {
        active,
        connecting: isConnecting,
        url: currentTunnelUrl || '',
        fingerprint: currentFingerprint,
        sessionStartedAt: currentSessionStartedAt,
        mode: operatingMode,
        channelConnected: !!(channelManager && channelManager.connected),
        update: getUpdateState(),
        health: {
            overall: getOverallHealth(tunnelHealth, channelHealth),
            tunnel: tunnelHealth,
            channel: channelHealth,
        },
    };
}

function getUpdateInstallGate() {
    const reasons = [];

    if (isConnecting || currentTunnelUrl || tunnelProcess) {
        reasons.push('the tunnel is active');
    }

    if (operatingMode === 'channel' && (channelReplyPending || latestChannelActivity)) {
        reasons.push(`${getActivityAssistantName()} is active`);
    }

    if (scheduler) {
        const runningJobs = scheduler.listJobs().filter(job => job.running);
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
    const base = updater
        ? updater.getState()
        : defaultUpdateState({ packaged: app.isPackaged });
    const activeVersion = base.downloadedVersion || base.availableVersion || '';
    const dismissedVersion = store?.get(UPDATE_BANNER_DISMISSED_VERSION_KEY) || '';

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

function dismissUpdateBanner(version) {
    const targetVersion = version || getUpdateState().downloadedVersion || getUpdateState().availableVersion;
    if (!store || !targetVersion) {
        return { success: false, error: 'No update banner is available to dismiss.' };
    }

    store.set(UPDATE_BANNER_DISMISSED_VERSION_KEY, targetVersion);
    syncStateWithRenderer();
    return { success: true, version: targetVersion };
}

// About window reference
let aboutWindow = null;

function showAboutWindow() {
    if (aboutWindow) {
        aboutWindow.focus();
        return;
    }

    aboutWindow = new BrowserWindow({
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
            contextIsolation: true
        }
    });

    const iconPath = path.join(__dirname, 'public', 'icon-512-v3.png');
    const iconBase64 = fs.readFileSync(iconPath).toString('base64');
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
                font-size: 11px;
                color: rgba(255,255,255,0.4);
            }
        </style>
    </head>
    <body>
        <img class="icon" src="data:image/png;base64,${iconBase64}" alt="Icon">
        <div class="name">Root_Operator</div>
        <div class="version">Version ${version}</div>
        <div class="tagline">Personal AI assistant for macOS powered by Claude Code channels</div>
        <a class="email" href="mailto:support@rootoperator.dev">support@rootoperator.dev</a>
        <div class="copyright">© 2026 Root Operator</div>
    </body>
    </html>
    `;

    aboutWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));

    aboutWindow.once('ready-to-show', () => {
        aboutWindow.show();
    });

    aboutWindow.on('closed', () => {
        aboutWindow = null;
    });
}

// Build tray context menu (shown on right-click)
// --- Claude Code lifecycle ---
function normalizeClaudeBootstrapText(text) {
    return text
        .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
}

function scheduleClaudeRestart(reason) {
    if (operatingMode !== 'channel' || isAppQuitting) {
        return;
    }

    clearChannelRestartTimer();
    setChannelRuntime('retrying', reason, { lastError: reason });
    if (channelReplyPending) {
        const assistantName = getActivityAssistantName();
        setChannelActivity({
            phase: 'retrying',
            label: `Restarting ${assistantName}`,
            detail: reason,
        }, { force: true });
    }

    channelRestartTimer = setTimeout(() => {
        channelRestartTimer = null;
        if (operatingMode !== 'channel' || isAppQuitting || claudeProcess) {
            return;
        }

        spawnClaudeCode();
        if (channelManager && !channelManager.connected) {
            channelManager.connect();
        }
    }, CHANNEL_RESTART_DELAY_MS);
}

function prepareClaudeWorkspaceRuntime() {
    const runtimeRootDir = isDev ? __dirname : __dirname.replace('app.asar', 'app.asar.unpacked');
    const bridgeFile = isDev ? 'channel-bridge.cjs' : 'channel-bridge.bundle.cjs';
    const bridgePath = path.join(runtimeRootDir, bridgeFile);
    const hookScriptPath = path.join(runtimeRootDir, 'claude-stop-hook.cjs');
    const {
        workspaceDir,
        runtimeDir,
        isFirstRun,
        repairedFiles,
        missingTemplateFiles,
    } = ensureWorkspace();
    ensureAttachmentsDir();
    const settingsPath = path.join(runtimeDir, 'root-operator-claude-settings.json');
    const debugFilePath = path.join(runtimeDir, 'claude-channel-debug.log');
    const hookLogPath = path.join(runtimeDir, 'claude-channel-hooks.jsonl');
    const systemPromptFile = writeSystemPromptFile();
    const hookCommand = `/usr/bin/env ELECTRON_RUN_AS_NODE=1 ${shellEscapeArg(process.execPath)} ${shellEscapeArg(hookScriptPath)}`;
    const projectMcpPath = writeProjectMcpConfig({
        command: process.execPath,
        args: [bridgePath],
        env: {
            ELECTRON_RUN_AS_NODE: '1',
            ROOT_OPERATOR_IPC: CHANNEL_IPC_PATH,
        },
    });

    fs.writeFileSync(settingsPath, JSON.stringify({
        hooks: {
            Stop: [
                {
                    hooks: [
                        {
                            type: 'command',
                            command: hookCommand,
                        },
                    ],
                },
            ],
            StopFailure: [
                {
                    hooks: [
                        {
                            type: 'command',
                            command: hookCommand,
                        },
                    ],
                },
            ],
            PreToolUse: [
                {
                    hooks: [
                        {
                            type: 'command',
                            command: hookCommand,
                        },
                    ],
                },
            ],
            PostToolUse: [
                {
                    hooks: [
                        {
                            type: 'command',
                            command: hookCommand,
                        },
                    ],
                },
            ],
            PostToolUseFailure: [
                {
                    hooks: [
                        {
                            type: 'command',
                            command: hookCommand,
                        },
                    ],
                },
            ],
        },
    }, null, 2));

    if (isFirstRun) {
        logDebug('[CLAUDE] First run — workspace seeded with identity templates');
    }

    if (repairedFiles.length > 0) {
        logDebug(`[WORKSPACE] Repaired missing files: ${repairedFiles.join(', ')}`);
    }

    if (missingTemplateFiles.length > 0) {
        logDebug(`[WORKSPACE] Missing bundled templates: ${missingTemplateFiles.join(', ')}`);
    }

    return {
        workspaceDir,
        runtimeDir,
        bridgePath,
        hookScriptPath,
        settingsPath,
        debugFilePath,
        hookLogPath,
        systemPromptFile,
        projectMcpPath,
        isFirstRun,
        repairedFiles,
        missingTemplateFiles,
    };
}

async function spawnClaudeCode() {
    if (claudeProcess) {
        logDebug('[CLAUDE] Already running, skipping spawn');
        return;
    }

    const assistantName = getActivityAssistantName();

    channelStartupAttempt += 1;
    clearChannelRestartTimer();
    clearChannelStartupTimer();
    clearChannelConfirmTimers();
    removeChannelSocket();
    resetChannelActivity();
    setChannelRuntime('starting', `Launching ${assistantName} for the chat channel.`, {
        attempt: channelStartupAttempt,
        lastError: '',
    });

    const {
        workspaceDir,
        settingsPath,
        debugFilePath,
        hookLogPath,
        systemPromptFile,
    } = prepareClaudeWorkspaceRuntime();


    logDebug('[CLAUDE] Spawning Claude Code via PTY...');
    try {
        fs.writeFileSync(debugFilePath, '');
        fs.writeFileSync(hookLogPath, '');
        startClaudeDebugWatcher(debugFilePath);
        startClaudeHookWatcher(hookLogPath);

        // Use node-pty (already in project) so Claude sees a real TTY
        // and shows its confirmation prompt properly
        claudeProcess = pty.spawn('claude', [
            '--dangerously-skip-permissions',
            '--debug-file', debugFilePath,
            '--settings', settingsPath,
            '--append-system-prompt-file', systemPromptFile,
            '--dangerously-load-development-channels', 'server:root-operator',
        ], {
            name: 'xterm-256color',
            cols: 80,
            rows: 24,
            cwd: workspaceDir,
            env: {
                ...process.env,
                ROOT_OPERATOR_IPC: CHANNEL_IPC_PATH,
                ROOT_OPERATOR_HOOK_LOG: hookLogPath,
            },
        });

        setChannelRuntime('waiting_confirm', `Waiting for ${assistantName} to confirm local development access.`, {
            attempt: channelStartupAttempt,
        });

        const sendConfirm = (chars, reason) => {
            if (!claudeProcess || (channelManager && channelManager.connected)) {
                return false;
            }

            try {
                claudeProcess.write(chars);
                logDebug(`[CLAUDE] ${reason}`);
                setChannelRuntime('waiting_bridge', `${assistantName} is running. Waiting for the chat bridge to come online.`, {
                    attempt: channelStartupAttempt,
                });
                return true;
            } catch (error) {
                logDebug(`[CLAUDE] Failed to send confirmation: ${error.message}`);
                return false;
            }
        };

        claudeProcess.on('data', (data) => {
            const text = data.toString();
            logDebug(`[CLAUDE] ${text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').substring(0, 200).trim()}`);

            const normalized = normalizeClaudeBootstrapText(text);
            const waitingForConfirmation =
                normalized.includes('entertoconfirm') ||
                normalized.includes('iamusingthisforlocaldevelopment') ||
                normalized.includes('1iamusingthisforlocaldevelopment');

            if (waitingForConfirmation) {
                sendConfirm('\r', 'Pressed Enter to confirm local development');
            }
        });

        // Keep nudging the confirmation flow until the bridge is actually connected.
        channelConfirmTimers = [
            setTimeout(() => sendConfirm('\r', 'Fallback Enter sent after 2s'), 2000),
            setTimeout(() => sendConfirm('\r', 'Second fallback Enter sent after 5s'), 5000),
            setTimeout(() => sendConfirm('1\r', 'Final fallback selection sent after 8s'), 8000),
        ];

        channelStartupTimer = setTimeout(() => {
            if (channelManager && channelManager.connected) {
                return;
            }

            const timeoutMessage = `${assistantName} never brought the chat bridge online.`;
            setChannelRuntime('error', timeoutMessage, {
                attempt: channelStartupAttempt,
                lastError: timeoutMessage,
            });

            if (claudeProcess) {
                logDebug('[CLAUDE] Startup timed out; terminating stuck process');
                claudeProcess.kill();
            } else {
                scheduleClaudeRestart('Chat bridge startup timed out. Retrying.');
            }
        }, CHANNEL_STARTUP_TIMEOUT_MS);

        claudeProcess.on('exit', (exitCode) => {
            logDebug(`[CLAUDE] Exited (code: ${exitCode})`);
            clearChannelStartupTimer();
            clearChannelConfirmTimers();
            stopClaudeDebugWatcher();
            stopClaudeHookWatcher();
            claudeProcess = null;
            removeChannelSocket();

            if (operatingMode === 'channel' && !isAppQuitting) {
                const exitMessage = exitCode === 0
                    ? `${assistantName} exited before the chat bridge was ready.`
                    : `${assistantName} exited with code ${exitCode}.`;
                setChannelRuntime('error', exitMessage, {
                    attempt: channelStartupAttempt,
                    lastError: exitMessage,
                });
                if (channelReplyPending) {
                    setChannelActivity({
                        phase: 'error',
                        label: `${assistantName} stopped`,
                        detail: exitMessage,
                    }, { force: true });
                } else {
                    resetChannelActivity();
                }
                scheduleClaudeRestart(`${assistantName} exited unexpectedly. Retrying.`);
                return;
            }

            resetChannelActivity();
            setChannelRuntime('stopped', `${assistantName} is not running.`);
        });
    } catch (err) {
        logDebug(`[CLAUDE] Failed to spawn: ${err.message}`);
        stopClaudeDebugWatcher();
        stopClaudeHookWatcher();
        claudeProcess = null;
        setChannelRuntime('error', `Failed to launch ${assistantName}: ${err.message}`, {
            attempt: channelStartupAttempt,
            lastError: err.message,
        });
        scheduleClaudeRestart(`Failed to launch ${assistantName}. Retrying.`);
    }
}

function killClaudeCode() {
    if (claudeProcess) {
        logDebug('[CLAUDE] Stopping Claude Code...');
        clearChannelStartupTimer();
        clearChannelConfirmTimers();
        stopClaudeDebugWatcher();
        stopClaudeHookWatcher();
        claudeProcess.kill();
    }
}

// --- Channel mode init (shared by startup and mode switch) ---
function initChannelMode() {
    clearChannelRestartTimer();

    // Clean up any existing channel state
    if (channelManager) {
        channelManager.disconnect();
        channelManager = null;
    }

    // Connect to channel bridge IPC
    channelManager = new ChannelManager();

    channelManager.on('claude_reply', (reply) => {
        const msg = {
            type: 'channel_message',
            role: 'assistant',
            content: reply.text,
            ts: reply.ts || new Date().toISOString(),
        };

        // Store in history (file-backed)
        chatStore.addMessage({ role: msg.role, content: msg.content, ts: msg.ts });

        if (dynamicMemory && dynamicMemory.isEnabled()) {
            const replyChatId = reply.chat_id || reply.chatId || null;
            dynamicMemory.indexMessage('assistant', msg.content, replyChatId).catch((err) => {
                logDebug(`[MEMORY] Index (assistant) error: ${err.message}`);
            });
        }

        // Send to all connected clients
        for (const client of activeClients) {
            if (client.readyState === WebSocket.OPEN) {
                sendEncryptedOutput(client, JSON.stringify(msg));
            }
        }

        sendLocalChatEvent(msg);
        notifyAssistantReply(msg);
        scheduleChannelIdle();
    });

    channelManager.on('connected', () => {
        const assistantName = getActivityAssistantName();
        logDebug('[CHANNEL] Bridge connected');
        clearChannelStartupTimer();
        clearChannelConfirmTimers();
        setChannelRuntime('ready', `${assistantName} is connected and ready to send replies.`, {
            attempt: channelStartupAttempt,
            lastError: '',
        });
    });

    channelManager.on('disconnected', () => {
        if (operatingMode !== 'channel' || isAppQuitting) {
            return;
        }

        const assistantName = getActivityAssistantName();
        const detail = claudeProcess
            ? `The chat bridge dropped. Waiting for ${assistantName} to bring it back.`
            : `The chat bridge dropped because ${assistantName} is no longer running.`;

        setChannelRuntime('waiting_bridge', detail, {
            attempt: channelStartupAttempt,
        });

        if (channelReplyPending) {
            setChannelActivity({
                phase: 'waiting_bridge',
                label: 'Waiting for bridge',
                detail,
            }, { force: true });
        }
    });

    channelManager.on('reconnecting', () => {
        if (operatingMode !== 'channel' || isAppQuitting) {
            return;
        }

        setChannelRuntime('retrying', 'Trying to reconnect the chat bridge.', {
            attempt: channelStartupAttempt,
        });

        if (channelReplyPending) {
            setChannelActivity({
                phase: 'retrying',
                label: 'Reconnecting bridge',
                detail: `Trying to reconnect the ${getActivityAssistantName()} chat bridge.`,
            }, { force: true });
        }
    });

    channelManager.on('socket_error', (error) => {
        if (operatingMode !== 'channel' || isAppQuitting) {
            return;
        }

        logDebug(`[CHANNEL] Socket error: ${error.message}`);
    });

    channelManager.on('claude_activity', (activity) => {
        if (operatingMode !== 'channel' || !activity) {
            return;
        }

        if (activity.phase === 'forwarded') {
            const assistantName = getActivityAssistantName();
            setChannelActivity({
                phase: 'forwarded',
                label: `Delivered to ${assistantName}`,
                detail: `The chat bridge handed your message to ${assistantName}.`,
                ts: activity.ts,
            }, { force: true });
            return;
        }

        if (activity.phase === 'replying') {
            const assistantName = getActivityAssistantName();
            setChannelActivity({
                phase: 'replying',
                label: `${assistantName} is sending the reply`,
                detail: `${assistantName} is sending the final answer back to chat.`,
                ts: activity.ts,
                toolName: activity.toolName,
            }, { force: true });
            return;
        }

        setChannelActivity(activity);
    });

    channelManager.on('scheduler_request', (req) => {
        handleSchedulerRequest(req);
    });

    channelManager.connect();

    // ClaudeSessionSupervisor (PR1 observe-only).
    // Initialized best-effort; if setup fails, scheduler falls back to the
    // legacy direct-send path. See PR1_PLAN.md + design doc v4 for context.
    supervisor = null;
    try {
        const homeDir = app.getPath('home');
        const supervisorRuntimeDir = path.join(homeDir, '.root-operator', 'runtime');
        const brainDir = path.join(WORKSPACE_DIR, 'brain');
        fs.mkdirSync(brainDir, { recursive: true });
        fs.mkdirSync(supervisorRuntimeDir, { recursive: true });

        supervisorStore = new SupervisorDispatchStore(path.join(brainDir, 'claude-supervisor.db'));
        const supervisorRuntime = new SupervisorRuntime({
            store: supervisorStore,
            runtimeDir: supervisorRuntimeDir,
        });
        const supervisorEpoch = supervisorRuntime.incrementEpoch();
        const supervisorIncidents = new SupervisorIncidentLogger({
            store: supervisorStore,
            jsonlPath: path.join(supervisorRuntimeDir, 'supervisor-incidents.jsonl'),
        });
        // PR1: tail the existing stable-named hook log that spawnClaudeCode()
        // writes to. Epoch-scoped paths are available via
        // supervisorRuntime.resolveEpochPaths() but wiring spawnClaudeCode()
        // to use them is deferred to PR4.
        const supervisorHookLog = path.join(supervisorRuntimeDir, 'claude-channel-hooks.jsonl');
        supervisor = createSupervisor({
            store: supervisorStore,
            runtime: supervisorRuntime,
            incidents: supervisorIncidents,
            channelManager,
            hookLogPath: supervisorHookLog,
        });
        supervisor.start().catch((err) => {
            logDebug(`[SUPERVISOR] start failed: ${err.message}`);
            supervisor = null;
        });
        logDebug(`[SUPERVISOR] observe-only mode active, epoch=${supervisorEpoch}`);
    } catch (err) {
        logDebug(`[SUPERVISOR] init failed: ${err.message} — scheduler will use legacy path`);
        supervisor = null;
        if (supervisorStore) {
            try { supervisorStore.close(); } catch { /* ignore */ }
            supervisorStore = null;
        }
    }

    // Start persistent scheduler (survives session rotation)
    if (store) {
        scheduler = new Scheduler(store, channelManager, supervisor);
        scheduler.start();
    }

    // Spawn Claude Code (auto-approves channel confirmation prompt)
    spawnClaudeCode();
}

async function handleSchedulerRequest(req) {
    if (!scheduler) {
        channelManager?.sendSchedulerResponse(req.callId, 'Scheduler not initialized', true);
        return;
    }

    try {
        let result;
        switch (req.tool) {
            case 'ro_schedule':
                const created = await scheduler.addJob({
                    name: req.args.name,
                    cronExpr: req.args.cron,
                    prompt: req.args.prompt,
                    chatId: req.args.chat_id,
                });
                result = `Job created: "${created.name}" (${created.id})\nSchedule: ${created.cron}\nNext fire at the scheduled time.`;
                break;

            case 'ro_list_schedules':
                const jobs = scheduler.listJobs();
                if (jobs.length === 0) {
                    result = 'No scheduled jobs.';
                } else {
                    result = jobs.map(j => {
                        let status = j.enabled ? '●' : '○';
                        if (j.running) status = '▶';
                        let line = `${status} ${j.name} (${j.id})`;
                        line += `\n  Schedule: ${j.cron}`;
                        line += `\n  Last run: ${j.lastRun || 'never'}`;
                        if (j.lastResult) line += ` (${j.lastResult})`;
                        if (j.lastError) line += `\n  Last error: ${j.lastError}`;
                        if (j.consecutiveErrors > 0) line += `\n  Consecutive errors: ${j.consecutiveErrors}`;
                        line += `\n  Prompt: ${j.prompt}`;
                        return line;
                    }).join('\n\n');
                }
                break;

            case 'ro_delete_schedule':
                await scheduler.removeJob(req.args.id);
                result = `Job ${req.args.id} deleted.`;
                break;

            case 'ro_toggle_schedule':
                const toggled = await scheduler.toggleJob(req.args.id, req.args.enabled);
                result = `Job "${toggled.name}" is now ${toggled.enabled ? 'enabled' : 'disabled'}.`;
                break;

            case 'ro_run_now':
                await scheduler.runNow(req.args.id);
                result = `Job ${req.args.id} triggered manually.`;
                break;

            default:
                result = `Unknown scheduler tool: ${req.tool}`;
        }

        channelManager?.sendSchedulerResponse(req.callId, result, false);
    } catch (error) {
        channelManager?.sendSchedulerResponse(req.callId, `Error: ${error.message}`, true);
    }
}

function teardownChannelMode() {
    clearChannelRestartTimer();
    clearChannelStartupTimer();
    clearChannelConfirmTimers();
    clearChannelIdleTimer();
    // Stop scheduler timers (jobs persist in store for next startup)
    if (scheduler) {
        scheduler.stopAll();
        scheduler = null;
    }
    // Only kill Claude if we spawned it
    if (claudeProcess) killClaudeCode();
    if (channelManager) {
        channelManager.disconnect();
        channelManager = null;
    }
    removeChannelSocket();
    stopClaudeDebugWatcher();
    stopClaudeHookWatcher();
    channelStartupAttempt = 0;
    resetChannelActivity();
    setChannelRuntime('stopped', 'Chat mode is not active.');
    // History intentionally NOT cleared — persists across tunnel restarts
}

// --- Channel mode switching ---
function setOperatingMode(mode) {
    if (mode === operatingMode) return;
    operatingMode = mode;
    logDebug(`[MODE] Switching to ${mode} mode`);

    if (mode === 'channel') {
        // Stop PTY if running — channel mode doesn't use it
        if (ptyProcess) {
            ptyProcess.kill();
            ptyProcess = null;
            outputBuffer = '';
        }
        initChannelMode();
    } else {
        // Switch back to terminal mode
        teardownChannelMode();
        // Spawn PTY for already-connected clients
        if (activeClients.size > 0 && !ptyProcess) {
            const firstClient = activeClients.values().next().value;
            startPty(firstClient);
        }
    }

    // Notify connected PWA clients of mode change (plain message, non-sensitive)
    for (const client of activeClients) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
                type: 'operating_mode',
                mode: operatingMode,
            }));
        }
    }

    // Tray menu is built on right-click, no need to update here

    // Notify renderer of mode change
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('SYNC_STATE', getTunnelState());
    }
}

function buildTrayMenu() {
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
        { label: 'Website', click: () => shell.openExternal('https://rootoperator.dev') },
        { type: 'separator' },
        { label: 'Quit', click: () => app.quit() }
    ];

    return Menu.buildFromTemplate(menuItems);
}

app.whenReady().then(async () => {
    console.log('App Ready');
    applyDevDockIcon();
    app.setActivationPolicy('accessory');
    if (app.dock) app.dock.hide();

    // Remove default application menu (tray-only app)
    Menu.setApplicationMenu(null);

    const { default: ES } = await import('electron-store');
    store = new ES();
    try {
        desktopIdentityKeyPair = getOrCreateDesktopIdentityKeyPair();
        if (desktopIdentityKeyPair) {
            logDebug('[E2E] Desktop identity keypair ready');
        }
    } catch (error) {
        desktopIdentityKeyPair = null;
        logDebug(`[E2E] FATAL: failed to initialize desktop identity keypair: ${error.message}`);
    }
    configureWebPush();
    logFile = path.join(app.getPath('userData'), 'pocket_bridge_debug.log');
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

    await fixPath();

    try {
        const { missingTemplateFiles } = ensureWorkspace();
        if (missingTemplateFiles.length > 0) {
            console.warn(`[WORKSPACE] Missing bundled templates: ${missingTemplateFiles.join(', ')}`);
        }
    } catch (error) {
        console.error(`[WORKSPACE] Failed to prepare workspace: ${error.message}`);
        logDebug(`[WORKSPACE] Startup preparation failed: ${error.message}`);
    }

    const { chatHistoryPath } = ensureWorkspaceChatHistory();
    chatStore = new ChatStore(path.dirname(chatHistoryPath), path.basename(chatHistoryPath));
    try {
        const historyCount = chatStore.loadMessages().length;
        logDebug(`[CHAT] History store ready: ${chatStore.filePath} (${historyCount} messages)`);
    } catch (error) {
        logDebug(`[CHAT] Failed to read history store: ${error.message}`);
    }

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

    createWindow();
    createTray();
    registerGlobalShortcuts();
    initDoubleShiftShortcut(() => {
        toggleLocalChatWindow();
    });
    updater.start();
});

app.on('activate', () => {
    if (localChatWindow && !localChatWindow.isDestroyed()) {
        localChatWindow.show();
        localChatWindow.focus();
        syncDockVisibility();
        return;
    }

    if (mainWindow && !mainWindow.isDestroyed() && !tray) {
        mainWindow.show();
        mainWindow.focus();
        syncDockVisibility();
    }
});

app.on('will-quit', () => {
    cachedPushVapidKeys = null;
    globalShortcut.unregisterAll();
    stopDoubleShiftShortcut();
});

app.on('will-quit', () => {
    cachedDesktopIdentityKeyPair = undefined;
    desktopIdentityKeyPair = null;
});

// 2. IPC API (Frontend -> Backend)
ipcMain.handle('START', async (event, cfSettings) => {
    try {
        await startBridge(cfSettings);
        return { success: true };
    } catch (e) {
        stopBridge();
        return { success: false, error: e.message };
    }
});

ipcMain.handle('GET_STORE', (event, key) => store.get(key));
ipcMain.handle('SET_STORE', (event, key, val) => {
    store.set(key, val);
    if (key === 'cfSettings') {
        syncStateWithRenderer();
    }
    return true;
});

// Authoritative tunnel state - renderer requests this on mount to avoid race conditions
ipcMain.handle('GET_TUNNEL_STATE', () => getTunnelState());
ipcMain.handle('GET_UPDATE_STATE', () => getUpdateState());
ipcMain.handle('CHECK_FOR_UPDATES', async () => {
    if (!updater) {
        return { started: false, reason: 'Updater not initialized' };
    }
    return updater.checkForUpdates('manual');
});
ipcMain.handle('OPEN_LOCAL_CHAT_WINDOW', () => {
    createLocalChatWindow();
    return { success: true };
});
ipcMain.handle('GET_LOCAL_CHAT_STATE', () => getLocalChatState());
ipcMain.handle('SEND_LOCAL_CHAT_MESSAGE', async (event, text) => {
    if (typeof text !== 'string' || !text.trim()) {
        return { success: false, error: 'Message is empty' };
    }

    return await submitChannelUserMessage('desktop-local', text.trim(), 'desktop-local');
});
ipcMain.handle('SEND_LOCAL_CHAT_FILE', async (event, { data, filename, mimeType, caption }) => {
    if (!data || !filename) {
        return { success: false, error: 'Missing file data or filename' };
    }

    const fileBuffer = Buffer.from(data);

    if (fileBuffer.length === 0) {
        return { success: false, error: 'File is empty' };
    }

    if (fileBuffer.length > MAX_FILE_SIZE) {
        return { success: false, error: `File too large (max ${MAX_FILE_SIZE / 1024 / 1024} MB)` };
    }

    // Sanitize filename
    const sanitized = path.basename(filename).replace(/[^a-zA-Z0-9._\- ]/g, '_');
    if (!sanitized || sanitized === '.' || sanitized === '..') {
        return { success: false, error: 'Invalid filename' };
    }

    if (BLOCKED_FILE_EXTENSIONS.test(sanitized)) {
        return { success: false, error: 'File type not allowed' };
    }

    ensureAttachmentsDir();
    let finalName = sanitized;
    let destPath = path.join(ATTACHMENTS_DIR, finalName);

    // Path traversal check
    const resolved = path.resolve(destPath);
    if (!resolved.startsWith(ATTACHMENTS_DIR + path.sep) && resolved !== ATTACHMENTS_DIR) {
        return { success: false, error: 'Invalid file path' };
    }

    // Collision handling
    if (fs.existsSync(destPath)) {
        const ext = path.extname(sanitized);
        const base = path.basename(sanitized, ext);
        let counter = 2;
        while (fs.existsSync(destPath)) {
            finalName = `${base}-${counter}${ext}`;
            destPath = path.join(ATTACHMENTS_DIR, finalName);
            counter++;
        }
    }

    try {
        fs.writeFileSync(destPath, fileBuffer);
        logDebug(`[ATTACH] Desktop local file saved: ${finalName} (${fileBuffer.length} bytes)`);
    } catch (e) {
        return { success: false, error: `Failed to save: ${e.message}` };
    }

    const parts = [];
    if (caption) {
        parts.push(caption);
    }
    parts.push(`[File attached: ${filename}]\nSaved to: ${destPath}`);
    return await submitChannelUserMessage('desktop-local', parts.join('\n\n'), 'desktop-local');
});
ipcMain.handle('TOGGLE_LOCAL_CHAT_ALWAYS_ON_TOP', () => {
    if (!localChatWindow || localChatWindow.isDestroyed()) {
        return { success: false, error: 'Local chat window is not open' };
    }

    const next = !localChatWindow.isAlwaysOnTop();
    localChatWindow.setAlwaysOnTop(next, next ? 'floating' : 'normal');
    if (next) {
        localChatWindow.moveTop();
        localChatWindow.focus();
    }
    return { success: true, alwaysOnTop: next };
});
ipcMain.handle('INSTALL_UPDATE', async () => {
    if (!updater) {
        return { success: false, error: 'Updater not initialized' };
    }
    return updater.installDownloadedUpdate();
});
ipcMain.handle('DISMISS_UPDATE_BANNER', (event, version) => dismissUpdateBanner(version));

ipcMain.handle('GET_DYNAMIC_MEMORY_ENABLED', () => {
    return dynamicMemory ? dynamicMemory.isEnabled() : false;
});

ipcMain.handle('SET_DYNAMIC_MEMORY_ENABLED', (event, enabled) => {
    if (!dynamicMemory) return { success: false, error: 'Dynamic memory not initialized' };
    dynamicMemory.setEnabled(Boolean(enabled));
    return { success: true, enabled: dynamicMemory.isEnabled() };
});

ipcMain.handle('SET_OPERATING_MODE', (event, mode) => {
    if (mode !== 'terminal' && mode !== 'channel') {
        return { success: false, error: 'Invalid mode' };
    }
    setOperatingMode(mode);
    return { success: true, mode: operatingMode };
});

ipcMain.handle('GET_OPERATING_MODE', () => operatingMode);

ipcMain.handle('STOP', () => {
    stopBridge();
    return { success: true };
});

ipcMain.on('QUIT', () => {
    isAppQuitting = true;
    stopBridge();
    app.quit();
});

ipcMain.handle('RESIZE_WINDOW', (event, height) => {
    if (mainWindow) {
        const nextHeight = Math.max(1, Math.min(500, Math.ceil(height)));
        const [currentWidth, currentHeight] = mainWindow.getContentSize();

        if (currentHeight !== nextHeight) {
            mainWindow.setContentSize(currentWidth, nextHeight, false);
        }
    }
    return { success: true };
});

ipcMain.handle('SET_TRAY_ICON', (event, isActive) => {
    setTrayIconState(isActive);
    return { success: true };
});

// Secure credential storage using OS keychain
ipcMain.handle('GET_SECURE_TOKEN', async () => {
    try {
        const token = await keytar.getPassword(KEYTAR_SERVICE, KEYTAR_CF_TOKEN);
        return token || '';
    } catch (e) {
        console.error('Failed to get secure token:', e.message);
        return '';
    }
});

ipcMain.handle('SET_SECURE_TOKEN', async (event, token) => {
    try {
        if (token) {
            await keytar.setPassword(KEYTAR_SERVICE, KEYTAR_CF_TOKEN, token);
        } else {
            await keytar.deletePassword(KEYTAR_SERVICE, KEYTAR_CF_TOKEN);
        }
        return { success: true };
    } catch (e) {
        console.error('Failed to set secure token:', e.message);
        return { success: false, error: e.message };
    }
});

ipcMain.handle('DELETE_SECURE_TOKEN', async () => {
    try {
        await keytar.deletePassword(KEYTAR_SERVICE, KEYTAR_CF_TOKEN);
        return { success: true };
    } catch (e) {
        console.error('Failed to delete secure token:', e.message);
        return { success: false, error: e.message };
    }
});

// Subdomain customization
ipcMain.handle('CUSTOMIZE_SUBDOMAIN', async (event, newSubdomain) => {
    console.log('[SUBDOMAIN] CUSTOMIZE_SUBDOMAIN called with:', newSubdomain);

    // Check if tunnel is currently running BEFORE making any changes
    const wasTunnelRunning = !!(tunnelProcess && server);
    console.log('[SUBDOMAIN] Tunnel was running:', wasTunnelRunning);

    try {
        // If tunnel is running, stop it first
        if (wasTunnelRunning) {
            console.log('[SUBDOMAIN] Stopping tunnel before subdomain change...');
            stopBridge();
        }

        // Save the new subdomain via Worker API
        const result = await customizeSubdomain(newSubdomain);
        console.log('[SUBDOMAIN] customizeSubdomain result:', result);

        // If tunnel WAS running, restart it with new subdomain
        if (wasTunnelRunning) {
            console.log('[SUBDOMAIN] Restarting tunnel with new subdomain...');
            await startBridge({});
        }

        return { success: true, ...result };
    } catch (e) {
        console.error('Failed to customize subdomain:', e.message);
        return { success: false, error: e.message };
    }
});

// Get current subdomain
ipcMain.handle('GET_SUBDOMAIN', () => {
    return store.get('tunnelSubdomain') || null;
});

// Get machine ID (for display in settings)
ipcMain.handle('GET_MACHINE_ID', () => {
    return getMachineId();
});

// Logging with rotation and sensitive data redaction
const LOG_MAX_SIZE = 1024 * 1024; // 1MB max log size
const LOG_MAX_FILES = 3; // Keep 3 rotated files
let logFile;

function isDebugLoggingEnabled() {
    if (!store) return false;
    const settings = store.get('cfSettings', {});
    return settings.debugLogging === true;
}

function rotateLogIfNeeded() {
    try {
        if (!logFile || !fs.existsSync(logFile)) return;

        const stats = fs.statSync(logFile);
        if (stats.size < LOG_MAX_SIZE) return;

        // Rotate existing logs
        for (let i = LOG_MAX_FILES - 1; i >= 1; i--) {
            const oldFile = `${logFile}.${i}`;
            const newFile = `${logFile}.${i + 1}`;
            if (fs.existsSync(oldFile)) {
                if (i === LOG_MAX_FILES - 1) {
                    fs.unlinkSync(oldFile); // Delete oldest
                } else {
                    fs.renameSync(oldFile, newFile);
                }
            }
        }

        // Rotate current log
        fs.renameSync(logFile, `${logFile}.1`);
    } catch (e) {
        // Ignore rotation errors
    }
}

function logDebug(msg, metadata) {
    // Only write to file if debug logging is enabled
    if (isDebugLoggingEnabled() && logFile) {
        rotateLogIfNeeded();
        const time = new Date().toISOString();
        let metadataSuffix = '';
        if (metadata !== undefined) {
            try {
                metadataSuffix = ` ${JSON.stringify(metadata)}`;
            } catch {
                metadataSuffix = ' {"logMetadata":"unserializable"}';
            }
        }
        const line = `[${time}] ${msg}${metadataSuffix}\n`;
        try {
            fs.appendFileSync(logFile, line);
        } catch (e) {
            // Ignore write errors
        }
    }
}

// 3. BRIDGE LOGIC

function getHostnameFromUrl(url, label) {
    if (!url || typeof url !== 'string') {
        return null;
    }

    try {
        return new URL(url).hostname.toLowerCase();
    } catch (error) {
        logDebug(`[SECURITY] Failed to parse ${label}: ${error.message}`);
        return null;
    }
}

// Allowed origins for WebSocket connections
// In production with Cloudflare tunnel, origin will be the tunnel URL
function isOriginAllowed(origin, cfSettings) {
    // SECURITY: Reject null/empty origins in production
    // Null origins can come from: file:// URLs, proxies stripping headers, CLI tools
    // Only allow in development mode for easier testing
    if (!origin) {
        if (isDev) {
            logDebug('[SECURITY] Allowing null origin in development mode');
            return true;
        }
        logDebug('[SECURITY] Rejecting null origin in production mode');
        return false;
    }

    let originUrl;
    try {
        originUrl = new URL(origin);
    } catch (error) {
        logDebug(`[SECURITY] Rejecting malformed origin: ${origin}`);
        return false;
    }

    const originHost = originUrl.hostname.toLowerCase();

    // Allow localhost for local development
    if (originHost === 'localhost' || originHost === '127.0.0.1') {
        return true;
    }

    const allowedHosts = new Set();
    const activeTunnelHost = getHostnameFromUrl(currentTunnelUrl, 'current tunnel URL');
    if (activeTunnelHost) {
        allowedHosts.add(activeTunnelHost);
    }

    if (cfSettings && cfSettings.domain) {
        const normalizedDomain = cfSettings.domain.startsWith('http')
            ? cfSettings.domain
            : `https://${cfSettings.domain}`;
        const configuredHost = getHostnameFromUrl(normalizedDomain, 'configured domain');
        // SECURITY: Trust a custom domain only while it is the live bridge hostname for this session.
        if (configuredHost && configuredHost === activeTunnelHost) {
            allowedHosts.add(configuredHost);
        }
    }

    return allowedHosts.has(originHost);
}

async function startBridge(cfSettings) {
    isConnecting = true;
    syncStateWithRenderer();

    // Store only the configured settings; live origin trust comes from currentTunnelUrl.
    const storedCfSettings = { ...(cfSettings || {}) };

    // A. Start HTTP/WebSocket Server
    server = http.createServer((req, res) => servePWA(req, res));

    // WebSocket server with origin verification and payload limits
    // SECURITY: maxPayload prevents DoS attacks via large messages
    // 1MB supports file attachment chunks (512KB plaintext → ~700KB base64 + JSON envelope)
    // Using noServer: true to manually handle upgrades (needed for Vite HMR proxy in dev)
    wss = new WebSocket.Server({
        noServer: true,
        maxPayload: 1024 * 1024 // 1MB max message size (covers file chunks + overhead)
    });

    wss.on('connection', (ws, req) => handleConnection(ws, req));

    // Handle WebSocket upgrades manually
    server.on('upgrade', (req, socket, head) => {
        const pathname = req.url;

        // In dev mode, proxy Vite HMR WebSocket requests to Vite dev server
        // Vite is configured to use /__vite_hmr path for HMR WebSocket
        if (isDev && pathname && pathname.startsWith('/__vite_hmr')) {
            const viteSocket = net.connect(VITE_CLIENT_PORT, 'localhost', () => {
                // Forward the original upgrade request to Vite
                const headers = Object.entries(req.headers)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join('\r\n');
                viteSocket.write(
                    `GET ${pathname} HTTP/1.1\r\n` +
                    `Host: localhost:${VITE_CLIENT_PORT}\r\n` +
                    `${headers}\r\n` +
                    `\r\n`
                );
                // Pipe data bidirectionally
                socket.pipe(viteSocket);
                viteSocket.pipe(socket);
            });
            viteSocket.on('error', () => socket.destroy());
            socket.on('error', () => viteSocket.destroy());
            return;
        }

        // Regular WebSocket: verify origin and handle with wss
        const origin = req.headers.origin;
        if (!isOriginAllowed(origin, storedCfSettings)) {
            logDebug(`[SECURITY] Rejected WebSocket from unauthorized origin: ${origin}`);
            socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
            socket.destroy();
            return;
        }

        wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit('connection', ws, req);
        });
    });

    // SECURITY: keep the bridge off LAN interfaces; only the local tunnel should reach it.
    server.listen(INTERNAL_PORT, '127.0.0.1');

    // Initialize channel mode if that's the default
    if (operatingMode === 'channel') {
        initChannelMode();
    }

    // B. Start Tunnel - Use Worker API to get dedicated tunnel
    let tunnelToken = null;
    let tunnelHostname = null;

    // Try to get tunnel from Worker API
    try {
        console.log('Requesting tunnel from Worker API...');
        const tunnelInfo = await requestTunnelFromWorker();
        tunnelToken = tunnelInfo.tunnelToken;
        tunnelHostname = tunnelInfo.hostname;
        console.log(`Tunnel assigned: ${tunnelHostname}`);
    } catch (workerError) {
        console.log('Worker API unavailable:', workerError.message);

        // Try cached credentials (offline mode)
        const cached = await getCachedTunnelCredentials();
        if (cached) {
            console.log('Using cached tunnel credentials');
            tunnelToken = cached.tunnelToken;
            tunnelHostname = cached.hostname;
            // Notify UI about offline mode
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('CF_LOG', 'Using cached tunnel (offline mode)');
            }
        }
    }

    // Start tunnel with Worker-assigned token, or fall back to Quick Tunnel
    if (tunnelToken) {
        // Worker-assigned tunnel
        console.log('Starting Worker-assigned tunnel...');
        tunnelProcess = cloudflared.tunnel({ '--token': tunnelToken });

        // Notify UI with the hostname immediately
        if (tunnelHostname) {
            const url = `https://${tunnelHostname}`;
            currentTunnelUrl = url;
            const currentProcess = tunnelProcess; // Capture reference for callback
            setTimeout(() => {
                // Only update if this is still the active tunnel (handles rapid start/stop)
                if (tunnelProcess === currentProcess && isConnecting) {
                    isConnecting = false;
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('TUNNEL_LIVE', url);
                    }
                }
            }, 1000);
        }
    } else if (cfSettings && cfSettings.token) {
        // Legacy: Stable Tunnel with user-provided Token
        console.log('Starting Stable Tunnel with user token...');
        tunnelProcess = cloudflared.tunnel({ '--token': cfSettings.token });

        if (cfSettings.domain) {
            const url = cfSettings.domain.startsWith('http') ? cfSettings.domain : `https://${cfSettings.domain}`;
            currentTunnelUrl = url;
            const currentProcess = tunnelProcess; // Capture reference for callback
            setTimeout(() => {
                // Only update if this is still the active tunnel (handles rapid start/stop)
                if (tunnelProcess === currentProcess && isConnecting) {
                    isConnecting = false;
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('TUNNEL_LIVE', url);
                    }
                }
            }, 1000);
        }
    } else {
        // Quick Tunnel Fallback (trycloudflare.com)
        console.log('Starting Quick Tunnel (fallback)...');
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('CF_LOG', 'Worker unavailable - using temporary Quick Tunnel');
        }
        tunnelProcess = cloudflared.tunnel(['tunnel', '--url', `localhost:${INTERNAL_PORT}`]);
    }

    tunnelProcess.on('url', (url) => {
        logDebug(`[CF] Tunnel Live: ${url}`);
        currentTunnelUrl = url;
        isConnecting = false;
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('TUNNEL_LIVE', url);
        }
    });

    tunnelProcess.on('stdout', (data) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('CF_LOG', data.toString());
        }
        checkManualUrl(data);
    });

    tunnelProcess.on('stderr', (data) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('CF_LOG', data.toString());
        }
        checkManualUrl(data);
    });

    tunnelProcess.on('error', (err) => {
        logDebug(`[CF] Tunnel Error: ${err}`);
        isConnecting = false;
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('CF_LOG', 'ERR: ' + err.toString());
            syncStateWithRenderer();
        }
    });

    // Handle tunnel process exit (crash or unexpected termination)
    tunnelProcess.on('close', (code) => {
        logDebug(`[CF] Tunnel process exited with code: ${code}`);
        // Only clean up if this is still the active tunnel process
        if (tunnelProcess) {
            isConnecting = false;
            currentTunnelUrl = null;
            tunnelProcess = null;
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('CF_LOG', `Tunnel exited (code: ${code})`);
                syncStateWithRenderer();
            }
        }
    });

    // C. Prevent Sleep
    wakeLock = spawn('caffeinate', ['-s']);
}

function stopBridge() {
    logDebug('[SYSTEM] Stopping Bridge...');
    try {
        if (tunnelProcess) {
            // Remove all listeners to prevent "Object destroyed" errors during shutdown
            tunnelProcess.removeAllListeners();
            if (typeof tunnelProcess.stop === 'function') {
                tunnelProcess.stop();
            } else if (tunnelProcess.kill) {
                tunnelProcess.kill();
            }
        }
    } catch (e) {
        logDebug('[SYSTEM] Error stopping tunnel: ' + e.message);
    }

    try {
        if (wakeLock) wakeLock.kill();
        if (server) server.close();
        if (ptyProcess) {
            ptyProcess.kill();
            ptyProcess = null;
        }
        teardownChannelMode();
    } catch (e) {
        logDebug('[SYSTEM] Error during cleanup: ' + e.message);
    }

    tunnelProcess = null;
    wakeLock = null;
    server = null;
    wss = null;
    ptyProcess = null;
    outputBuffer = "";
    activeClients.clear();
    pendingPairings.clear();
    currentTunnelUrl = null;
    currentFingerprint = null;
    currentSessionStartedAt = null;
    isConnecting = false;
    // Don't reset operatingMode — preserve user's choice across bridge restarts
    logDebug('[SYSTEM] Bridge stopped.');
    syncStateWithRenderer();
}

// 4. CONNECTION HANDLER (The Auth Logic)

// Security: Rate limiting and connection tracking
const CHALLENGE_EXPIRY_MS = 30000; // Challenge expires after 30 seconds
const MAX_CONNECTIONS_PER_MINUTE = 20;
const MAX_CONNECTIONS_PER_SOURCE_PER_MINUTE = 10;
const MAX_AUTH_ATTEMPTS_PER_CONNECTION = 3;
const MAX_INPUT_SIZE = 131072; // Max bytes per input message (128KB)
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB max file upload
const MAX_FILE_CHUNK_SIZE = 512 * 1024; // must match client CHUNK_SIZE
const MAX_ACTIVE_TRANSFERS_PER_DEVICE = 3;
const FILE_TRANSFER_TIMEOUT_MS = 120_000; // 2 minutes to complete a transfer
const BLOCKED_FILE_EXTENSIONS = /\.(exe|bat|cmd|sh|ps1|app|dmg|pkg|msi|vbs|wsf)$/i;
const fileTransfers = new Map(); // transferId -> { chunks, totalChunks, filename, mimeType, fileSize, deviceId, timer }
const SESSION_REVOKED_CLOSE_CODE = 4001;
const E2E_UNAUTHENTICATED_CLOSE_CODE = 4002;
const E2E_UNAVAILABLE_CLOSE_CODE = 4003;
const E2E_UNAUTHENTICATED_CLOSE_REASON = 'e2e_unauthenticated';
const E2E_UNAVAILABLE_CLOSE_REASON = 'e2e_unavailable';

let connectionAttempts = new Map();

function isKidAuthorized(kid) {
    if (!kid) {
        return false;
    }

    const authorized = getAuthorizedPairedKeys();
    return authorized.some((key) => key.kid === kid);
}

function normalizeSourceAddress(value) {
    if (typeof value !== 'string') {
        return '';
    }

    const normalized = value.trim();
    if (!normalized) {
        return '';
    }

    if (normalized.startsWith('::ffff:')) {
        return normalized.substring(7);
    }

    return normalized;
}

function getClientSourceKey(req) {
    const cfConnectingIpHeader = req?.headers?.['cf-connecting-ip'];
    const xForwardedForHeader = req?.headers?.['x-forwarded-for'];
    const cfConnectingIp = Array.isArray(cfConnectingIpHeader) ? cfConnectingIpHeader[0] : cfConnectingIpHeader;
    if (typeof cfConnectingIp === 'string') {
        const normalizedCfConnectingIp = normalizeSourceAddress(cfConnectingIp);
        if (normalizedCfConnectingIp) {
            return normalizedCfConnectingIp;
        }
    }

    const xForwardedFor = Array.isArray(xForwardedForHeader) ? xForwardedForHeader.join(',') : xForwardedForHeader;
    if (typeof xForwardedFor === 'string') {
        const normalizedXForwardedFor = normalizeSourceAddress(xForwardedFor.split(',')[0]);
        if (normalizedXForwardedFor) {
            return normalizedXForwardedFor;
        }
    }

    const normalizedRemoteAddress = normalizeSourceAddress(req?.socket?.remoteAddress);
    return normalizedRemoteAddress || 'unknown';
}

function pruneConnectionAttempts(now = Date.now()) {
    let totalAttempts = 0;
    for (const [sourceKey, attempts] of connectionAttempts.entries()) {
        const recentAttempts = attempts.filter(t => now - t < 60000);
        if (recentAttempts.length === 0) {
            connectionAttempts.delete(sourceKey);
            continue;
        }
        connectionAttempts.set(sourceKey, recentAttempts);
        totalAttempts += recentAttempts.length;
    }
    return totalAttempts;
}

function isRateLimited(sourceKey) {
    const now = Date.now();
    const totalAttempts = pruneConnectionAttempts(now);
    const sourceAttempts = connectionAttempts.get(sourceKey) || [];
    if (sourceAttempts.length >= MAX_CONNECTIONS_PER_SOURCE_PER_MINUTE) {
        return 'source_connections_per_minute';
    }
    if (totalAttempts >= MAX_CONNECTIONS_PER_MINUTE) {
        return 'global_connections_per_minute';
    }
    return null;
}

function recordConnectionAttempt(sourceKey, timestamp = Date.now()) {
    const sourceAttempts = connectionAttempts.get(sourceKey) || [];
    sourceAttempts.push(timestamp);
    connectionAttempts.set(sourceKey, sourceAttempts);
}

function countPendingPairingsForSource(sourceKey) {
    let count = 0;
    for (const pairing of pendingPairings.values()) {
        if ((pairing.sourceKey || 'unknown') === sourceKey) {
            count++;
        }
    }
    return count;
}

// Generate 6-character pairing code
function generatePairingCode() {
    let code = '';
    const randomBytes = crypto.randomBytes(6);
    for (let i = 0; i < 6; i++) {
        code += PAIRING_CODE_CHARS[randomBytes[i] % PAIRING_CODE_CHARS.length];
    }
    return code;
}

function isValidKeyId(keyId) {
    return typeof keyId === 'string' && /^[a-f0-9]{64}$/i.test(keyId);
}

function isValidPairingJwk(jwk) {
    return isValidRsaPssJwk(jwk) && !hasForbiddenPairingJwkFields(jwk);
}

function computeKeyIdFromJwk(jwk) {
    return crypto.createHash('sha256').update(canonicalizeJwk(jwk)).digest('hex');
}

function verifySignatureWithJwk(jwk, signature, payload, encoding = 'hex') {
    if (!isValidRsaPssJwk(jwk) || typeof signature !== 'string' || !signature) {
        return false;
    }

    try {
        const pubKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
        return crypto.verify(
            'sha256',
            Buffer.isBuffer(payload) ? payload : Buffer.from(payload),
            {
                key: pubKey,
                padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
                saltLength: 32,
            },
            Buffer.from(signature, encoding)
        );
    } catch (error) {
        logDebug(`[SECURITY] Pairing signature verification error: ${error.message}`);
        return false;
    }
}

function settlePendingPairingApproval(ws, result) {
    if (!ws?.pendingPairingApproval) {
        return;
    }

    const { timeoutId, resolve } = ws.pendingPairingApproval;
    clearTimeout(timeoutId);
    ws.pendingPairingApproval = null;
    resolve(result);
}

function cleanupClientConnection(ws, options = {}) {
    if (!ws || ws.connectionCleanedUp) {
        return;
    }

    ws.connectionCleanedUp = true;
    clearTimeout(ws.authTimeout);
    if (ws.e2eTimeout) {
        clearTimeout(ws.e2eTimeout);
        ws.e2eTimeout = null;
    }
    activeClients.delete(ws);
    for (const [code, data] of pendingPairings.entries()) {
        if (data.ws === ws) {
            pendingPairings.delete(code);
        }
    }
    if (ws.pendingPairingApproval) {
        settlePendingPairingApproval(ws, {
            success: false,
            error: options.pairingError || 'Device disconnected before pairing verification completed',
        });
    }
    ws.pendingOutput = [];
    ws.challenge = null;
    ws.challengeTime = null;
    ws.challengeKeyId = null;
    ws.e2e = null;

    // Clean up any in-progress file transfers for this device
    const deviceId = ws.kid || 'unknown';
    for (const [tid, transfer] of fileTransfers.entries()) {
        if (transfer.deviceId === deviceId) {
            clearTimeout(transfer.timer);
            fileTransfers.delete(tid);
            logDebug(`[ATTACH] Cleaned up stale transfer ${tid} for disconnected device ${deviceId}`);
        }
    }
}

function revokeClientConnection(ws, reason = 'Device removed') {
    if (!ws || ws.connectionCleanedUp) {
        return;
    }

    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'session_revoked', reason }));
    }
    cleanupClientConnection(ws, { pairingError: reason });
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(SESSION_REVOKED_CLOSE_CODE, 'revoked');
    }
}

// Cleanup expired pairing codes
function cleanupExpiredPairings() {
    const now = Date.now();
    for (const [code, data] of pendingPairings.entries()) {
        if (now - data.createdAt > PAIRING_CODE_EXPIRY_MS) {
            if (data.ws && data.ws.readyState === WebSocket.OPEN) {
                data.ws.send(JSON.stringify({ type: 'pairing_expired' }));
            }
            pendingPairings.delete(code);
        }
    }
}

// Run cleanup every 30 seconds
setInterval(cleanupExpiredPairings, 30000);

function handleConnection(ws, req) {
    const sourceKey = getClientSourceKey(req);
    ws.sourceKey = sourceKey;

    if (!desktopIdentityKeyPair?.privateKeyJwk || !desktopIdentityKeyPair?.publicKeyJwk) {
        closeE2EUnavailable(ws, 'Desktop identity unavailable; rejecting bridge connection');
        return;
    }

    // Rate limiting check
    const rateLimitReason = isRateLimited(sourceKey);
    if (rateLimitReason) {
        logDebug('[SECURITY] rate_limit rejected', { sourceKey, reason: rateLimitReason });
        ws.close(1008, 'Rate limit exceeded');
        return;
    }
    recordConnectionAttempt(sourceKey);

    // Track auth attempts per connection
    ws.authAttempts = 0;

    // Set connection timeout - close if not authenticated within 3 minutes (for pairing flow)
    ws.authTimeout = setTimeout(() => {
        if (!ws.authenticated) {
            logDebug('[SECURITY] Authentication timeout, closing connection');
            ws.close(1008, 'Authentication timeout');
        }
    }, 180000);

    console.log('[WS] Client connected');
    ws.send(JSON.stringify({ type: 'connected' }));

    ws.on('error', (err) => {
        console.error('[WS] Error:', err);
    });

    ws.lastActivity = Date.now();
    ws.lastHeartbeat = Date.now();
    // Start as not-visible — the client will send client_visible:true once it
    // confirms foreground state. Prevents a 35-second race window on reconnect
    // where the server assumes the client is visible and suppresses push.
    ws.clientVisible = false;

    ws.on('message', async (msg) => {
        ws.lastActivity = Date.now();

        let m;
        try {
            // SECURITY: Message size limit (defense in depth - maxPayload already enforces at WebSocket level)
            // File chunks can be up to ~1MB (512KB plaintext + base64 + JSON), regular messages stay at 256KB
            if (msg.length > 1024 * 1024) {
                logDebug('[SECURITY] Message too large, ignoring');
                return;
            }
            m = JSON.parse(msg);
        } catch (e) {
            return;
        }

        // Heartbeat - respond to ping immediately.
        // Pings carry the client's visibility state so that lastHeartbeat and
        // clientVisible are always updated atomically. This eliminates the race
        // where the page returns to foreground (clientVisible=true) but
        // lastHeartbeat is stale because the first interval-ping hasn't fired.
        if (m.type === 'ping') {
            ws.lastHeartbeat = Date.now();
            if (typeof m.visible === 'boolean') {
                ws.clientVisible = m.visible;
            }
            ws.send(JSON.stringify({ type: 'pong', timestamp: m.timestamp }));
            return;
        }

        // Client visibility state — belt-and-suspenders signal alongside
        // heartbeat pings. When the client reports it is now visible, we also
        // bump lastHeartbeat so the pair (clientVisible, lastHeartbeat) is
        // immediately consistent. Without this, a push arriving between the
        // visibility change and the next heartbeat ping would see
        // clientVisible=true but a stale heartbeat and fire incorrectly.
        if (m.type === 'client_visible') {
            const nowVisible = Boolean(m.visible);
            ws.clientVisible = nowVisible;
            if (nowVisible) {
                ws.lastHeartbeat = Date.now();
            }
            logDebug(`[NOTIFICATIONS] client_visible kid=${(ws.kid || '?').substring(0, 8)} visible=${nowVisible} hb=${ws.lastHeartbeat}`);
            return;
        }

        // Pairing Request - new device pairing flow
        if (!ws.authenticated && m.type === 'pairing_request') {
            // Validate required fields
            if (!m.code || typeof m.code !== 'string' ||
                !isValidKeyId(m.keyId) ||
                !isValidPairingJwk(m.jwk)) {
                ws.send(JSON.stringify({ type: 'pairing_error', message: 'Invalid request' }));
                return;
            }

            const publicPairingJwk = toPublicPairingJwk(m.jwk);
            if (!publicPairingJwk) {
                ws.send(JSON.stringify({ type: 'pairing_error', message: 'Invalid request' }));
                return;
            }

            // Normalize code (uppercase)
            const code = m.code.toUpperCase();

            // Validate code format
            if (code.length !== 6 || !/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/.test(code)) {
                ws.send(JSON.stringify({ type: 'pairing_error', message: 'Invalid code format' }));
                return;
            }

            if (computeKeyIdFromJwk(m.jwk) !== m.keyId) {
                logDebug('[SECURITY] Rejected pairing request with mismatched key ID');
                ws.send(JSON.stringify({ type: 'pairing_error', message: 'Invalid device identity' }));
                return;
            }

            // Check if device is already registered
            const authorized = getAuthorizedPairedKeys();
            if (authorized.find(k => k.kid === m.keyId)) {
                // Already registered - send challenge for proof of key possession
                logDebug(`[PAIRING] Device registered, sending challenge: ${m.keyId.substring(0, 8)}`);
                const challenge = crypto.randomBytes(32).toString('hex');
                ws.challenge = challenge;
                ws.challengeTime = Date.now();
                ws.challengeKeyId = m.keyId;
                ws.send(JSON.stringify({ type: 'auth_challenge', challenge }));
                return;
            }

            // Cleanup expired pairings first
            cleanupExpiredPairings();

            // Check max pending pairings limit
            if (countPendingPairingsForSource(ws.sourceKey || 'unknown') >= MAX_PENDING_PAIRINGS_PER_SOURCE) {
                logDebug('[SECURITY] rate_limit rejected', {
                    sourceKey: ws.sourceKey || 'unknown',
                    reason: 'source_pending_pairings',
                });
                ws.send(JSON.stringify({ type: 'pairing_error', message: 'Too many pending requests' }));
                return;
            }
            if (pendingPairings.size >= MAX_PENDING_PAIRINGS) {
                logDebug('[SECURITY] rate_limit rejected', {
                    sourceKey: ws.sourceKey || 'unknown',
                    reason: 'global_pending_pairings',
                });
                ws.send(JSON.stringify({ type: 'pairing_error', message: 'Too many pending requests' }));
                return;
            }

            // Check for duplicate codes
            if (pendingPairings.has(code)) {
                ws.send(JSON.stringify({ type: 'pairing_error', message: 'Code already in use' }));
                return;
            }

            // Store pairing request
            pendingPairings.set(code, {
                ws,
                kid: m.keyId,
                jwk: publicPairingJwk,
                createdAt: Date.now(),
                sourceKey: ws.sourceKey || 'unknown',
            });

            ws.send(JSON.stringify({ type: 'pairing_pending', code }));
            logDebug(`[PAIRING] New pairing request initiated for key ${m.keyId.substring(0, 8)}...`);
            return;
        }

        // Auth Response - returning device responds to challenge
        if (!ws.authenticated && m.type === 'auth_response') {
            // Check auth attempt limit
            ws.authAttempts++;
            if (ws.authAttempts > MAX_AUTH_ATTEMPTS_PER_CONNECTION) {
                logDebug('[SECURITY] Too many auth attempts, closing connection');
                ws.close(1008, 'Too many authentication attempts');
                return;
            }

            // Verify challenge was issued
            if (!ws.challenge || !ws.challengeTime) {
                logDebug('[SECURITY] Auth response without challenge');
                ws.send(JSON.stringify({ type: 'auth_error', message: 'No challenge issued' }));
                return;
            }

            // Check challenge expiration
            if (Date.now() - ws.challengeTime > CHALLENGE_EXPIRY_MS) {
                logDebug('[SECURITY] Challenge expired, rejecting auth');
                ws.send(JSON.stringify({ type: 'auth_error', message: 'Challenge expired' }));
                ws.close(1008, 'Challenge expired');
                return;
            }

            // Validate required fields
            if (!isValidKeyId(m.keyId) ||
                !m.signature || typeof m.signature !== 'string') {
                logDebug('[SECURITY] Invalid auth response format');
                return;
            }

            // Verify keyId matches the challenged device
            if (ws.challengeKeyId && m.keyId !== ws.challengeKeyId) {
                logDebug('[SECURITY] KeyId mismatch in auth response');
                ws.send(JSON.stringify({ type: 'auth_error', message: 'Key mismatch' }));
                return;
            }

            logDebug(`[WS] Auth response from KID: ${m.keyId.substring(0, 8)}`);
            const approvedPairing = ws.pendingPairingApproval;
            const isApprovedPairing = approvedPairing && approvedPairing.kid === m.keyId;
            const isValidSignature = isApprovedPairing
                ? verifySignatureWithJwk(approvedPairing.jwk, m.signature, ws.challenge)
                : verifySignature(m.keyId, m.signature, ws.challenge);

            if (isValidSignature) {
                logDebug(`[WS] Auth SUCCESS: ${m.keyId.substring(0, 8)}`);

                if (isApprovedPairing) {
                    assertNoPrivatePairingJwkMaterial(approvedPairing.jwk);
                    const pairingPublicJwk = toPublicPairingJwk(approvedPairing.jwk);
                    if (!pairingPublicJwk) {
                        throw new Error('Rejected invalid pairing key material');
                    }
                    assertNoPrivatePairingJwkMaterial(pairingPublicJwk);
                    const keys = getStoredPairedKeys().filter((key) => key.kid !== approvedPairing.kid);
                    keys.push({
                        kid: approvedPairing.kid,
                        jwk: pairingPublicJwk,
                        name: approvedPairing.name,
                    });
                    store.set('keys', keys);
                }

                let e2eInitialized = false;
                try {
                    e2eInitialized = await initE2EKeyExchange(ws);
                } catch (error) {
                    closeE2EUnauthenticated(ws, `Failed to initialize authenticated E2E state: ${error.message}`);
                }
                if (!e2eInitialized) {
                    if (isApprovedPairing) {
                        settlePendingPairingApproval(ws, {
                            success: false,
                            error: 'Desktop identity unavailable for authenticated E2E',
                        });
                    }
                    ws.challenge = null;
                    ws.challengeTime = null;
                    ws.challengeKeyId = null;
                    return;
                }

                ws.authenticated = true;
                ws.kid = m.keyId;
                ws.lastHeartbeat = Date.now();
                ws.clientVisible = true;
                clearTimeout(ws.authTimeout);
                ws.send(JSON.stringify(
                    isApprovedPairing
                        ? {
                            type: 'pairing_success',
                            serverIdentityJwk: desktopIdentityKeyPair.publicKeyJwk,
                        }
                        : { type: 'auth_success' }
                ));
                startPty(ws);
                if (isApprovedPairing) {
                    settlePendingPairingApproval(ws, { success: true });
                }
            } else {
                logDebug(`[WS] Auth FAILED: ${m.keyId.substring(0, 8)}`);
                ws.send(JSON.stringify({ type: 'auth_error', message: 'Authentication failed' }));
                if (isApprovedPairing) {
                    settlePendingPairingApproval(ws, {
                        success: false,
                        error: 'Device could not prove ownership of its pairing key',
                    });
                }
            }
            ws.challenge = null;
            ws.challengeTime = null;
            ws.challengeKeyId = null;
            return;
        }

        if (ws.authenticated && !isKidAuthorized(ws.kid)) {
            logDebug(`[SECURITY] Rejected post-auth message for revoked device: ${ws.kid.substring(0, 8)}...`);
            revokeClientConnection(ws, 'Device removed');
            return;
        }

        if (ws.authenticated && m.type === 'notifications_get_state') {
            sendNotificationState(ws);
            return;
        }

        if (ws.authenticated && m.type === 'notifications_subscribe') {
            const registered = upsertPushSubscription({
                kid: ws.kid,
                subscription: m.subscription,
                platform: m.platform,
                userAgent: m.userAgent,
            });

            if (!registered) {
                ws.send(JSON.stringify({
                    type: 'notifications_error',
                    message: 'Invalid push subscription payload.',
                }));
                return;
            }

            sendNotificationState(ws);
            return;
        }

        if (ws.authenticated && m.type === 'notifications_unsubscribe') {
            removePushSubscriptionsForKid(ws.kid);
            sendNotificationState(ws);
            return;
        }

        // E2E: Receive client's ECDH public key
        if (ws.authenticated && m.type === 'e2e_client_key') {
            await completeE2EKeyExchange(ws, m.clientEcdhPubJwk, m.clientSignature);
            return;
        }

        // E2E Encrypted Input - only from authenticated clients with E2E
        if (ws.authenticated && m.type === 'e2e_input') {
            if (!ws.e2e || !ws.e2e.ready) {
                logDebug('[E2E] Received encrypted input but E2E not ready');
                return;
            }

            // SECURITY: Check encrypted payload size BEFORE decryption to prevent resource exhaustion
            // Base64 encoded data is ~33% larger than raw, so check against 1.5x MAX_INPUT_SIZE
            if (m.data && m.data.length > MAX_INPUT_SIZE * 2) {
                logDebug('[SECURITY] Encrypted payload too large, rejecting before decryption');
                return;
            }

            const decrypted = decryptInput(ws, { iv: m.iv, data: m.data, tag: m.tag });
            if (decrypted === null) {
                logDebug('[E2E] Failed to decrypt input');
                return;
            }

            // Limit input size (defense in depth - also checked above before decryption)
            let inputData = decrypted;
            if (inputData.length > MAX_INPUT_SIZE) {
                logDebug('[SECURITY] E2E Input too large, truncating');
                inputData = inputData.substring(0, MAX_INPUT_SIZE);
            }

            if (operatingMode === 'channel') {
                // Channel mode: forward to Claude Code via channel bridge
                const deviceId = ws.kid || 'unknown';
                const result = await submitChannelUserMessage(deviceId, inputData, deviceId, {
                    echoToLocalChat: true,
                    senderWs: ws,
                });

                if (result.success) {
                    logDebug(`[CHANNEL] Forwarded input to channel bridge (len: ${inputData.length})`);
                } else {
                    logDebug(`[CHANNEL] Failed to forward input to channel bridge: ${result.error}`);
                }
            } else if (ptyProcess) {
                // Terminal mode: write to PTY
                logDebug(`[PTY] Writing E2E input (len: ${inputData.length})`);
                ptyProcess.write(inputData);
            }
            return;
        }

        // NOTE: Unencrypted 'input' handler removed for security
        // All terminal input MUST go through e2e_input after E2E is established

        // E2E Encrypted File Chunk - file attachment upload
        if (ws.authenticated && m.type === 'e2e_file_chunk') {
            if (!ws.e2e || !ws.e2e.ready) {
                logDebug('[E2E] Received file chunk but E2E not ready');
                return;
            }

            const { transferId, chunkIndex, totalChunks, filename, mimeType, fileSize } = m;

            // Validate metadata
            if (!transferId || typeof chunkIndex !== 'number' || typeof totalChunks !== 'number' || !filename) {
                logDebug('[SECURITY] Malformed file chunk metadata');
                return;
            }

            if (!Number.isInteger(chunkIndex) || !Number.isInteger(totalChunks)
                || totalChunks < 1 || totalChunks > Math.ceil(MAX_FILE_SIZE / MAX_FILE_CHUNK_SIZE)
                || chunkIndex < 0 || chunkIndex >= totalChunks) {
                logDebug(`[SECURITY] File chunk index/count out of range: chunk=${chunkIndex} total=${totalChunks}`);
                return;
            }

            // Validate claimed file size
            if (typeof fileSize === 'number' && fileSize > MAX_FILE_SIZE) {
                logDebug(`[SECURITY] Claimed file size ${fileSize} exceeds limit`);
                return;
            }

            // Limit active transfers per device
            const deviceId = ws.kid || 'unknown';
            const activeForDevice = Array.from(fileTransfers.values()).filter(t => t.deviceId === deviceId).length;
            if (!fileTransfers.has(transferId) && activeForDevice >= MAX_ACTIVE_TRANSFERS_PER_DEVICE) {
                logDebug(`[SECURITY] Too many active transfers for device ${deviceId}`);
                return;
            }

            // Pre-decryption size gate
            if (m.data && m.data.length > MAX_FILE_SIZE * 2) {
                logDebug('[SECURITY] File chunk payload too large');
                return;
            }

            // Decrypt chunk to Buffer (not string)
            let chunkBuffer;
            try {
                const iv = Buffer.from(m.iv, 'base64');
                const data = Buffer.from(m.data, 'base64');
                const authTag = Buffer.from(m.tag, 'base64');

                const decipher = crypto.createDecipheriv('aes-256-gcm', ws.e2e.sessionKey, iv);
                decipher.setAuthTag(authTag);
                chunkBuffer = Buffer.concat([decipher.update(data), decipher.final()]);
            } catch (e) {
                logDebug(`[SECURITY] File chunk decryption failed: ${e.message}`);
                return;
            }

            // Initialize or get transfer
            if (!fileTransfers.has(transferId)) {
                const timer = setTimeout(() => {
                    logDebug(`[ATTACH] Transfer ${transferId} timed out, cleaning up`);
                    fileTransfers.delete(transferId);
                }, FILE_TRANSFER_TIMEOUT_MS);

                fileTransfers.set(transferId, {
                    chunks: new Map(),
                    totalChunks,
                    filename,
                    mimeType: mimeType || 'application/octet-stream',
                    fileSize: fileSize || 0,
                    caption: m.caption || '',
                    deviceId,
                    timer,
                });
            }

            const transfer = fileTransfers.get(transferId);
            transfer.chunks.set(chunkIndex, chunkBuffer);

            logDebug(`[ATTACH] Chunk ${chunkIndex + 1}/${totalChunks} for ${filename} (${chunkBuffer.length} bytes)`);

            // All chunks received — reassemble and save
            if (transfer.chunks.size === transfer.totalChunks) {
                clearTimeout(transfer.timer);
                fileTransfers.delete(transferId);

                const ordered = [];
                for (let i = 0; i < transfer.totalChunks; i++) {
                    const chunk = transfer.chunks.get(i);
                    if (!chunk) {
                        logDebug(`[ATTACH] Missing chunk ${i} for transfer ${transferId}`);
                        return;
                    }
                    ordered.push(chunk);
                }

                const assembled = Buffer.concat(ordered);

                // Final size check
                if (assembled.length > MAX_FILE_SIZE) {
                    logDebug(`[SECURITY] Reassembled file exceeds max size: ${assembled.length}`);
                    return;
                }

                // Sanitize filename — keep original name but strip path components and dangerous chars
                const sanitized = path.basename(transfer.filename).replace(/[^a-zA-Z0-9._\- ]/g, '_');
                if (!sanitized || sanitized === '.' || sanitized === '..') {
                    logDebug(`[SECURITY] Invalid filename after sanitization: ${transfer.filename}`);
                    return;
                }

                // Block executable extensions
                if (BLOCKED_FILE_EXTENSIONS.test(sanitized)) {
                    logDebug(`[SECURITY] Blocked file extension: ${sanitized}`);
                    return;
                }

                // Resolve final path — use original name, add suffix on collision
                ensureAttachmentsDir();
                let finalName = sanitized;
                let destPath = path.join(ATTACHMENTS_DIR, finalName);

                // Path traversal check
                const resolved = path.resolve(destPath);
                if (!resolved.startsWith(ATTACHMENTS_DIR + path.sep) && resolved !== ATTACHMENTS_DIR) {
                    logDebug('[SECURITY] Path traversal attempt blocked');
                    return;
                }

                // Collision handling — append -2, -3, etc.
                if (fs.existsSync(destPath)) {
                    const ext = path.extname(sanitized);
                    const base = path.basename(sanitized, ext);
                    let counter = 2;
                    while (fs.existsSync(destPath)) {
                        finalName = `${base}-${counter}${ext}`;
                        destPath = path.join(ATTACHMENTS_DIR, finalName);
                        counter++;
                    }
                }

                try {
                    fs.writeFileSync(destPath, assembled);
                    logDebug(`[ATTACH] Saved: ${finalName} (${assembled.length} bytes, ${transfer.mimeType})`);
                } catch (e) {
                    logDebug(`[ATTACH] Failed to write file: ${e.message}`);
                    return;
                }

                // Send path reference to Claude via channel (single message with optional caption)
                const absPath = destPath;
                const parts = [];
                if (transfer.caption) {
                    parts.push(transfer.caption);
                }
                parts.push(`[File attached: ${transfer.filename}]\nSaved to: ${absPath}`);
                const fileResult = await submitChannelUserMessage(transfer.deviceId, parts.join('\n\n'), transfer.deviceId, {
                    echoToLocalChat: true,
                    senderWs: ws,
                }).catch((err) => {
                    logDebug(`[CHANNEL] File attachment forward failed: ${err.message}`);
                    return { success: false, error: err.message };
                });
                if (!fileResult.success) {
                    logDebug(`[CHANNEL] File attachment forward not successful: ${fileResult.error}`);
                }
            }
            return;
        }

        // Mode switch from client
        if (ws.authenticated && m.type === 'set_mode') {
            if (m.mode === 'terminal' || m.mode === 'channel') {
                logDebug(`[MODE] Client requested switch to ${m.mode}`);
                setOperatingMode(m.mode);
            }
            return;
        }

        // Resize - validate dimensions
        if (ws.authenticated && m.type === 'resize') {
            const cols = parseInt(m.cols, 10);
            const rows = parseInt(m.rows, 10);
            // Validate reasonable terminal dimensions
            if (cols > 0 && cols <= 500 && rows > 0 && rows <= 200) {
                if (ptyProcess) ptyProcess.resize(cols, rows);
            }
        }
    });

    ws.on('close', () => {
        cleanupClientConnection(ws);
    });
}

// SECURITY: Constant-time signature verification to prevent timing side-channel attacks
// Always performs full verification flow regardless of whether key exists
function verifySignature(kid, signature, challenge) {
    const authorized = getAuthorizedPairedKeys();
    const key = authorized.find(k => k.kid === kid);

    // Always perform cryptographic operations to prevent timing-based key ID enumeration
    // Use a dummy key if the requested key doesn't exist
    const dummyJwk = {
        kty: 'RSA',
        n: 'sXchDaQebSXKcvLb2qxgRuHN6oJFVnVPzIyYzU5jJ1xH7SZdZsSTgkmU8tJYRjpfUJR4u3F6m1l4nxbJgz4qCtJM3vZakXlqXP0nQHJEFg8TU2FJhCwk6aJj0E0xlP4Zs4w0L2QLnv2YGdJaXBcTX0BGZ3xLJtFkJvWZJmjSfJVFrLIvvlD5yLr5XHTYmTnQd4HgxjGQh0kLNTvBVHfBgGJQCJN3BNkNSxGCsHPlqCFfVQCLbPUJFcLYUHJmMY6JGCxE1NJBB2cwf7kQvQ7p3DHsZYQHVbPKhFUQVLnCaM0TVhLmxJM7EapVdRDbMfJxJDhQ0aGYEHJFhK8qQvQwQ',
        e: 'AQAB'
    };

    const keyToVerify = key ? key.jwk : dummyJwk;
    let isValid = false;

    try {
        const pubKey = crypto.createPublicKey({ key: keyToVerify, format: 'jwk' });

        // Use RSA-PSS verification (more secure than PKCS#1 v1.5)
        isValid = crypto.verify(
            'sha256',
            Buffer.from(challenge),
            {
                key: pubKey,
                padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
                saltLength: 32 // Must match client's saltLength
            },
            Buffer.from(signature, 'hex')
        );
    } catch (e) {
        // Log error but continue to return false
        logDebug(`[SECURITY] Signature verification error: ${e.message}`);
        isValid = false;
    }

    // Only return true if key existed AND signature was valid
    return key ? isValid : false;
}

function startPty(ws) {
    logDebug(`[PTY] Attaching client. Total: ${activeClients.size + 1}`);
    activeClients.add(ws);
    ws.send(JSON.stringify({
        type: 'system_status',
        state: getTunnelState(),
    }));

    // In channel mode, don't spawn PTY — just track the client
    if (operatingMode === 'channel') {
        logDebug('[CHANNEL] Client attached in channel mode, skipping PTY');
        // Send chat history from disk (buffered by sendEncryptedOutput until E2E ready)
        const history = chatStore.loadMessages();
        if (history.length > 0) {
            sendEncryptedOutput(ws, JSON.stringify({
                type: 'channel_history',
                messages: history,
            }));
            logDebug(`[CHANNEL] Sent ${history.length} history messages from disk`);
        }
        if (latestChannelActivity) {
            sendEncryptedOutput(ws, JSON.stringify({
                type: 'channel_activity',
                activity: latestChannelActivity,
            }));
        }
        return;
    }

    // If PTY already exists, just send the buffer (will be buffered until E2E ready)
    if (ptyProcess) {
        logDebug(`[PTY] PTY exists. Sending buffer (size: ${outputBuffer.length})`);
        sendEncryptedOutput(ws, outputBuffer);
        return;
    }

    // Determine shell path with fallback
    let shellPath = '/bin/zsh';
    if (!fs.existsSync(shellPath)) {
        shellPath = '/bin/bash';
        if (!fs.existsSync(shellPath)) {
            shellPath = '/bin/sh';
        }
    }

    if (!fs.existsSync(shellPath)) {
        logDebug(`[PTY] FATAL: No shell found`);
        sendEncryptedOutput(ws, '\r\n[SYSTEM] No shell found\r\n');
        return;
    }

    logDebug(`[PTY] Spawning new session (${shellPath})...`);
    try {
        const shellArgs = ['--login']; // Run as login shell to get user's PATH/aliases

        // SECURITY: Only pass safe, necessary environment variables
        // Avoid leaking secrets from parent process
        const safeEnv = {
            // Essential shell variables
            HOME: process.env.HOME || '/tmp',
            USER: process.env.USER || 'user',
            SHELL: shellPath,
            PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',

            // Terminal settings
            TERM: 'xterm-256color',
            COLORTERM: 'truecolor',
            LANG: 'en_US.UTF-8',
            LC_ALL: 'en_US.UTF-8',

            // Editor (optional, common defaults)
            EDITOR: process.env.EDITOR || 'vim',
            VISUAL: process.env.VISUAL || process.env.EDITOR || 'vim',

            // XDG directories (for proper app behavior)
            XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || `${process.env.HOME}/.config`,
            XDG_DATA_HOME: process.env.XDG_DATA_HOME || `${process.env.HOME}/.local/share`,
            XDG_CACHE_HOME: process.env.XDG_CACHE_HOME || `${process.env.HOME}/.cache`,

            // Mark as remote session for tools that care
            POCKET_BRIDGE: '1',
            SSH_TTY: '/dev/ttys000' // Some tools check for this
        };

        ptyProcess = pty.spawn(shellPath, shellArgs, {
            name: 'xterm-256color',
            cols: 80,
            rows: 30,
            cwd: process.env.HOME || '/tmp',
            env: safeEnv
        });
    } catch (err) {
        console.error('PTY Spawn Error:', err);
        mainWindow.webContents.send('CF_LOG', 'PTY ERROR: ' + err.message);
        sendEncryptedOutput(ws, '\r\n[SYSTEM] Failed to spawn shell: ' + err.message + '\r\n');
        return;
    }

    ptyProcess.on('data', d => {
        const raw = d.toString();

        // Claude Code uses different circle/dot characters.
        // We force "Text Presentation" (\uFE0E) on all of them.
        let filtered = raw
            .replace(/\u25CF/g, '\u25CF\uFE0E') // ● Black Circle
            .replace(/\u25CB/g, '\u25CB\uFE0E') // ○ White Circle
            .replace(/\u2022/g, '\u2022\uFE0E') // • Bullet
            .replace(/\u2219/g, '\u2219\uFE0E') // ∙ Bullet Operator
            .replace(/\u23FA/g, '\u23FA\uFE0E') // ⏺ Black Circle for Record
            .replace(/\uD83D\uDD35/g, '\u25CF\uFE0E'); // Force blue circle emoji to black circle text

        // SECURITY: Sanitize dangerous ANSI escape sequences
        filtered = sanitizeTerminalOutput(filtered);

        // Broadcast to all authenticated clients (encrypted if E2E ready)
        // Buffer size: 1MB to match standard terminal scrollback (~5000 lines)
        const MAX_OUTPUT_BUFFER = 1024 * 1024;
        outputBuffer += filtered;
        if (outputBuffer.length > MAX_OUTPUT_BUFFER) {
            outputBuffer = outputBuffer.slice(-MAX_OUTPUT_BUFFER);
        }

        for (let client of activeClients) {
            if (client.readyState === WebSocket.OPEN) {
                sendEncryptedOutput(client, filtered);
            }
        }
    });

    ptyProcess.on('exit', (exitCode, signal) => {
        logDebug(`[PTY] Process exited with code ${exitCode}, signal ${signal}`);
        ptyProcess = null;
    });
}

// 5. ASSET SERVER (Serves the PWA code)
function servePWA(req, res) {
    // In development mode, proxy to Vite dev server for HMR
    if (isDev) {
        // Rewrite root path to client.html for Vite
        let proxyPath = req.url;
        if (proxyPath === '/' || proxyPath === '') {
            proxyPath = '/client.html';
        }

        const proxyReq = http.request({
            hostname: 'localhost',
            port: VITE_CLIENT_PORT,
            path: proxyPath,
            method: req.method,
            headers: req.headers
        }, (proxyRes) => {
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(res);
        });

        proxyReq.on('error', (err) => {
            // Vite dev server not running - serve static files as fallback
            console.log('[DEV] Vite client dev server not running, serving static files');
            serveStaticPWA(req, res);
        });

        req.pipe(proxyReq);
        return;
    }

    // Production mode: serve static files
    serveStaticPWA(req, res);
}

// Static file server for production
function serveStaticPWA(req, res) {
    // Security headers for all responses
    // SECURITY: Comprehensive CSP to prevent XSS, clickjacking, and other attacks
    const securityHeaders = {
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'X-XSS-Protection': '1; mode=block',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        // CSP with all recommended directives:
        // - frame-ancestors 'none': Prevents clickjacking (replaces X-Frame-Options in modern browsers)
        // - object-src 'none': Blocks plugins (Flash, Java applets)
        // - base-uri 'self': Prevents base tag injection attacks
        // - form-action 'self': Prevents form hijacking to external URLs
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' wss: ws:; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self';",
        // HSTS: Force HTTPS for 1 year (defense in depth - Cloudflare also adds this)
        'Strict-Transport-Security': 'max-age=31536000; includeSubDomains'
    };

    // Parse URL and strip query strings
    let urlPath = req.url.split('?')[0];
    if (urlPath === '/') urlPath = '/client.html';

    // Decode URL and check for null bytes (path traversal attack vector)
    try {
        urlPath = decodeURIComponent(urlPath);
    } catch (e) {
        res.writeHead(400, securityHeaders);
        res.end('Bad Request');
        return;
    }

    if (urlPath.includes('\0')) {
        res.writeHead(400, securityHeaders);
        res.end('Bad Request');
        return;
    }

    // Determine base directory and resolve path
    let basePath;
    let filePath;

    if (urlPath.startsWith('/node_modules/')) {
        basePath = path.join(__dirname, 'node_modules');
        filePath = path.join(__dirname, urlPath);
    } else if (urlPath.startsWith('/public/')) {
        basePath = path.join(__dirname, 'public');
        filePath = path.join(__dirname, urlPath);
    } else {
        // Serve from Vite build output (public/dist) for the PWA client
        basePath = path.join(__dirname, 'public', 'dist');
        filePath = path.join(__dirname, 'public', 'dist', urlPath);
    }

    // CRITICAL: Normalize paths and prevent path traversal
    const normalizedFilePath = path.normalize(filePath);
    const normalizedBasePath = path.normalize(basePath);

    if (!normalizedFilePath.startsWith(normalizedBasePath + path.sep) &&
        normalizedFilePath !== normalizedBasePath) {
        logDebug(`[SECURITY] Path traversal attempt blocked: ${urlPath}`);
        res.writeHead(403, securityHeaders);
        res.end('Forbidden');
        return;
    }

    fs.readFile(normalizedFilePath, (err, data) => {
        if (err) {
            res.writeHead(404, securityHeaders);
            res.end('Not Found');
            return;
        }

        const ext = path.extname(normalizedFilePath);
        const mimes = {
            '.html': 'text/html; charset=utf-8',
            '.js': 'application/javascript; charset=utf-8',
            '.css': 'text/css; charset=utf-8',
            '.png': 'image/png',
            '.map': 'application/json',
            '.json': 'application/json'
        };
        res.writeHead(200, {
            'Content-Type': mimes[ext] || 'application/octet-stream',
            ...securityHeaders
        });
        res.end(data);
    });
}

// Verify pairing code and approve device
ipcMain.handle('VERIFY_PAIRING_CODE', async (event, code, deviceName) => {
    const normalizedCode = code.toUpperCase().replace(/[^ABCDEFGHJKMNPQRSTUVWXYZ23456789]/g, '');

    if (normalizedCode.length !== 6) {
        return { success: false, error: 'Invalid code format' };
    }

    const pairing = pendingPairings.get(normalizedCode);
    if (!pairing) {
        return { success: false, error: 'Code not found or expired' };
    }

    // Check expiry
    if (Date.now() - pairing.createdAt > PAIRING_CODE_EXPIRY_MS) {
        pendingPairings.delete(normalizedCode);
        return { success: false, error: 'Code expired' };
    }

    const ws = pairing.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        pendingPairings.delete(normalizedCode);
        return { success: false, error: 'Device is no longer connected' };
    }

    if (ws.pendingPairingApproval) {
        return { success: false, error: 'Device verification is already in progress' };
    }

    pendingPairings.delete(normalizedCode);
    const pairingPublicJwk = toPublicPairingJwk(pairing.jwk);
    if (!pairingPublicJwk) {
        return { success: false, error: 'Invalid pairing key material' };
    }
    const challenge = crypto.randomBytes(32).toString('hex');
    ws.challenge = challenge;
    ws.challengeTime = Date.now();
    ws.challengeKeyId = pairing.kid;

    return await new Promise((resolve) => {
        const timeoutId = setTimeout(() => {
            if (ws.pendingPairingApproval) {
                logDebug(`[PAIRING] Device verification timed out: ${pairing.kid.substring(0, 8)}...`);
                ws.send(JSON.stringify({ type: 'auth_error', message: 'Pairing verification timed out' }));
                settlePendingPairingApproval(ws, {
                    success: false,
                    error: 'Device verification timed out',
                });
                if (ws.readyState === WebSocket.OPEN) {
                    ws.close(1008, 'Pairing verification timed out');
                }
            }
        }, CHALLENGE_EXPIRY_MS);

        ws.pendingPairingApproval = {
            kid: pairing.kid,
            jwk: pairingPublicJwk,
            name: deviceName,
            timeoutId,
            resolve: (result) => {
                if (result.success) {
                    logDebug(`[PAIRING] Device paired successfully: ${pairing.kid.substring(0, 8)}...`);
                } else {
                    logDebug(`[PAIRING] Device verification failed: ${pairing.kid.substring(0, 8)}... ${result.error || ''}`.trim());
                }
                resolve(result);
            },
        };

        ws.send(JSON.stringify({ type: 'auth_challenge', challenge }));
    });
});

// Get list of paired devices
ipcMain.handle('GET_PAIRED_DEVICES', () => {
    const keys = store.get('keys', []);
    // Return kid and name (with fallback for legacy devices without name)
    return keys.map(k => ({
        kid: k.kid,
        name: k.name || k.kid.substring(0, 12)
    }));
});

// Check if device name already exists
ipcMain.handle('CHECK_DEVICE_NAME_EXISTS', (event, name) => {
    const keys = store.get('keys', []);
    return keys.some(k => k.name === name);
});

// Remove a paired device
ipcMain.handle('REMOVE_PAIRED_DEVICE', (event, kid) => {
    const keys = store.get('keys', []);
    const filtered = keys.filter(k => k.kid !== kid);
    store.set('keys', filtered);
    removePushSubscriptionsForKid(kid);
    // SECURITY: Evict live sockets immediately so revocation takes effect mid-session.
    for (const client of Array.from(activeClients)) {
        if (client.kid === kid) {
            revokeClientConnection(client, 'Device removed');
        }
    }
    logDebug(`[PAIRING] Device removed: ${kid.substring(0, 8)}`);
    return { success: true };
});

function checkManualUrl(data) {
    const str = data.toString();
    const match = str.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (match) {
        console.log('TUNNEL_LIVE [Manual]:', match[0]);
        currentTunnelUrl = match[0];
        mainWindow.webContents.send('TUNNEL_LIVE', match[0]);
    }
}

// parseTunnelLog is no longer needed since cloudflared package emits 'url' event

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
    isAppQuitting = true;
    if (updater) {
        updater.stop();
    }
    stopBridge();
    if (dynamicMemory) {
        try { dynamicMemory.close(); } catch (err) { /* ignore */ }
    }
    if (supervisor) {
        supervisor.shutdown().catch(() => { /* ignore shutdown errors */ });
    }
    if (supervisorStore) {
        try { supervisorStore.close(); } catch (err) { /* ignore */ }
    }
});
