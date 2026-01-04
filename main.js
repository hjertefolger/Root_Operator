/**
 * ROOT OPERATOR - MAIN PROCESS
 */
const { app, BrowserWindow, ipcMain, shell, Tray, Menu } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fixPath = async () => {
    const { default: fp } = await import('fix-path');
    fp();
};
const WebSocket = require('ws');
const pty = require('node-pty');
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const cloudflared = require('cloudflared');
const keytar = require('keytar');

let store;
const INTERNAL_PORT = 22000;
const isDev = !app.isPackaged;

// Secure credential storage constants
const KEYTAR_SERVICE = 'RootOperator';
const KEYTAR_CF_TOKEN = 'cloudflare-token';
const KEYTAR_TUNNEL_TOKEN = 'tunnel-token';
const KEYTAR_WORKER_PRIVATE_KEY = 'worker-private-key';

// Worker API configuration
const WORKER_BASE_URL = 'https://cf.v0x.one';
const WORKER_DOMAIN = 'v0x.one';

// GLOBAL STATE
let mainWindow;
let tray;
let server;
let wss;
let ptyProcess;
let outputBuffer = "";
let tunnelProcess;
let wakeLock;
let pendingConns = new Map(); // kid -> ws
let activeClients = new Set();
let currentTunnelUrl = null; // Track tunnel URL for state sync

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
// Provides zero-knowledge encryption using ECDH key exchange + AES-256-GCM

// BIP39 wordlist for human-readable fingerprints (2048 words, 11 bits each)
const BIP39_WORDS = require('./public/bip39-words.json');

// Global state for current session fingerprint (shown in tray)
let currentFingerprint = null;

// Generate ECDH key pair for key exchange
function generateECDHKeyPair() {
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    return {
        publicKey: ecdh.getPublicKey('base64'),
        privateKey: ecdh.getPrivateKey('base64'),
        ecdh: ecdh
    };
}

// Derive shared secret from ECDH
function deriveSharedSecret(ecdh, otherPublicKeyBase64) {
    const otherPublicKey = Buffer.from(otherPublicKeyBase64, 'base64');
    return ecdh.computeSecret(otherPublicKey);
}

// Derive AES-256-GCM key using HKDF
function deriveSessionKey(sharedSecret, salt) {
    // Use HKDF to derive a 256-bit key
    const info = Buffer.from('root-operator-e2e-v1');
    const key = crypto.hkdfSync('sha256', sharedSecret, salt, info, 32);
    return Buffer.from(key);
}

