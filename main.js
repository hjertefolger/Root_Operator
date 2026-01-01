/**
 * POCKET BRIDGE - MAIN PROCESS
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

// Secure credential storage constants
const KEYTAR_SERVICE = 'PocketBridge';
const KEYTAR_CF_TOKEN = 'cloudflare-token';

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

// 1. GUI SETUP
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 280, height: 80,
        show: false,
        frame: false,
        fullscreenable: false,
        resizable: false,
        transparent: true,
        backgroundColor: '#000000',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js'),
            sandbox: true
        }
    });

    mainWindow.loadFile('ui/index.html');

    // Hide when it loses focus
    mainWindow.on('blur', () => {
        if (!mainWindow.webContents.isDevToolsOpened()) {
            mainWindow.hide();
        }
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
        tray.setToolTip('Pocket Bridge');
        tray.setIgnoreDoubleClickEvents(true);

        tray.on('click', () => {
            console.log('Tray clicked');
            toggleWindow();
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
    // Store settings for origin validation
    const storedCfSettings = cfSettings;

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

    // B. Start Tunnel (Cloudflare)
    if (cfSettings && cfSettings.token) {
        // Stable Tunnel with Token
        console.log('Starting Stable Tunnel with token...');
        tunnelProcess = cloudflared.tunnel({ '--token': cfSettings.token });

        // If they provided a custom domain, notify the UI immediately
        if (cfSettings.domain) {
            const url = cfSettings.domain.startsWith('http') ? cfSettings.domain : `https://${cfSettings.domain}`;
            setTimeout(() => mainWindow.webContents.send('TUNNEL_LIVE', url), 1000);
        }
    } else {
        // Quick Tunnel Fallback
        console.log('Starting Quick Tunnel...');
        tunnelProcess = cloudflared.tunnel(['tunnel', '--url', `localhost:${INTERNAL_PORT}`]);
    }

    tunnelProcess.on('url', (url) => {
        logDebug(`[CF] Tunnel Live: ${url}`);
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

        // Input - only from authenticated clients
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
        ws.send(JSON.stringify({ type: 'output', data: outputBuffer }));
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

        // Broadcast to all authenticated clients
        const msg = JSON.stringify({ type: 'output', data: filtered });
        outputBuffer += filtered;
        if (outputBuffer.length > 50000) {
            outputBuffer = outputBuffer.slice(-50000);
        }

        for (let client of activeClients) {
            if (client.readyState === WebSocket.OPEN) {
                client.send(msg);
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
        basePath = path.join(__dirname, 'public');
        filePath = path.join(__dirname, 'public', urlPath);
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
        mainWindow.webContents.send('TUNNEL_LIVE', match[0]);
    }
}

// parseTunnelLog is no longer needed since cloudflared package emits 'url' event

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
