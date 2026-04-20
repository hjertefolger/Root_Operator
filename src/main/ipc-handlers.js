function requireDependency(name, value) {
    if (value === undefined || value === null) {
        throw new TypeError(`ipc-handlers.init missing dependency: ${name}`);
    }

    return value;
}

function requireFunction(name, value) {
    if (typeof value !== 'function') {
        throw new TypeError(`ipc-handlers.init expected function dependency: ${name}`);
    }

    return value;
}

function init(deps = {}) {
    const ipcMain = requireDependency('ipcMain', deps.ipcMain);
    const BrowserWindow = requireDependency('BrowserWindow', deps.BrowserWindow);
    const app = requireDependency('app', deps.app);
    const fs = requireDependency('fs', deps.fs);
    const path = requireDependency('path', deps.path);
    const keytar = requireDependency('keytar', deps.keytar);
    const crypto = requireDependency('crypto', deps.crypto);

    const getStore = requireFunction('getStore', deps.getStore);
    const syncStateWithRenderer = requireFunction('syncStateWithRenderer', deps.syncStateWithRenderer);
    const startBridge = requireFunction('startBridge', deps.startBridge);
    const stopBridge = requireFunction('stopBridge', deps.stopBridge);
    const getTunnelState = requireFunction('getTunnelState', deps.getTunnelState);
    const getUpdateState = requireFunction('getUpdateState', deps.getUpdateState);
    const createLocalChatWindow = requireFunction('createLocalChatWindow', deps.createLocalChatWindow);
    const getLocalChatState = requireFunction('getLocalChatState', deps.getLocalChatState);
    const normalizeViewerInitState = requireFunction('normalizeViewerInitState', deps.normalizeViewerInitState);
    const createAttachmentViewerWindow = requireFunction('createAttachmentViewerWindow', deps.createAttachmentViewerWindow);
    const getAttachmentViewerContext = requireFunction('getAttachmentViewerContext', deps.getAttachmentViewerContext);
    const normalizeViewerResultPayload = requireFunction('normalizeViewerResultPayload', deps.normalizeViewerResultPayload);
    const buildAttachmentBytesResponsePayload = requireFunction('buildAttachmentBytesResponsePayload', deps.buildAttachmentBytesResponsePayload);
    const submitChannelUserMessage = requireFunction('submitChannelUserMessage', deps.submitChannelUserMessage);
    const ensureAttachmentsDir = requireFunction('ensureAttachmentsDir', deps.ensureAttachmentsDir);
    const sendLocalChatEventToWindow = requireFunction('sendLocalChatEventToWindow', deps.sendLocalChatEventToWindow);
    const dismissUpdateBanner = requireFunction('dismissUpdateBanner', deps.dismissUpdateBanner);
    const setOperatingMode = requireFunction('setOperatingMode', deps.setOperatingMode);
    const getOperatingMode = requireFunction('getOperatingMode', deps.getOperatingMode);
    const setAppQuitting = requireFunction('setAppQuitting', deps.setAppQuitting);
    const getMachineId = requireFunction('getMachineId', deps.getMachineId);
    const customizeSubdomain = requireFunction('customizeSubdomain', deps.customizeSubdomain);
    const toPublicPairingJwk = requireFunction('toPublicPairingJwk', deps.toPublicPairingJwk);
    const settlePendingPairingApproval = requireFunction('settlePendingPairingApproval', deps.settlePendingPairingApproval);
    const removePushSubscriptionsForKid = requireFunction('removePushSubscriptionsForKid', deps.removePushSubscriptionsForKid);
    const revokeClientConnection = requireFunction('revokeClientConnection', deps.revokeClientConnection);
    const logDebug = typeof deps.logDebug === 'function' ? deps.logDebug : () => {};

    const getUpdater = typeof deps.getUpdater === 'function' ? deps.getUpdater : () => null;
    const getDynamicMemory = typeof deps.getDynamicMemory === 'function' ? deps.getDynamicMemory : () => null;
    const getLocalChatWindow = typeof deps.getLocalChatWindow === 'function' ? deps.getLocalChatWindow : () => null;
    const getMainWindow = typeof deps.getMainWindow === 'function' ? deps.getMainWindow : () => null;
    const getTunnelProcess = typeof deps.getTunnelProcess === 'function' ? deps.getTunnelProcess : () => null;
    const getServer = typeof deps.getServer === 'function' ? deps.getServer : () => null;
    const getPendingPairings = typeof deps.getPendingPairings === 'function'
        ? deps.getPendingPairings
        : () => requireDependency('pendingPairings', deps.pendingPairings);
    const getActiveClients = typeof deps.getActiveClients === 'function'
        ? deps.getActiveClients
        : () => requireDependency('activeClients', deps.activeClients);

    const attachmentsDir = requireDependency('attachmentsDir', deps.attachmentsDir);
    const maxFileSize = requireDependency('maxFileSize', deps.maxFileSize);
    const blockedFileExtensions = requireDependency('blockedFileExtensions', deps.blockedFileExtensions);
    const keytarService = requireDependency('keytarService', deps.keytarService);
    const keytarCfToken = requireDependency('keytarCfToken', deps.keytarCfToken);
    const pairingCodeExpiryMs = requireDependency('pairingCodeExpiryMs', deps.pairingCodeExpiryMs);
    const challengeExpiryMs = requireDependency('challengeExpiryMs', deps.challengeExpiryMs);
    const webSocketOpenState = deps.webSocketOpenState ?? 1;

    ipcMain.handle('START', async (event, cfSettings) => {
        try {
            await startBridge(cfSettings);
            return { success: true };
        } catch (error) {
            stopBridge();
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('GET_STORE', (event, key) => {
        const store = getStore();
        return store.get(key);
    });

    ipcMain.handle('SET_STORE', (event, key, val) => {
        const store = getStore();
        store.set(key, val);
        if (key === 'cfSettings') {
            syncStateWithRenderer();
        }
        return true;
    });

    ipcMain.handle('GET_TUNNEL_STATE', () => getTunnelState());
    ipcMain.handle('GET_UPDATE_STATE', () => getUpdateState());
    ipcMain.handle('CHECK_FOR_UPDATES', async () => {
        const updater = getUpdater();
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

    ipcMain.handle('viewer:open', async (event, payload = {}) => {
        try {
            const parentWindow = BrowserWindow.fromWebContents(event.sender);
            if (!parentWindow || parentWindow.isDestroyed()) {
                throw new Error('Parent chat window unavailable');
            }

            const {
                attachments,
                externalRef,
                initialIndex,
                parentChatId,
            } = normalizeViewerInitState(payload);

            if (attachments.length === 0) {
                throw new Error('Viewer attachments missing');
            }
            if (!parentChatId) {
                throw new Error('Viewer parent chat missing');
            }

            const viewerWindow = createAttachmentViewerWindow({
                attachments,
                externalRef,
                initialIndex,
                parentChatId,
                parentWindow,
            });

            return { success: true, windowId: viewerWindow.id };
        } catch (error) {
            return { success: false, error: error.message || 'Failed to open attachment viewer' };
        }
    });

    ipcMain.handle('viewer:get-state', async (event) => {
        try {
            const { state } = getAttachmentViewerContext(event);
            return {
                success: true,
                attachments: state.attachments,
                externalRef: state.externalRef,
                initialIndex: state.initialIndex,
                parentChatId: state.parentChatId,
            };
        } catch (error) {
            return { success: false, error: error.message || 'Viewer state unavailable' };
        }
    });

    ipcMain.handle('FETCH_LOCAL_CHAT_ATTACHMENT_BYTES', async (event, { attachmentId, externalRef } = {}) => {
        const response = buildAttachmentBytesResponsePayload({
            requestId: `desktop-local:${Date.now()}`,
            attachmentId,
            externalRef,
        });

        if (response.isError) {
            return { success: false, error: response.error || 'Attachment unavailable' };
        }

        return {
            success: true,
            attachmentId: response.attachment_id,
            bytesBase64: response.bytesBase64,
            mime: response.mime,
        };
    });

    ipcMain.handle('SEND_LOCAL_CHAT_MESSAGE', async (event, text) => {
        if (typeof text !== 'string' || !text.trim()) {
            return { success: false, error: 'Message is empty' };
        }

        return submitChannelUserMessage('desktop-local', text.trim(), 'desktop-local');
    });

    ipcMain.handle('SEND_LOCAL_CHAT_FILE', async (event, { data, filename, mimeType, caption } = {}) => {
        if (!data || !filename) {
            return { success: false, error: 'Missing file data or filename' };
        }

        const fileBuffer = Buffer.from(data);
        if (fileBuffer.length === 0) {
            return { success: false, error: 'File is empty' };
        }

        if (fileBuffer.length > maxFileSize) {
            return { success: false, error: `File too large (max ${maxFileSize / 1024 / 1024} MB)` };
        }

        const sanitized = path.basename(filename).replace(/[^a-zA-Z0-9._\- ]/g, '_');
        if (!sanitized || sanitized === '.' || sanitized === '..') {
            return { success: false, error: 'Invalid filename' };
        }

        if (blockedFileExtensions.test(sanitized)) {
            return { success: false, error: 'File type not allowed' };
        }

        ensureAttachmentsDir();
        let finalName = sanitized;
        let destPath = path.join(attachmentsDir, finalName);

        const resolved = path.resolve(destPath);
        if (!resolved.startsWith(attachmentsDir + path.sep) && resolved !== attachmentsDir) {
            return { success: false, error: 'Invalid file path' };
        }

        if (fs.existsSync(destPath)) {
            const ext = path.extname(sanitized);
            const base = path.basename(sanitized, ext);
            let counter = 2;
            while (fs.existsSync(destPath)) {
                finalName = `${base}-${counter}${ext}`;
                destPath = path.join(attachmentsDir, finalName);
                counter += 1;
            }
        }

        try {
            fs.writeFileSync(destPath, fileBuffer);
            logDebug(`[ATTACH] Desktop local file saved: ${finalName} (${fileBuffer.length} bytes)`);
        } catch (error) {
            return { success: false, error: `Failed to save: ${error.message}` };
        }

        const parts = [];
        if (caption) {
            parts.push(caption);
        }
        parts.push(`[File attached: ${filename}]\nSaved to: ${destPath}`);
        return submitChannelUserMessage('desktop-local', parts.join('\n\n'), 'desktop-local');
    });

    ipcMain.handle('viewer:annotated', async (event, payload = {}) => {
        try {
            const { state, parentWindow } = getAttachmentViewerContext(event);
            const file = normalizeViewerResultPayload(payload);
            const delivered = sendLocalChatEventToWindow(parentWindow, {
                type: 'viewer_annotated',
                parentChatId: state.parentChatId,
                filename: file.filename,
                mimeType: file.mimeType,
                data: file.data,
            });

            if (!delivered) {
                throw new Error('Parent chat window unavailable');
            }

            return { success: true };
        } catch (error) {
            return { success: false, error: error.message || 'Failed to return annotated attachment' };
        }
    });

    ipcMain.handle('viewer:send-back', async (event, payload = {}) => {
        try {
            const { state, parentWindow } = getAttachmentViewerContext(event);
            const file = normalizeViewerResultPayload(payload);
            const delivered = sendLocalChatEventToWindow(parentWindow, {
                type: 'viewer_send_back',
                parentChatId: state.parentChatId,
                filename: file.filename,
                mimeType: file.mimeType,
                data: file.data,
            });

            if (!delivered) {
                throw new Error('Parent chat window unavailable');
            }

            return { success: true };
        } catch (error) {
            return { success: false, error: error.message || 'Failed to send attachment back to chat' };
        }
    });

    ipcMain.handle('viewer:close', async (event) => {
        try {
            const { viewerWindow } = getAttachmentViewerContext(event);
            viewerWindow.close();
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message || 'Failed to close attachment viewer' };
        }
    });

    ipcMain.handle('TOGGLE_LOCAL_CHAT_ALWAYS_ON_TOP', () => {
        const localChatWindow = getLocalChatWindow();
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
        const updater = getUpdater();
        if (!updater) {
            return { success: false, error: 'Updater not initialized' };
        }
        return updater.installDownloadedUpdate();
    });
    ipcMain.handle('DISMISS_UPDATE_BANNER', (event, version) => dismissUpdateBanner(version));

    ipcMain.handle('SET_OPERATING_MODE', (event, mode) => {
        if (mode !== 'terminal' && mode !== 'channel') {
            return { success: false, error: 'Invalid mode' };
        }
        setOperatingMode(mode);
        return { success: true, mode: getOperatingMode() };
    });

    ipcMain.handle('GET_OPERATING_MODE', () => getOperatingMode());

    ipcMain.handle('STOP', () => {
        stopBridge();
        return { success: true };
    });

    ipcMain.on('QUIT', () => {
        setAppQuitting(true);
        stopBridge();
        app.quit();
    });

    ipcMain.handle('RESIZE_WINDOW', (event, height) => {
        const mainWindow = getMainWindow();
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
        if (typeof deps.setTrayIconState === 'function') {
            deps.setTrayIconState(isActive);
        }
        return { success: true };
    });

    ipcMain.handle('GET_SECURE_TOKEN', async () => {
        try {
            const token = await keytar.getPassword(keytarService, keytarCfToken);
            return token || '';
        } catch (error) {
            console.error('Failed to get secure token:', error.message);
            return '';
        }
    });

    ipcMain.handle('SET_SECURE_TOKEN', async (event, token) => {
        try {
            if (token) {
                await keytar.setPassword(keytarService, keytarCfToken, token);
            } else {
                await keytar.deletePassword(keytarService, keytarCfToken);
            }
            return { success: true };
        } catch (error) {
            console.error('Failed to set secure token:', error.message);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('DELETE_SECURE_TOKEN', async () => {
        try {
            await keytar.deletePassword(keytarService, keytarCfToken);
            return { success: true };
        } catch (error) {
            console.error('Failed to delete secure token:', error.message);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('CUSTOMIZE_SUBDOMAIN', async (event, newSubdomain) => {
        console.log('[SUBDOMAIN] CUSTOMIZE_SUBDOMAIN called with:', newSubdomain);

        const wasTunnelRunning = !!(getTunnelProcess() && getServer());
        console.log('[SUBDOMAIN] Tunnel was running:', wasTunnelRunning);

        try {
            if (wasTunnelRunning) {
                console.log('[SUBDOMAIN] Stopping tunnel before subdomain change...');
                stopBridge();
            }

            const result = await customizeSubdomain(newSubdomain);
            console.log('[SUBDOMAIN] customizeSubdomain result:', result);

            if (wasTunnelRunning) {
                console.log('[SUBDOMAIN] Restarting tunnel with new subdomain...');
                await startBridge({});
            }

            return { success: true, ...result };
        } catch (error) {
            console.error('Failed to customize subdomain:', error.message);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('GET_SUBDOMAIN', () => {
        const store = getStore();
        return store.get('tunnelSubdomain') || null;
    });

    ipcMain.handle('GET_MACHINE_ID', () => getMachineId());

    ipcMain.handle('VERIFY_PAIRING_CODE', async (event, code, deviceName) => {
        const normalizedCode = String(code || '').toUpperCase().replace(/[^ABCDEFGHJKMNPQRSTUVWXYZ23456789]/g, '');
        if (normalizedCode.length !== 6) {
            return { success: false, error: 'Invalid code format' };
        }

        const pendingPairings = getPendingPairings();
        const pairing = pendingPairings.get(normalizedCode);
        if (!pairing) {
            return { success: false, error: 'Code not found or expired' };
        }

        if (Date.now() - pairing.createdAt > pairingCodeExpiryMs) {
            pendingPairings.delete(normalizedCode);
            return { success: false, error: 'Code expired' };
        }

        const ws = pairing.ws;
        if (!ws || ws.readyState !== webSocketOpenState) {
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

        return new Promise((resolve) => {
            const timeoutId = setTimeout(() => {
                if (ws.pendingPairingApproval) {
                    logDebug(`[PAIRING] Device verification timed out: ${pairing.kid.substring(0, 8)}...`);
                    ws.send(JSON.stringify({ type: 'auth_error', message: 'Pairing verification timed out' }));
                    settlePendingPairingApproval(ws, {
                        success: false,
                        error: 'Device verification timed out',
                    });
                    if (ws.readyState === webSocketOpenState) {
                        ws.close(1008, 'Pairing verification timed out');
                    }
                }
            }, challengeExpiryMs);

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

    ipcMain.handle('GET_PAIRED_DEVICES', () => {
        const store = getStore();
        const keys = store.get('keys', []);
        return keys.map((item) => ({
            kid: item.kid,
            name: item.name || item.kid.substring(0, 12),
        }));
    });

    ipcMain.handle('CHECK_DEVICE_NAME_EXISTS', (event, name) => {
        const store = getStore();
        const keys = store.get('keys', []);
        return keys.some((item) => item.name === name);
    });

    ipcMain.handle('REMOVE_PAIRED_DEVICE', (event, kid) => {
        const store = getStore();
        const keys = store.get('keys', []);
        const filtered = keys.filter((item) => item.kid !== kid);
        store.set('keys', filtered);
        removePushSubscriptionsForKid(kid);

        for (const client of Array.from(getActiveClients())) {
            if (client.kid === kid) {
                revokeClientConnection(client, 'Device removed');
            }
        }

        logDebug(`[PAIRING] Device removed: ${kid.substring(0, 8)}`);
        return { success: true };
    });

    return {};
}

module.exports = {
    init,
};