// Generate human-readable fingerprint from key material (12 words = 132 bits)
function generateFingerprint(sharedSecret, salt) {
    const combined = Buffer.concat([sharedSecret, salt]);
    const hash = crypto.createHash('sha256').update(combined).digest();

    // Use 11 bits per word to select from 2048-word BIP39 list
    // 12 words × 11 bits = 132 bits of entropy
    const words = [];
    let bitBuffer = 0;
    let bitsInBuffer = 0;
    let byteIndex = 0;

    for (let i = 0; i < 12; i++) {
        // Accumulate bits until we have at least 11
        while (bitsInBuffer < 11 && byteIndex < hash.length) {
            bitBuffer = (bitBuffer << 8) | hash[byteIndex++];
            bitsInBuffer += 8;
        }
        // Extract 11 bits for word index
        bitsInBuffer -= 11;
        const index = (bitBuffer >> bitsInBuffer) & 0x7FF; // 0x7FF = 2047
        words.push(BIP39_WORDS[index]);
    }
    return words.join('-');
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

// Initialize E2E for a WebSocket connection
function initE2EKeyExchange(ws) {
    const keyPair = generateECDHKeyPair();
    const salt = crypto.randomBytes(16);

    // Store on ws object for later use
    ws.e2e = {
        ecdh: keyPair.ecdh,
        salt: salt,
        sessionKey: null,
        fingerprint: null,
        ready: false
    };

    // Send our public key and salt to client
    ws.send(JSON.stringify({
        type: 'e2e_init',
        publicKey: keyPair.publicKey,
        salt: salt.toString('base64')
    }));

    logDebug('[E2E] Key exchange initiated');
}

// Complete E2E setup when we receive client's public key
function completeE2EKeyExchange(ws, clientPublicKey) {
    if (!ws.e2e || !ws.e2e.ecdh) {
        logDebug('[E2E] Error: No ECDH context for this connection');
        return false;
    }

    try {
        const sharedSecret = deriveSharedSecret(ws.e2e.ecdh, clientPublicKey);
        ws.e2e.sessionKey = deriveSessionKey(sharedSecret, ws.e2e.salt);
        ws.e2e.fingerprint = generateFingerprint(sharedSecret, ws.e2e.salt);
        ws.e2e.ready = true;

        // Update global fingerprint for tray display (shown in right-click menu)
        currentFingerprint = ws.e2e.fingerprint;

        logDebug(`[E2E] Key exchange complete. Fingerprint: ${ws.e2e.fingerprint}`);

        // Notify client that E2E is ready
        ws.send(JSON.stringify({
            type: 'e2e_ready',
            fingerprint: ws.e2e.fingerprint
        }));

        // Notify renderer to show fingerprint
        if (mainWindow) {
            mainWindow.webContents.send('E2E_FINGERPRINT', ws.e2e.fingerprint);
        }

        return true;
    } catch (e) {
        logDebug(`[E2E] Key exchange failed: ${e.message}`);
        return false;
    }
}

// Send encrypted output to client
function sendEncryptedOutput(ws, data) {
    if (!ws.e2e || !ws.e2e.ready) {
        // Fallback to unencrypted if E2E not ready
        ws.send(JSON.stringify({ type: 'output', data: data }));
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
        logDebug(`[WORKER] Generated new machine ID: ${machineId}`);
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
        mainWindow.loadURL('http://localhost:5174/renderer.html');
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

function syncStateWithRenderer() {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('SYNC_STATE', {
            active: !!server,
            url: currentTunnelUrl,
            fingerprint: currentFingerprint
        });
    }
}

// Build tray context menu (shown on right-click)
function buildTrayMenu() {
    const menuItems = [
        { label: 'Root Operator', enabled: false },
        { type: 'separator' }
    ];

    // Add fingerprint if E2E is active
    if (currentFingerprint) {
        menuItems.push({
            label: `E2E: ${currentFingerprint}`,
            enabled: false,
            toolTip: 'Verify this matches your client device'
        });
        menuItems.push({ type: 'separator' });
    }

    menuItems.push(
        { label: 'Show Window', click: () => showWindow() },
        { type: 'separator' },
        { label: 'Quit', click: () => app.quit() }
    );

    return Menu.buildFromTemplate(menuItems);
}

app.whenReady().then(async () => {
    console.log('App Ready');
    if (app.dock) app.dock.hide();

    const { default: ES } = await import('electron-store');
    store = new ES();
    logFile = path.join(app.getPath('userData'), 'pocket_bridge_debug.log');

    await fixPath();
    createWindow();
    createTray();
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
ipcMain.handle('SET_STORE', (event, key, val) => store.set(key, val));

ipcMain.handle('STOP', () => {
    stopBridge();
    return { success: true };
});

ipcMain.on('QUIT', () => {
    stopBridge();
    app.quit();
});

ipcMain.handle('RESIZE_WINDOW', (event, height) => {
    if (mainWindow) {
        const currentBounds = mainWindow.getBounds();
        mainWindow.setBounds({
            x: currentBounds.x,
            y: currentBounds.y,
            width: currentBounds.width,
            height: height
        }, true);
    }
    return { success: true };
});

ipcMain.handle('SET_TRAY_ICON', (event, isActive) => {
    if (tray) {
        // Active icon does NOT use Template suffix to preserve green color
        const iconName = isActive ? 'tray_icon_active.png' : 'tray_iconTemplate.png';
        const iconPath = path.join(__dirname, iconName);
        tray.setImage(iconPath);
    }
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
    try {
        const result = await customizeSubdomain(newSubdomain);
        // Update current tunnel URL
        currentTunnelUrl = `https://${result.hostname}`;
        // Notify UI
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('TUNNEL_LIVE', currentTunnelUrl);
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

function logDebug(msg) {
    // Only write to file if debug logging is enabled
    if (isDebugLoggingEnabled() && logFile) {
        rotateLogIfNeeded();
        const time = new Date().toISOString();
        const line = `[${time}] ${msg}\n`;
        try {
            fs.appendFileSync(logFile, line);
        } catch (e) {
            // Ignore write errors
        }
    }
}

// 3. BRIDGE LOGIC

// Allowed origins for WebSocket connections
// In production with Cloudflare tunnel, origin will be the tunnel URL
function isOriginAllowed(origin, cfSettings) {
    if (!origin) return true; // Allow connections without origin (CLI tools, etc.)

    // Allow localhost for local development
    if (origin.includes('localhost') || origin.includes('127.0.0.1')) {
        return true;
    }

    // Allow trycloudflare.com quick tunnels
    if (origin.includes('.trycloudflare.com')) {
        return true;
    }

    // Allow Worker-assigned domain (v0x.one and subdomains)
    if (origin.includes(WORKER_DOMAIN)) {
        return true;
    }

    // Allow configured custom domain
    if (cfSettings && cfSettings.domain) {
        const domain = cfSettings.domain.replace(/^https?:\/\//, '');
        if (origin.includes(domain)) {
            return true;
        }
    }

    return false;
}

async function startBridge(cfSettings) {
    // Store settings for origin validation (include Worker domain)
    const storedCfSettings = { ...cfSettings, domain: cfSettings?.domain || WORKER_DOMAIN };

    // A. Start HTTP/WebSocket Server
    server = http.createServer((req, res) => servePWA(req, res));

    // WebSocket server with origin verification
    wss = new WebSocket.Server({
        server,
        verifyClient: (info, callback) => {
            const origin = info.origin || info.req.headers.origin;
            if (isOriginAllowed(origin, storedCfSettings)) {
                callback(true);
            } else {
                logDebug(`[SECURITY] Rejected WebSocket from unauthorized origin: ${origin}`);
                callback(false, 403, 'Forbidden');
            }
        }
    });

    wss.on('connection', (ws, req) => handleConnection(ws, req));

    server.listen(INTERNAL_PORT);

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
            setTimeout(() => mainWindow.webContents.send('TUNNEL_LIVE', url), 1000);
        }
    } else if (cfSettings && cfSettings.token) {
        // Legacy: Stable Tunnel with user-provided Token
        console.log('Starting Stable Tunnel with user token...');
        tunnelProcess = cloudflared.tunnel({ '--token': cfSettings.token });

        if (cfSettings.domain) {
            const url = cfSettings.domain.startsWith('http') ? cfSettings.domain : `https://${cfSettings.domain}`;
            currentTunnelUrl = url;
            setTimeout(() => mainWindow.webContents.send('TUNNEL_LIVE', url), 1000);
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
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('CF_LOG', 'ERR: ' + err.toString());
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
    } catch (e) {
        logDebug('[SYSTEM] Error during cleanup: ' + e.message);
    }

    tunnelProcess = null;
    wakeLock = null;
    server = null;
    ptyProcess = null;
    outputBuffer = "";
    activeClients.clear();
    currentTunnelUrl = null;
    currentFingerprint = null;
    logDebug('[SYSTEM] Bridge stopped.');
}

// 4. CONNECTION HANDLER (The Auth Logic)

// Security: Rate limiting and connection tracking
const CHALLENGE_EXPIRY_MS = 30000; // Challenge expires after 30 seconds
const MAX_CONNECTIONS_PER_MINUTE = 20;
const MAX_AUTH_ATTEMPTS_PER_CONNECTION = 3;
const MAX_INPUT_SIZE = 4096; // Max bytes per input message

let connectionAttempts = [];

function isRateLimited() {
    const now = Date.now();
    // Remove attempts older than 1 minute
    connectionAttempts = connectionAttempts.filter(t => now - t < 60000);
    return connectionAttempts.length >= MAX_CONNECTIONS_PER_MINUTE;
}

function handleConnection(ws, req) {
    // Rate limiting check
    if (isRateLimited()) {
        logDebug('[SECURITY] Rate limit exceeded, rejecting connection');
        ws.close(1008, 'Rate limit exceeded');
        return;
    }
    connectionAttempts.push(Date.now());

    // Track auth attempts per connection
    ws.authAttempts = 0;

    // Send Challenge with timestamp for expiration
    const challenge = crypto.randomBytes(32).toString('hex');
    const challengeTime = Date.now();
    ws.challenge = challenge;
    ws.challengeTime = challengeTime;

    console.log('[WS] Handshaking with challenge:', challenge.substring(0, 8));
    ws.send(JSON.stringify({ type: 'auth_challenge', data: challenge }));

    // Set connection timeout - close if not authenticated within 60 seconds
    ws.authTimeout = setTimeout(() => {
        if (!ws.authenticated) {
            logDebug('[SECURITY] Authentication timeout, closing connection');
            ws.close(1008, 'Authentication timeout');
        }
    }, 60000);

    ws.on('error', (err) => {
        console.error('[WS] Error:', err);
    });

    ws.on('message', (msg) => {
        let m;
        try {
            // Limit message size to prevent DoS
            if (msg.length > 65536) {
                logDebug('[SECURITY] Message too large, ignoring');
                return;
            }
            m = JSON.parse(msg);
        } catch (e) {
            return;
        }

        // Auth Response
        if (!ws.authenticated && m.type === 'auth_response') {
            // Check auth attempt limit
            ws.authAttempts++;
            if (ws.authAttempts > MAX_AUTH_ATTEMPTS_PER_CONNECTION) {
                logDebug('[SECURITY] Too many auth attempts, closing connection');
                ws.close(1008, 'Too many authentication attempts');
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
            if (!m.keyId || typeof m.keyId !== 'string' ||
                !m.signature || typeof m.signature !== 'string') {
                logDebug('[SECURITY] Invalid auth response format');
                return;
            }

            logDebug(`[WS] Auth response from KID: ${m.keyId.substring(0, 8)}`);
            if (verifySignature(m.keyId, m.signature, ws.challenge)) {
                logDebug(`[WS] Auth SUCCESS: ${m.keyId.substring(0, 8)}`);
                ws.authenticated = true;
                clearTimeout(ws.authTimeout);
                ws.send(JSON.stringify({ type: 'auth_success' }));
                // Initiate E2E key exchange
                initE2EKeyExchange(ws);
                startPty(ws);
            } else {
                logDebug(`[WS] Auth PENDING: ${m.keyId.substring(0, 8)}`);
                // Validate JWK before storing in pending
                if (m.jwk && typeof m.jwk === 'object' && m.jwk.kty === 'RSA') {
                    pendingConns.set(m.keyId, ws);
                    mainWindow.webContents.send('AUTH_FAILED', { kid: m.keyId, jwk: m.jwk });
                } else {
                    logDebug('[SECURITY] Invalid JWK format in auth response');
                }
            }
            return;
        }

        // Register Key (If user approves)
        if (m.type === 'register_key') {
            const keys = store.get('keys', []);
            keys.push({ kid: m.kid, jwk: m.jwk });
            store.set('keys', keys);
            ws.send(JSON.stringify({ type: 'registered' }));
            return;
        }

        // E2E: Receive client's ECDH public key
        if (ws.authenticated && m.type === 'e2e_client_key') {
            if (m.publicKey && typeof m.publicKey === 'string') {
                completeE2EKeyExchange(ws, m.publicKey);
            } else {
                logDebug('[E2E] Invalid client key format');
            }
            return;
        }

        // E2E Encrypted Input - only from authenticated clients with E2E
        if (ws.authenticated && m.type === 'e2e_input') {
            if (!ws.e2e || !ws.e2e.ready) {
                logDebug('[E2E] Received encrypted input but E2E not ready');
                return;
            }

            const decrypted = decryptInput(ws, { iv: m.iv, data: m.data, tag: m.tag });
            if (decrypted === null) {
                logDebug('[E2E] Failed to decrypt input');
                return;
            }

            // Limit input size
            let inputData = decrypted;
            if (inputData.length > MAX_INPUT_SIZE) {
                logDebug('[SECURITY] E2E Input too large, truncating');
                inputData = inputData.substring(0, MAX_INPUT_SIZE);
            }

            if (ptyProcess) {
                logDebug(`[PTY] Writing E2E input (len: ${inputData.length})`);
                ptyProcess.write(inputData);
            }
            return;
        }

        // Input - only from authenticated clients (unencrypted fallback)
        if (ws.authenticated && m.type === 'input') {
            // Validate input
            if (typeof m.data !== 'string') {
                logDebug('[SECURITY] Invalid input type');
                return;
            }
            // Limit input size
            if (m.data.length > MAX_INPUT_SIZE) {
                logDebug('[SECURITY] Input too large, truncating');
                m.data = m.data.substring(0, MAX_INPUT_SIZE);
            }

            if (ptyProcess) {
                logDebug(`[PTY] Writing input (len: ${m.data.length})`);
                ptyProcess.write(m.data);
            } else {
                logDebug('[PTY] Error: Input received but ptyProcess is null');
            }
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
        clearTimeout(ws.authTimeout);
        activeClients.delete(ws);
        // Cleanup pending conns if any
        for (let [kid, pWs] of pendingConns.entries()) {
            if (pWs === ws) pendingConns.delete(kid);
        }
    });
}

function verifySignature(kid, signature, challenge) {
    const authorized = store.get('keys', []);
    const key = authorized.find(k => k.kid === kid);

    if (!key) return false;

    try {
        const pubKey = crypto.createPublicKey({ key: key.jwk, format: 'jwk' });

        // Use RSA-PSS verification (more secure than PKCS#1 v1.5)
        const isValid = crypto.verify(
            'sha256',
            Buffer.from(challenge),
            {
                key: pubKey,
                padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
                saltLength: 32 // Must match client's saltLength
            },
            Buffer.from(signature, 'hex')
        );

        return isValid;
    } catch (e) {
        console.error('Signature verification failed:', e);
        return false;
    }
}

function startPty(ws) {
    logDebug(`[PTY] Attaching client. Total: ${activeClients.size + 1}`);
    activeClients.add(ws);

    // If PTY already exists, just send the buffer
    if (ptyProcess) {
        logDebug(`[PTY] PTY exists. Sending buffer (size: ${outputBuffer.length})`);
        // Use encrypted output if E2E is ready, otherwise unencrypted
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
        ws.send(JSON.stringify({ type: 'output', data: '\r\n[SYSTEM] No shell found\r\n' }));
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
        ws.send(JSON.stringify({ type: 'output', data: '\r\n[SYSTEM] Failed to spawn shell: ' + err.message + '\r\n' }));
        return;
    }

    ptyProcess.on('data', d => {
        const raw = d.toString();
        // Log hex of the first few chars if it looks like a symbol
        if (raw.length > 0 && (raw.charCodeAt(0) > 127 || raw.length < 10)) {
            const hex = raw.split('').map(c => '0x' + c.charCodeAt(0).toString(16)).join(' ');
            logDebug(`[PTY] Output Hex: ${hex}`);
        }

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
        outputBuffer += filtered;
        if (outputBuffer.length > 50000) {
            outputBuffer = outputBuffer.slice(-50000);
        }

        for (let client of activeClients) {
            if (client.readyState === WebSocket.OPEN) {
                sendEncryptedOutput(client, filtered);
            }
        }
    });
}

// 5. ASSET SERVER (Serves the PWA code)
function servePWA(req, res) {
    // Security headers for all responses
    const securityHeaders = {
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'X-XSS-Protection': '1; mode=block',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' wss: ws:;"
    };

    // Parse URL and strip query strings
    let urlPath = req.url.split('?')[0];
    if (urlPath === '/') urlPath = '/index.html';

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

ipcMain.handle('REGISTER_KEY', (event, { kid, jwk }) => {
    const keys = store.get('keys', []);
    if (!keys.find(k => k.kid === kid)) {
        keys.push({ kid, jwk });
        store.set('keys', keys);
    }

    // If there's a pending connection, notify it to acceptance
    const ws = pendingConns.get(kid);
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.authenticated = true;
        ws.send(JSON.stringify({ type: 'auth_success' }));
        // Initiate E2E key exchange
        initE2EKeyExchange(ws);
        startPty(ws);
    }
    pendingConns.delete(kid);

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
