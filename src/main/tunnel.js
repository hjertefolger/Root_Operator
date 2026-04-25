const { spawn } = require('child_process');
const httpModule = require('http');
const netModule = require('net');

const DEFAULT_INTERNAL_PORT = 22000;
const DEFAULT_VITE_CLIENT_PORT = 5175;
const DEFAULT_KEYTAR_SERVICE = 'RootOperator';
const DEFAULT_KEYTAR_CF_TOKEN = 'cloudflare-token';
const DEFAULT_KEYTAR_TUNNEL_TOKEN = 'tunnel-token';
const DEFAULT_KEYTAR_WORKER_PRIVATE_KEY = 'worker-private-key';

function requireDependency(name, value) {
    if (value === undefined || value === null) {
        throw new TypeError(`tunnel.init missing dependency: ${name}`);
    }

    return value;
}

function requireFunction(name, value) {
    if (typeof value !== 'function') {
        throw new TypeError(`tunnel.init expected function dependency: ${name}`);
    }

    return value;
}

function isUsableWindow(targetWindow) {
    return Boolean(
        targetWindow
        && typeof targetWindow.isDestroyed === 'function'
        && !targetWindow.isDestroyed()
    );
}

function loadRuntimeConfig(fs, path, appDir) {
    const configPath = path.join(appDir, 'runtime-config.json');

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

function init(deps = {}) {
    const fs = requireDependency('fs', deps.fs);
    const path = requireDependency('path', deps.path);
    const crypto = requireDependency('crypto', deps.crypto);
    const keytar = requireDependency('keytar', deps.keytar);
    const cloudflared = requireDependency('cloudflared', deps.cloudflared);
    const WebSocket = requireDependency('WebSocket', deps.WebSocket);
    const http = deps.http || httpModule;
    const net = deps.net || netModule;

    const logDebug = typeof deps.logDebug === 'function' ? deps.logDebug : () => {};
    const getStore = requireFunction('getStore', deps.getStore);
    const getMainWindow = requireFunction('getMainWindow', deps.getMainWindow);
    const syncStateWithRenderer = requireFunction('syncStateWithRenderer', deps.syncStateWithRenderer);
    const getOperatingMode = requireFunction('getOperatingMode', deps.getOperatingMode);
    const initChannelMode = requireFunction('initChannelMode', deps.initChannelMode);
    const teardownChannelMode = requireFunction('teardownChannelMode', deps.teardownChannelMode);
    const handleConnection = requireFunction('handleConnection', deps.handleConnection);

    const getCurrentTunnelUrl = requireFunction('getCurrentTunnelUrl', deps.getCurrentTunnelUrl);
    const setCurrentTunnelUrl = requireFunction('setCurrentTunnelUrl', deps.setCurrentTunnelUrl);
    const getIsConnecting = requireFunction('getIsConnecting', deps.getIsConnecting);
    const setIsConnecting = requireFunction('setIsConnecting', deps.setIsConnecting);
    const getServer = requireFunction('getServer', deps.getServer);
    const setServer = requireFunction('setServer', deps.setServer);
    const getWebSocketServer = requireFunction('getWebSocketServer', deps.getWebSocketServer);
    const setWebSocketServer = requireFunction('setWebSocketServer', deps.setWebSocketServer);
    const getTunnelProcess = requireFunction('getTunnelProcess', deps.getTunnelProcess);
    const setTunnelProcess = requireFunction('setTunnelProcess', deps.setTunnelProcess);
    const getWakeLock = requireFunction('getWakeLock', deps.getWakeLock);
    const setWakeLock = requireFunction('setWakeLock', deps.setWakeLock);
    const getPtyProcess = requireFunction('getPtyProcess', deps.getPtyProcess);
    const setPtyProcess = requireFunction('setPtyProcess', deps.setPtyProcess);
    const setOutputBuffer = requireFunction('setOutputBuffer', deps.setOutputBuffer);
    const clearActiveClients = requireFunction('clearActiveClients', deps.clearActiveClients);
    const clearPendingPairings = requireFunction('clearPendingPairings', deps.clearPendingPairings);
    const setCurrentFingerprint = requireFunction('setCurrentFingerprint', deps.setCurrentFingerprint);
    const setCurrentSessionStartedAt = requireFunction('setCurrentSessionStartedAt', deps.setCurrentSessionStartedAt);

    const appDir = requireDependency('appDir', deps.appDir);
    const isDev = Boolean(deps.isDev);
    const runtimeConfig = loadRuntimeConfig(fs, path, appDir);
    const internalPort = deps.internalPort
        || parseInt(process.env.INTERNAL_PORT || runtimeConfig.INTERNAL_PORT, 10)
        || DEFAULT_INTERNAL_PORT;
    const viteClientPort = deps.viteClientPort
        || parseInt(process.env.VITE_CLIENT_PORT || runtimeConfig.VITE_CLIENT_PORT, 10)
        || DEFAULT_VITE_CLIENT_PORT;
    const keytarService = deps.keytarService || DEFAULT_KEYTAR_SERVICE;
    const keytarCfToken = deps.keytarCfToken || DEFAULT_KEYTAR_CF_TOKEN;
    const keytarTunnelToken = deps.keytarTunnelToken || DEFAULT_KEYTAR_TUNNEL_TOKEN;
    const keytarWorkerPrivateKey = deps.keytarWorkerPrivateKey || DEFAULT_KEYTAR_WORKER_PRIVATE_KEY;
    const workerBaseUrl = typeof deps.workerBaseUrl === 'string'
        ? deps.workerBaseUrl
        : (process.env.WORKER_BASE_URL || runtimeConfig.WORKER_BASE_URL || '');
    const workerDomain = typeof deps.workerDomain === 'string'
        ? deps.workerDomain
        : (process.env.WORKER_DOMAIN || runtimeConfig.WORKER_DOMAIN || '');

    if (!isDev) {
        const unpackedBin = path.join(
            appDir.replace('app.asar', 'app.asar.unpacked'),
            'node_modules', 'cloudflared', 'bin', 'cloudflared'
        );
        cloudflared.use(unpackedBin);
    }

    if (!workerBaseUrl || !workerDomain) {
        console.warn('[CONFIG] WORKER_BASE_URL or WORKER_DOMAIN is missing. Tunnel provisioning features will be unavailable.');
    }

    function getMachineId() {
        const store = getStore();
        let machineId = store.get('machineId');
        if (!machineId) {
            machineId = crypto.randomUUID();
            store.set('machineId', machineId);
            logDebug(`[WORKER] Generated new machine ID: ${machineId.substring(0, 8)}...`);
        }
        return machineId;
    }

    async function generateWorkerKeyPair() {
        const { publicKey, privateKey } = await crypto.webcrypto.subtle.generateKey(
            {
                name: 'ECDSA',
                namedCurve: 'P-256',
            },
            true,
            ['sign', 'verify'],
        );

        const publicKeyJWK = await crypto.webcrypto.subtle.exportKey('jwk', publicKey);
        const privateKeyJWK = await crypto.webcrypto.subtle.exportKey('jwk', privateKey);
        return { publicKeyJWK, privateKeyJWK };
    }

    async function signMessage(privateKeyJWK, message) {
        const privateKey = await crypto.webcrypto.subtle.importKey(
            'jwk',
            privateKeyJWK,
            {
                name: 'ECDSA',
                namedCurve: 'P-256',
            },
            false,
            ['sign'],
        );

        const encoder = new TextEncoder();
        const data = encoder.encode(message);
        const signature = await crypto.webcrypto.subtle.sign(
            {
                name: 'ECDSA',
                hash: 'SHA-256',
            },
            privateKey,
            data,
        );

        return Buffer.from(signature).toString('base64');
    }

    async function getOrCreateWorkerKeyPair() {
        const store = getStore();
        const privateKeyJson = await keytar.getPassword(keytarService, keytarWorkerPrivateKey);
        let publicKeyJWK = store.get('workerPublicKeyJWK');

        if (privateKeyJson && publicKeyJWK) {
            const privateKeyJWK = JSON.parse(privateKeyJson);
            return { privateKeyJWK, publicKeyJWK };
        }

        logDebug('[WORKER] Generating new authentication keypair...');
        const keypair = await generateWorkerKeyPair();
        await keytar.setPassword(keytarService, keytarWorkerPrivateKey, JSON.stringify(keypair.privateKeyJWK));
        store.set('workerPublicKeyJWK', keypair.publicKeyJWK);

        logDebug('[WORKER] Authentication keypair generated and stored');
        return { privateKeyJWK: keypair.privateKeyJWK, publicKeyJWK: keypair.publicKeyJWK };
    }

    async function requestTunnelFromWorker() {
        const machineId = getMachineId();
        const { privateKeyJWK, publicKeyJWK } = await getOrCreateWorkerKeyPair();

        const challenge = crypto.randomBytes(32).toString('hex');
        const timestamp = Date.now();
        const message = `${machineId}:${challenge}:${timestamp}`;
        const signature = await signMessage(privateKeyJWK, message);

        logDebug(`[WORKER] Requesting tunnel for machine ${machineId.substring(0, 8)}...`);

        const response = await fetch(`${workerBaseUrl}/api/v1/tunnel/request`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                machineId,
                publicKeyJWK,
                signature,
                challenge,
                timestamp,
            }),
        });

        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.error || `Worker API error: ${response.status}`);
        }
        if (!data.success) {
            throw new Error(data.error || 'Unknown Worker error');
        }

        logDebug(`[WORKER] Tunnel assigned: ${data.hostname}`);
        await keytar.setPassword(keytarService, keytarTunnelToken, data.tunnelToken);
        getStore().set('tunnelSubdomain', data.subdomain);

        return {
            tunnelToken: data.tunnelToken,
            subdomain: data.subdomain,
            hostname: data.hostname,
        };
    }

    async function customizeSubdomain(newSubdomain) {
        const machineId = getMachineId();
        const { privateKeyJWK } = await getOrCreateWorkerKeyPair();
        const normalizedSubdomain = String(newSubdomain || '').toLowerCase();
        const challenge = crypto.randomBytes(32).toString('hex');
        const timestamp = Date.now();
        const message = `${machineId}:${normalizedSubdomain}:${challenge}:${timestamp}`;
        const signature = await signMessage(privateKeyJWK, message);

        logDebug(`[WORKER] Customizing subdomain to: ${newSubdomain}`);

        const response = await fetch(`${workerBaseUrl}/api/v1/tunnel/customize`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                machineId,
                newSubdomain: normalizedSubdomain,
                signature,
                challenge,
                timestamp,
            }),
        });

        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.error || `Worker API error: ${response.status}`);
        }

        getStore().set('tunnelSubdomain', data.subdomain);
        return {
            subdomain: data.subdomain,
            hostname: data.hostname,
            oldSubdomain: data.oldSubdomain,
        };
    }

    async function getCachedTunnelCredentials() {
        const tunnelToken = await keytar.getPassword(keytarService, keytarTunnelToken);
        const subdomain = getStore().get('tunnelSubdomain');

        if (tunnelToken && subdomain) {
            return {
                tunnelToken,
                subdomain,
                hostname: `${subdomain}.${workerDomain}`,
            };
        }

        return null;
    }

    async function getStoredTunnelSettings() {
        const store = getStore();
        const settings = store?.get('cfSettings', {}) || {};
        let token = '';

        try {
            token = (await keytar.getPassword(keytarService, keytarCfToken)) || '';
        } catch (error) {
            logDebug(`[SYSTEM] Failed to read secure tunnel token: ${error.message}`);
        }

        return {
            token,
            domain: settings?.domain || '',
        };
    }

    function serveStaticPWA(req, res) {
        const securityHeaders = {
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'DENY',
            'X-XSS-Protection': '1; mode=block',
            'Referrer-Policy': 'strict-origin-when-cross-origin',
            'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' data: blob:; connect-src 'self' wss: ws:; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self';",
            'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
        };

        let urlPath = req.url.split('?')[0];
        if (urlPath === '/') {
            urlPath = '/client.html';
        }

        try {
            urlPath = decodeURIComponent(urlPath);
        } catch {
            res.writeHead(400, securityHeaders);
            res.end('Bad Request');
            return;
        }

        if (urlPath.includes('\0')) {
            res.writeHead(400, securityHeaders);
            res.end('Bad Request');
            return;
        }

        let basePath;
        let filePath;

        if (urlPath.startsWith('/node_modules/')) {
            basePath = path.join(appDir, 'node_modules');
            filePath = path.join(appDir, urlPath);
        } else if (urlPath.startsWith('/public/')) {
            basePath = path.join(appDir, 'public');
            filePath = path.join(appDir, urlPath);
        } else {
            basePath = path.join(appDir, 'public', 'dist');
            filePath = path.join(appDir, 'public', 'dist', urlPath);
        }

        const normalizedFilePath = path.normalize(filePath);
        const normalizedBasePath = path.normalize(basePath);
        if (!normalizedFilePath.startsWith(normalizedBasePath + path.sep)
            && normalizedFilePath !== normalizedBasePath) {
            logDebug(`[SECURITY] Path traversal attempt blocked: ${urlPath}`);
            res.writeHead(403, securityHeaders);
            res.end('Forbidden');
            return;
        }

        fs.readFile(normalizedFilePath, (error, data) => {
            if (error) {
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
                '.json': 'application/json',
            };

            res.writeHead(200, {
                'Content-Type': mimes[ext] || 'application/octet-stream',
                ...securityHeaders,
            });
            res.end(data);
        });
    }

    function servePWA(req, res) {
        if (isDev) {
            let proxyPath = req.url;
            if (proxyPath === '/' || proxyPath === '') {
                proxyPath = '/client.html';
            }

            const proxyReq = http.request({
                hostname: 'localhost',
                port: viteClientPort,
                path: proxyPath,
                method: req.method,
                headers: req.headers,
            }, (proxyRes) => {
                res.writeHead(proxyRes.statusCode, proxyRes.headers);
                proxyRes.pipe(res);
            });

            proxyReq.on('error', () => {
                console.log('[DEV] Vite client dev server not running, serving static files');
                serveStaticPWA(req, res);
            });

            req.pipe(proxyReq);
            return;
        }

        serveStaticPWA(req, res);
    }

    function checkManualUrl(data) {
        const str = data.toString();
        const match = str.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (match) {
            console.log('TUNNEL_LIVE [Manual]:', match[0]);
            setCurrentTunnelUrl(match[0]);
            const mainWindow = getMainWindow();
            if (isUsableWindow(mainWindow)) {
                mainWindow.webContents.send('TUNNEL_LIVE', match[0]);
            }
        }
    }

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

    function isOriginAllowed(origin, cfSettings) {
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
        } catch {
            logDebug(`[SECURITY] Rejecting malformed origin: ${origin}`);
            return false;
        }

        const originHost = originUrl.hostname.toLowerCase();
        if (originHost === 'localhost' || originHost === '127.0.0.1') {
            return true;
        }

        const allowedHosts = new Set();
        const activeTunnelHost = getHostnameFromUrl(getCurrentTunnelUrl(), 'current tunnel URL');
        if (activeTunnelHost) {
            allowedHosts.add(activeTunnelHost);
        }

        if (cfSettings && cfSettings.domain) {
            const normalizedDomain = cfSettings.domain.startsWith('http')
                ? cfSettings.domain
                : `https://${cfSettings.domain}`;
            const configuredHost = getHostnameFromUrl(normalizedDomain, 'configured domain');
            if (configuredHost && configuredHost === activeTunnelHost) {
                allowedHosts.add(configuredHost);
            }
        }

        return allowedHosts.has(originHost);
    }

    async function startBridge(cfSettings) {
        // Idempotency guard. Multiple paths can fire startBridge concurrently:
        // Cmd+Shift+J shortcut, tray Start, IPC START, RO_AUTO_START_TUNNEL,
        // and pendingTunnelAutoStart recovery. Each pre-checks tunnel state
        // before calling, but their checks aren't atomic with this entry —
        // a 2s setTimeout + an await on stored settings is plenty of room
        // for two callers to race. Re-check here, return benign already-running
        // result without disturbing state.
        if (getIsConnecting() || getServer() || getTunnelProcess()) {
            logDebug('[BRIDGE] startBridge called while already starting/running, ignoring');
            return { alreadyRunning: true };
        }
        setIsConnecting(true);
        syncStateWithRenderer();

        const storedCfSettings = { ...(cfSettings || {}) };
        const server = http.createServer((req, res) => servePWA(req, res));
        const wss = new WebSocket.Server({
            noServer: true,
            maxPayload: 1024 * 1024,
        });

        setServer(server);
        setWebSocketServer(wss);
        wss.on('connection', (ws, req) => handleConnection(ws, req));

        server.on('upgrade', (req, socket, head) => {
            const pathname = req.url;

            if (isDev && pathname && pathname.startsWith('/__vite_hmr')) {
                const viteSocket = net.connect(viteClientPort, 'localhost', () => {
                    const headers = Object.entries(req.headers)
                        .map(([key, value]) => `${key}: ${value}`)
                        .join('\r\n');
                    viteSocket.write(
                        `GET ${pathname} HTTP/1.1\r\n`
                        + `Host: localhost:${viteClientPort}\r\n`
                        + `${headers}\r\n`
                        + `\r\n`,
                    );
                    socket.pipe(viteSocket);
                    viteSocket.pipe(socket);
                });
                viteSocket.on('error', () => socket.destroy());
                socket.on('error', () => viteSocket.destroy());
                return;
            }

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

        server.listen(internalPort, '127.0.0.1');

        if (getOperatingMode() === 'channel') {
            initChannelMode();
        }

        let tunnelToken = null;
        let tunnelHostname = null;

        try {
            console.log('Requesting tunnel from Worker API...');
            const tunnelInfo = await requestTunnelFromWorker();
            tunnelToken = tunnelInfo.tunnelToken;
            tunnelHostname = tunnelInfo.hostname;
            console.log(`Tunnel assigned: ${tunnelHostname}`);
        } catch (workerError) {
            console.log('Worker API unavailable:', workerError.message);
            const cached = await getCachedTunnelCredentials();
            if (cached) {
                console.log('Using cached tunnel credentials');
                tunnelToken = cached.tunnelToken;
                tunnelHostname = cached.hostname;
                const mainWindow = getMainWindow();
                if (isUsableWindow(mainWindow)) {
                    mainWindow.webContents.send('CF_LOG', 'Using cached tunnel (offline mode)');
                }
            }
        }

        let tunnelProcess;
        if (tunnelToken) {
            console.log('Starting Worker-assigned tunnel...');
            tunnelProcess = cloudflared.tunnel({ '--token': tunnelToken });

            if (tunnelHostname) {
                const url = `https://${tunnelHostname}`;
                setCurrentTunnelUrl(url);
                const currentProcess = tunnelProcess;
                setTimeout(() => {
                    if (getTunnelProcess() === currentProcess && getIsConnecting()) {
                        setIsConnecting(false);
                        const mainWindow = getMainWindow();
                        if (isUsableWindow(mainWindow)) {
                            mainWindow.webContents.send('TUNNEL_LIVE', url);
                        }
                    }
                }, 1000);
            }
        } else if (cfSettings && cfSettings.token) {
            console.log('Starting Stable Tunnel with user token...');
            tunnelProcess = cloudflared.tunnel({ '--token': cfSettings.token });

            if (cfSettings.domain) {
                const url = cfSettings.domain.startsWith('http')
                    ? cfSettings.domain
                    : `https://${cfSettings.domain}`;
                setCurrentTunnelUrl(url);
                const currentProcess = tunnelProcess;
                setTimeout(() => {
                    if (getTunnelProcess() === currentProcess && getIsConnecting()) {
                        setIsConnecting(false);
                        const mainWindow = getMainWindow();
                        if (isUsableWindow(mainWindow)) {
                            mainWindow.webContents.send('TUNNEL_LIVE', url);
                        }
                    }
                }, 1000);
            }
        } else {
            console.log('Starting Quick Tunnel (fallback)...');
            const mainWindow = getMainWindow();
            if (isUsableWindow(mainWindow)) {
                mainWindow.webContents.send('CF_LOG', 'Worker unavailable - using temporary Quick Tunnel');
            }
            tunnelProcess = cloudflared.tunnel(['tunnel', '--url', `localhost:${internalPort}`]);
        }

        setTunnelProcess(tunnelProcess);
        tunnelProcess.on('url', (url) => {
            logDebug(`[CF] Tunnel Live: ${url}`);
            setCurrentTunnelUrl(url);
            setIsConnecting(false);
            const mainWindow = getMainWindow();
            if (isUsableWindow(mainWindow)) {
                mainWindow.webContents.send('TUNNEL_LIVE', url);
            }
        });

        tunnelProcess.on('stdout', (data) => {
            const mainWindow = getMainWindow();
            if (isUsableWindow(mainWindow)) {
                mainWindow.webContents.send('CF_LOG', data.toString());
            }
            checkManualUrl(data);
        });

        tunnelProcess.on('stderr', (data) => {
            const mainWindow = getMainWindow();
            if (isUsableWindow(mainWindow)) {
                mainWindow.webContents.send('CF_LOG', data.toString());
            }
            checkManualUrl(data);
        });

        tunnelProcess.on('error', (error) => {
            logDebug(`[CF] Tunnel Error: ${error}`);
            setIsConnecting(false);
            const mainWindow = getMainWindow();
            if (isUsableWindow(mainWindow)) {
                mainWindow.webContents.send('CF_LOG', `ERR: ${error}`);
                syncStateWithRenderer();
            }
        });

        tunnelProcess.on('close', (code) => {
            logDebug(`[CF] Tunnel process exited with code: ${code}`);
            if (getTunnelProcess()) {
                setIsConnecting(false);
                setCurrentTunnelUrl(null);
                setTunnelProcess(null);
                const mainWindow = getMainWindow();
                if (isUsableWindow(mainWindow)) {
                    mainWindow.webContents.send('CF_LOG', `Tunnel exited (code: ${code})`);
                    syncStateWithRenderer();
                }
            }
        });

        setWakeLock(spawn('caffeinate', ['-s']));
    }

    function stopBridge() {
        logDebug('[SYSTEM] Stopping Bridge...');
        try {
            const tunnelProcess = getTunnelProcess();
            if (tunnelProcess) {
                tunnelProcess.removeAllListeners();
                if (typeof tunnelProcess.stop === 'function') {
                    tunnelProcess.stop();
                } else if (tunnelProcess.kill) {
                    tunnelProcess.kill();
                }
            }
        } catch (error) {
            logDebug(`[SYSTEM] Error stopping tunnel: ${error.message}`);
        }

        try {
            const wakeLock = getWakeLock();
            const server = getServer();
            const ptyProcess = getPtyProcess();
            if (wakeLock) {
                wakeLock.kill();
            }
            if (server) {
                server.close();
            }
            if (ptyProcess) {
                ptyProcess.kill();
                setPtyProcess(null);
            }
            teardownChannelMode();
        } catch (error) {
            logDebug(`[SYSTEM] Error during cleanup: ${error.message}`);
        }

        setTunnelProcess(null);
        setWakeLock(null);
        setServer(null);
        setWebSocketServer(null);
        setPtyProcess(null);
        setOutputBuffer('');
        clearActiveClients();
        clearPendingPairings();
        setCurrentTunnelUrl(null);
        setCurrentFingerprint(null);
        setCurrentSessionStartedAt(null);
        setIsConnecting(false);
        logDebug('[SYSTEM] Bridge stopped.');
        syncStateWithRenderer();
    }

    return {
        getMachineId,
        customizeSubdomain,
        getStoredTunnelSettings,
        startBridge,
        stopBridge,
    };
}

module.exports = {
    init,
};
