function requireDependency(name, value) {
    if (value === undefined || value === null) {
        throw new TypeError(`websocket-bridge.init missing dependency: ${name}`);
    }
    return value;
}
function requireFunction(name, value) {
    if (typeof value !== 'function') {
        throw new TypeError(`websocket-bridge.init expected function dependency: ${name}`);
    }
    return value;
}
function init(deps = {}) {
    const fs = requireDependency('fs', deps.fs);
    const path = requireDependency('path', deps.path);
    const crypto = requireDependency('crypto', deps.crypto);
    const WebSocket = requireDependency('WebSocket', deps.WebSocket);
    const logDebug = typeof deps.logDebug === 'function' ? deps.logDebug : () => {};
    const getStore = requireFunction('getStore', deps.getStore);
    const getOperatingMode = requireFunction('getOperatingMode', deps.getOperatingMode);
    const setOperatingMode = requireFunction('setOperatingMode', deps.setOperatingMode);
    const getPtyProcess = requireFunction('getPtyProcess', deps.getPtyProcess);
    const getStoredPairedKeys = requireFunction('getStoredPairedKeys', deps.getStoredPairedKeys);
    const getAuthorizedPairedKeys = requireFunction('getAuthorizedPairedKeys', deps.getAuthorizedPairedKeys);
    const getActiveClients = requireFunction('getActiveClients', deps.getActiveClients);
    const startPty = requireFunction('startPty', deps.startPty);
    const ensureAttachmentsDir = requireFunction('ensureAttachmentsDir', deps.ensureAttachmentsDir);
    const submitChannelUserMessage = requireFunction('submitChannelUserMessage', deps.submitChannelUserMessage);
    const parseStructuredChannelInput = requireFunction('parseStructuredChannelInput', deps.parseStructuredChannelInput);
    const buildAttachmentBytesResponsePayload = requireFunction('buildAttachmentBytesResponsePayload', deps.buildAttachmentBytesResponsePayload);
    const sendNotificationState = requireFunction('sendNotificationState', deps.sendNotificationState);
    const upsertPushSubscription = requireFunction('upsertPushSubscription', deps.upsertPushSubscription);
    const removePushSubscriptionsForKid = requireFunction('removePushSubscriptionsForKid', deps.removePushSubscriptionsForKid);
    const toPublicPairingJwk = requireFunction('toPublicPairingJwk', deps.toPublicPairingJwk);
    const assertNoPrivatePairingJwkMaterial = requireFunction('assertNoPrivatePairingJwkMaterial', deps.assertNoPrivatePairingJwkMaterial);
    const getDesktopIdentityKeyPair = requireFunction('getDesktopIdentityKeyPair', deps.getDesktopIdentityKeyPair);
    const closeE2EUnavailable = requireFunction('closeE2EUnavailable', deps.closeE2EUnavailable);
    const closeE2EUnauthenticated = requireFunction('closeE2EUnauthenticated', deps.closeE2EUnauthenticated);
    const initE2EKeyExchange = requireFunction('initE2EKeyExchange', deps.initE2EKeyExchange);
    const completeE2EKeyExchange = requireFunction('completeE2EKeyExchange', deps.completeE2EKeyExchange);
    const sendEncryptedOutput = requireFunction('sendEncryptedOutput', deps.sendEncryptedOutput);
    const decryptInput = requireFunction('decryptInput', deps.decryptInput);
    const isValidKeyId = requireFunction('isValidKeyId', deps.isValidKeyId);
    const isValidPairingJwk = requireFunction('isValidPairingJwk', deps.isValidPairingJwk);
    const computeKeyIdFromJwk = requireFunction('computeKeyIdFromJwk', deps.computeKeyIdFromJwk);
    const verifySignatureWithJwk = requireFunction('verifySignatureWithJwk', deps.verifySignatureWithJwk);
    const attachmentsDir = requireDependency('attachmentsDir', deps.attachmentsDir);
    const pairingCodeExpiryMs = deps.pairingCodeExpiryMs ?? 120000;
    const challengeExpiryMs = deps.challengeExpiryMs ?? 30000;
    const maxPendingPairings = deps.maxPendingPairings ?? 5;
    const maxPendingPairingsPerSource = deps.maxPendingPairingsPerSource ?? 2;
    const maxConnectionsPerMinute = deps.maxConnectionsPerMinute ?? 20;
    const maxConnectionsPerSourcePerMinute = deps.maxConnectionsPerSourcePerMinute ?? 10;
    const maxAuthAttemptsPerConnection = deps.maxAuthAttemptsPerConnection ?? 3;
    const maxInputSize = deps.maxInputSize ?? 131072;
    const maxFileSize = deps.maxFileSize ?? 100 * 1024 * 1024;
    const maxFileChunkSize = deps.maxFileChunkSize ?? 512 * 1024;
    const maxActiveTransfersPerDevice = deps.maxActiveTransfersPerDevice ?? 3;
    const fileTransferTimeoutMs = deps.fileTransferTimeoutMs ?? 120000;
    const blockedFileExtensions = deps.blockedFileExtensions ?? /\.(exe|bat|cmd|sh|ps1|app|dmg|pkg|msi|vbs|wsf)$/i;
    const sessionRevokedCloseCode = deps.sessionRevokedCloseCode ?? 4001;
    const PAIRING_CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    const pendingPairings = new Map();
    const connectionAttempts = new Map();
    const fileTransfers = new Map();
    function getPendingPairings() {
        return pendingPairings;
    }
    function getLimits() {
        return {
            pairingCodeExpiryMs,
            challengeExpiryMs,
            maxFileSize,
            blockedFileExtensions,
        };
    }
    function getActiveClientSet() {
        return getActiveClients();
    }
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
            const recentAttempts = attempts.filter((timestamp) => now - timestamp < 60000);
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
        const totalAttempts = pruneConnectionAttempts(Date.now());
        const sourceAttempts = connectionAttempts.get(sourceKey) || [];
        if (sourceAttempts.length >= maxConnectionsPerSourcePerMinute) {
            return 'source_connections_per_minute';
        }
        if (totalAttempts >= maxConnectionsPerMinute) {
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
    function generatePairingCode() {
        let code = '';
        const randomBytes = crypto.randomBytes(6);
        for (let index = 0; index < 6; index += 1) {
            code += PAIRING_CODE_CHARS[randomBytes[index] % PAIRING_CODE_CHARS.length];
        }
        return code;
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
        getActiveClientSet().delete(ws);
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
        const deviceId = ws.kid || 'unknown';
        for (const [transferId, transfer] of fileTransfers.entries()) {
            if (transfer.deviceId === deviceId) {
                clearTimeout(transfer.timer);
                fileTransfers.delete(transferId);
                logDebug(`[ATTACH] Cleaned up stale transfer ${transferId} for disconnected device ${deviceId}`);
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
            ws.close(sessionRevokedCloseCode, 'revoked');
        }
    }
    function cleanupExpiredPairings() {
        const now = Date.now();
        for (const [code, data] of pendingPairings.entries()) {
            if (now - data.createdAt > pairingCodeExpiryMs) {
                if (data.ws && data.ws.readyState === WebSocket.OPEN) {
                    data.ws.send(JSON.stringify({ type: 'pairing_expired' }));
                }
                pendingPairings.delete(code);
            }
        }
    }
    function resetState() {
        pendingPairings.clear();
        connectionAttempts.clear();
        for (const transfer of fileTransfers.values()) {
            clearTimeout(transfer.timer);
        }
        fileTransfers.clear();
    }
    function verifySignature(kid, signature, challenge) {
        const authorized = getAuthorizedPairedKeys();
        const key = authorized.find((record) => record.kid === kid);
        const dummyJwk = {
            kty: 'RSA',
            n: 'sXchDaQebSXKcvLb2qxgRuHN6oJFVnVPzIyYzU5jJ1xH7SZdZsSTgkmU8tJYRjpfUJR4u3F6m1l4nxbJgz4qCtJM3vZakXlqXP0nQHJEFg8TU2FJhCwk6aJj0E0xlP4Zs4w0L2QLnv2YGdJaXBcTX0BGZ3xLJtFkJvWZJmjSfJVFrLIvvlD5yLr5XHTYmTnQd4HgxjGQh0kLNTvBVHfBgGJQCJN3BNkNSxGCsHPlqCFfVQCLbPUJFcLYUHJmMY6JGCxE1NJBB2cwf7kQvQ7p3DHsZYQHVbPKhFUQVLnCaM0TVhLmxJM7EapVdRDbMfJxJDhQ0aGYEHJFhK8qQvQwQ',
            e: 'AQAB',
        };
        const keyToVerify = key ? key.jwk : dummyJwk;
        let isValid = false;
        try {
            const pubKey = crypto.createPublicKey({ key: keyToVerify, format: 'jwk' });
            isValid = crypto.verify(
                'sha256',
                Buffer.from(challenge),
                {
                    key: pubKey,
                    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
                    saltLength: 32,
                },
                Buffer.from(signature, 'hex'),
            );
        } catch (error) {
            logDebug(`[SECURITY] Signature verification error: ${error.message}`);
            isValid = false;
        }
        return key ? isValid : false;
    }
    async function handleMessage(ws, rawMessage) {
        ws.lastActivity = Date.now();
        let message;
        try {
            if (rawMessage.length > 1024 * 1024) {
                logDebug('[SECURITY] Message too large, ignoring');
                return;
            }
            message = JSON.parse(rawMessage);
        } catch {
            return;
        }
        if (message.type === 'ping') {
            ws.lastHeartbeat = Date.now();
            if (typeof message.visible === 'boolean') {
                ws.clientVisible = message.visible;
            }
            ws.send(JSON.stringify({ type: 'pong', timestamp: message.timestamp }));
            return;
        }
        if (message.type === 'client_visible') {
            const nowVisible = Boolean(message.visible);
            ws.clientVisible = nowVisible;
            if (nowVisible) {
                ws.lastHeartbeat = Date.now();
            }
            logDebug(`[NOTIFICATIONS] client_visible kid=${(ws.kid || '?').substring(0, 8)} visible=${nowVisible} hb=${ws.lastHeartbeat}`);
            return;
        }
        if (message.type === 'client_capabilities') {
            ws.supportsAttachments = message.supportsAttachments === true;
            logDebug(`[WS] Client capabilities kid=${(ws.kid || '?').substring(0, 8)} attachments=${ws.supportsAttachments}`);
            return;
        }
        if (!ws.authenticated && message.type === 'pairing_request') {
            if (!message.code || typeof message.code !== 'string'
                || !isValidKeyId(message.keyId)
                || !isValidPairingJwk(message.jwk)) {
                ws.send(JSON.stringify({ type: 'pairing_error', message: 'Invalid request' }));
                return;
            }
            const publicPairingJwk = toPublicPairingJwk(message.jwk);
            if (!publicPairingJwk) {
                ws.send(JSON.stringify({ type: 'pairing_error', message: 'Invalid request' }));
                return;
            }
            const code = message.code.toUpperCase();
            if (code.length !== 6 || !/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/.test(code)) {
                ws.send(JSON.stringify({ type: 'pairing_error', message: 'Invalid code format' }));
                return;
            }
            if (computeKeyIdFromJwk(message.jwk) !== message.keyId) {
                logDebug('[SECURITY] Rejected pairing request with mismatched key ID');
                ws.send(JSON.stringify({ type: 'pairing_error', message: 'Invalid device identity' }));
                return;
            }
            const authorized = getAuthorizedPairedKeys();
            if (authorized.find((key) => key.kid === message.keyId)) {
                logDebug(`[PAIRING] Device registered, sending challenge: ${message.keyId.substring(0, 8)}`);
                const challenge = crypto.randomBytes(32).toString('hex');
                ws.challenge = challenge;
                ws.challengeTime = Date.now();
                ws.challengeKeyId = message.keyId;
                ws.send(JSON.stringify({ type: 'auth_challenge', challenge }));
                return;
            }
            cleanupExpiredPairings();
            if (countPendingPairingsForSource(ws.sourceKey || 'unknown') >= maxPendingPairingsPerSource) {
                logDebug('[SECURITY] rate_limit rejected', {
                    sourceKey: ws.sourceKey || 'unknown',
                    reason: 'source_pending_pairings',
                });
                ws.send(JSON.stringify({ type: 'pairing_error', message: 'Too many pending requests' }));
                return;
            }
            if (pendingPairings.size >= maxPendingPairings) {
                logDebug('[SECURITY] rate_limit rejected', {
                    sourceKey: ws.sourceKey || 'unknown',
                    reason: 'global_pending_pairings',
                });
                ws.send(JSON.stringify({ type: 'pairing_error', message: 'Too many pending requests' }));
                return;
            }
            if (pendingPairings.has(code)) {
                ws.send(JSON.stringify({ type: 'pairing_error', message: 'Code already in use' }));
                return;
            }
            pendingPairings.set(code, {
                ws,
                kid: message.keyId,
                jwk: publicPairingJwk,
                createdAt: Date.now(),
                sourceKey: ws.sourceKey || 'unknown',
            });
            ws.send(JSON.stringify({ type: 'pairing_pending', code }));
            logDebug(`[PAIRING] New pairing request initiated for key ${message.keyId.substring(0, 8)}...`);
            return;
        }
        if (!ws.authenticated && message.type === 'auth_response') {
            ws.authAttempts += 1;
            if (ws.authAttempts > maxAuthAttemptsPerConnection) {
                logDebug('[SECURITY] Too many auth attempts, closing connection');
                ws.close(1008, 'Too many authentication attempts');
                return;
            }
            if (!ws.challenge || !ws.challengeTime) {
                logDebug('[SECURITY] Auth response without challenge');
                ws.send(JSON.stringify({ type: 'auth_error', message: 'No challenge issued' }));
                return;
            }
            if (Date.now() - ws.challengeTime > challengeExpiryMs) {
                logDebug('[SECURITY] Challenge expired, rejecting auth');
                ws.send(JSON.stringify({ type: 'auth_error', message: 'Challenge expired' }));
                ws.close(1008, 'Challenge expired');
                return;
            }
            if (!isValidKeyId(message.keyId) || !message.signature || typeof message.signature !== 'string') {
                logDebug('[SECURITY] Invalid auth response format');
                return;
            }
            if (ws.challengeKeyId && message.keyId !== ws.challengeKeyId) {
                logDebug('[SECURITY] KeyId mismatch in auth response');
                ws.send(JSON.stringify({ type: 'auth_error', message: 'Key mismatch' }));
                return;
            }
            logDebug(`[WS] Auth response from KID: ${message.keyId.substring(0, 8)}`);
            const approvedPairing = ws.pendingPairingApproval;
            const isApprovedPairing = approvedPairing && approvedPairing.kid === message.keyId;
            const isValidSignature = isApprovedPairing
                ? verifySignatureWithJwk(approvedPairing.jwk, message.signature, ws.challenge)
                : verifySignature(message.keyId, message.signature, ws.challenge);
            if (isValidSignature) {
                logDebug(`[WS] Auth SUCCESS: ${message.keyId.substring(0, 8)}`);
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
                    getStore().set('keys', keys);
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
                ws.kid = message.keyId;
                ws.lastHeartbeat = Date.now();
                ws.clientVisible = true;
                clearTimeout(ws.authTimeout);
                ws.send(JSON.stringify(
                    isApprovedPairing
                        ? {
                            type: 'pairing_success',
                            serverIdentityJwk: getDesktopIdentityKeyPair()?.publicKeyJwk,
                        }
                        : { type: 'auth_success' },
                ));
                startPty(ws);
                if (isApprovedPairing) {
                    settlePendingPairingApproval(ws, { success: true });
                }
            } else {
                logDebug(`[WS] Auth FAILED: ${message.keyId.substring(0, 8)}`);
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
        if (ws.authenticated && message.type === 'notifications_get_state') {
            sendNotificationState(ws);
            return;
        }
        if (ws.authenticated && message.type === 'notifications_subscribe') {
            const registered = upsertPushSubscription({
                kid: ws.kid,
                subscription: message.subscription,
                platform: message.platform,
                userAgent: message.userAgent,
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
        if (ws.authenticated && message.type === 'notifications_unsubscribe') {
            removePushSubscriptionsForKid(ws.kid);
            sendNotificationState(ws);
            return;
        }
        if (ws.authenticated && message.type === 'e2e_client_key') {
            await completeE2EKeyExchange(ws, message.clientEcdhPubJwk, message.clientSignature);
            return;
        }
        if (ws.authenticated && message.type === 'e2e_input') {
            if (!ws.e2e || !ws.e2e.ready) {
                logDebug('[E2E] Received encrypted input but E2E not ready');
                return;
            }
            if (message.data && message.data.length > maxInputSize * 2) {
                logDebug('[SECURITY] Encrypted payload too large, rejecting before decryption');
                return;
            }
            const decrypted = decryptInput(ws, { iv: message.iv, data: message.data, tag: message.tag });
            if (decrypted === null) {
                logDebug('[E2E] Failed to decrypt input');
                return;
            }
            let inputData = decrypted;
            if (inputData.length > maxInputSize) {
                logDebug('[SECURITY] E2E Input too large, truncating');
                inputData = inputData.substring(0, maxInputSize);
            }
            const structuredInput = parseStructuredChannelInput(inputData);
            if (structuredInput?.type === 'fetch_attachment_bytes') {
                const response = buildAttachmentBytesResponsePayload({
                    requestId: structuredInput.request_id,
                    attachmentId: structuredInput.attachment_id,
                    externalRef: structuredInput.external_ref,
                });
                if (response.isError) {
                    logDebug(`[ATTACH] On-demand fetch failed for ${structuredInput.attachment_id || 'unknown'}: ${response.error}`);
                }
                sendEncryptedOutput(ws, JSON.stringify(response));
                return;
            }
            if (getOperatingMode() === 'channel') {
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
            } else {
                const ptyProcess = getPtyProcess();
                if (ptyProcess) {
                    logDebug(`[PTY] Writing E2E input (len: ${inputData.length})`);
                    ptyProcess.write(inputData);
                }
            }
            return;
        }
        if (ws.authenticated && message.type === 'e2e_file_chunk') {
            if (!ws.e2e || !ws.e2e.ready) {
                logDebug('[E2E] Received file chunk but E2E not ready');
                return;
            }
            const { transferId, chunkIndex, totalChunks, filename, mimeType, fileSize } = message;
            if (!transferId || typeof chunkIndex !== 'number' || typeof totalChunks !== 'number' || !filename) {
                logDebug('[SECURITY] Malformed file chunk metadata');
                return;
            }
            if (!Number.isInteger(chunkIndex) || !Number.isInteger(totalChunks)
                || totalChunks < 1 || totalChunks > Math.ceil(maxFileSize / maxFileChunkSize)
                || chunkIndex < 0 || chunkIndex >= totalChunks) {
                logDebug(`[SECURITY] File chunk index/count out of range: chunk=${chunkIndex} total=${totalChunks}`);
                return;
            }
            if (typeof fileSize === 'number' && fileSize > maxFileSize) {
                logDebug(`[SECURITY] Claimed file size ${fileSize} exceeds limit`);
                return;
            }
            const deviceId = ws.kid || 'unknown';
            const activeForDevice = Array.from(fileTransfers.values()).filter((transfer) => transfer.deviceId === deviceId).length;
            if (!fileTransfers.has(transferId) && activeForDevice >= maxActiveTransfersPerDevice) {
                logDebug(`[SECURITY] Too many active transfers for device ${deviceId}`);
                return;
            }
            if (message.data && message.data.length > maxFileSize * 2) {
                logDebug('[SECURITY] File chunk payload too large');
                return;
            }
            let chunkBuffer;
            try {
                const iv = Buffer.from(message.iv, 'base64');
                const data = Buffer.from(message.data, 'base64');
                const authTag = Buffer.from(message.tag, 'base64');
                const decipher = crypto.createDecipheriv('aes-256-gcm', ws.e2e.sessionKey, iv);
                decipher.setAuthTag(authTag);
                chunkBuffer = Buffer.concat([decipher.update(data), decipher.final()]);
            } catch (error) {
                logDebug(`[SECURITY] File chunk decryption failed: ${error.message}`);
                return;
            }
            if (!fileTransfers.has(transferId)) {
                const timer = setTimeout(() => {
                    logDebug(`[ATTACH] Transfer ${transferId} timed out, cleaning up`);
                    fileTransfers.delete(transferId);
                }, fileTransferTimeoutMs);
                fileTransfers.set(transferId, {
                    chunks: new Map(),
                    totalChunks,
                    filename,
                    mimeType: mimeType || 'application/octet-stream',
                    fileSize: fileSize || 0,
                    caption: message.caption || '',
                    deviceId,
                    timer,
                });
            }
            const transfer = fileTransfers.get(transferId);
            transfer.chunks.set(chunkIndex, chunkBuffer);
            logDebug(`[ATTACH] Chunk ${chunkIndex + 1}/${totalChunks} for ${filename} (${chunkBuffer.length} bytes)`);
            if (transfer.chunks.size === transfer.totalChunks) {
                clearTimeout(transfer.timer);
                fileTransfers.delete(transferId);
                const ordered = [];
                for (let index = 0; index < transfer.totalChunks; index += 1) {
                    const chunk = transfer.chunks.get(index);
                    if (!chunk) {
                        logDebug(`[ATTACH] Missing chunk ${index} for transfer ${transferId}`);
                        return;
                    }
                    ordered.push(chunk);
                }
                const assembled = Buffer.concat(ordered);
                if (assembled.length > maxFileSize) {
                    logDebug(`[SECURITY] Reassembled file exceeds max size: ${assembled.length}`);
                    return;
                }
                const sanitized = path.basename(transfer.filename).replace(/[^a-zA-Z0-9._\- ]/g, '_');
                if (!sanitized || sanitized === '.' || sanitized === '..') {
                    logDebug(`[SECURITY] Invalid filename after sanitization: ${transfer.filename}`);
                    return;
                }
                if (blockedFileExtensions.test(sanitized)) {
                    logDebug(`[SECURITY] Blocked file extension: ${sanitized}`);
                    return;
                }
                ensureAttachmentsDir();
                let finalName = sanitized;
                let destPath = path.join(attachmentsDir, finalName);
                const resolved = path.resolve(destPath);
                if (!resolved.startsWith(attachmentsDir + path.sep) && resolved !== attachmentsDir) {
                    logDebug('[SECURITY] Path traversal attempt blocked');
                    return;
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
                    fs.writeFileSync(destPath, assembled);
                    logDebug(`[ATTACH] Saved: ${finalName} (${assembled.length} bytes, ${transfer.mimeType})`);
                } catch (error) {
                    logDebug(`[ATTACH] Failed to write file: ${error.message}`);
                    return;
                }
                const absPath = destPath;
                const parts = [];
                if (transfer.caption) {
                    parts.push(transfer.caption);
                }
                parts.push(`[File attached: ${transfer.filename}]\nSaved to: ${absPath}`);
                const fileResult = await submitChannelUserMessage(transfer.deviceId, parts.join('\n\n'), transfer.deviceId, {
                    echoToLocalChat: true,
                    senderWs: ws,
                }).catch((error) => {
                    logDebug(`[CHANNEL] File attachment forward failed: ${error.message}`);
                    return { success: false, error: error.message };
                });
                if (!fileResult.success) {
                    logDebug(`[CHANNEL] File attachment forward not successful: ${fileResult.error}`);
                }
            }
            return;
        }
        if (ws.authenticated && message.type === 'set_mode') {
            if (message.mode === 'terminal' || message.mode === 'channel') {
                logDebug(`[MODE] Client requested switch to ${message.mode}`);
                setOperatingMode(message.mode);
            }
            return;
        }
        if (ws.authenticated && message.type === 'resize') {
            const cols = parseInt(message.cols, 10);
            const rows = parseInt(message.rows, 10);
            if (cols > 0 && cols <= 500 && rows > 0 && rows <= 200) {
                const ptyProcess = getPtyProcess();
                if (ptyProcess) {
                    ptyProcess.resize(cols, rows);
                }
            }
        }
    }
    function handleConnection(ws, req) {
        const sourceKey = getClientSourceKey(req);
        ws.sourceKey = sourceKey;
        const desktopIdentityKeyPair = getDesktopIdentityKeyPair();
        if (!desktopIdentityKeyPair?.privateKeyJwk || !desktopIdentityKeyPair?.publicKeyJwk) {
            closeE2EUnavailable(ws, 'Desktop identity unavailable; rejecting bridge connection');
            return;
        }
        const rateLimitReason = isRateLimited(sourceKey);
        if (rateLimitReason) {
            logDebug('[SECURITY] rate_limit rejected', { sourceKey, reason: rateLimitReason });
            ws.close(1008, 'Rate limit exceeded');
            return;
        }
        recordConnectionAttempt(sourceKey);
        ws.authAttempts = 0;
        ws.authTimeout = setTimeout(() => {
            if (!ws.authenticated) {
                logDebug('[SECURITY] Authentication timeout, closing connection');
                ws.close(1008, 'Authentication timeout');
            }
        }, 180000);
        console.log('[WS] Client connected');
        ws.send(JSON.stringify({ type: 'connected' }));
        ws.on('error', (error) => {
            console.error('[WS] Error:', error);
        });
        ws.lastActivity = Date.now();
        ws.lastHeartbeat = Date.now();
        ws.supportsAttachments = false;
        ws.clientVisible = false;
        ws.on('message', async (message) => {
            try {
                await handleMessage(ws, message);
            } catch (error) {
                logDebug(`[WS] Message handler failed: ${error.message}`);
            }
        });
        ws.on('close', () => {
            cleanupClientConnection(ws);
        });
    }
    const cleanupInterval = setInterval(cleanupExpiredPairings, 30000);
    if (typeof cleanupInterval.unref === 'function') {
        cleanupInterval.unref();
    }
    return {
        handleConnection,
        getPendingPairings,
        clearPendingPairings: () => pendingPairings.clear(),
        settlePendingPairingApproval,
        revokeClientConnection,
        cleanupExpiredPairings,
        cleanupClientConnection,
        resetState,
        getLimits,
    };
}
module.exports = {
    init,
};
