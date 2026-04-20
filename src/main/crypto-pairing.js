const DESKTOP_IDENTITY_PRIVATE_JWK_STORE_KEY = 'desktopIdentityPrivateJwk';
const DESKTOP_IDENTITY_PUBLIC_JWK_STORE_KEY = 'desktopIdentityPublicJwk';
const DESKTOP_IDENTITY_KEY_STORE_KEY = 'desktopIdentityKey';
const E2E_UNAUTHENTICATED_CLOSE_CODE = 4002;
const E2E_UNAVAILABLE_CLOSE_CODE = 4003;
const E2E_UNAUTHENTICATED_CLOSE_REASON = 'e2e_unauthenticated';
const E2E_UNAVAILABLE_CLOSE_REASON = 'e2e_unavailable';

function requireDependency(name, value) {
    if (value === undefined || value === null) {
        throw new TypeError(`crypto-pairing.init missing dependency: ${name}`);
    }

    return value;
}

function requireFunction(name, value) {
    if (typeof value !== 'function') {
        throw new TypeError(`crypto-pairing.init expected function dependency: ${name}`);
    }

    return value;
}

function init(deps = {}) {
    const crypto = requireDependency('crypto', deps.crypto);
    const safeStorage = requireDependency('safeStorage', deps.safeStorage);
    const WebSocket = requireDependency('WebSocket', deps.WebSocket);
    const logDebug = typeof deps.logDebug === 'function' ? deps.logDebug : () => {};
    const getStore = requireFunction('getStore', deps.getStore);
    const getOperatingMode = requireFunction('getOperatingMode', deps.getOperatingMode);
    const getMainWindow = requireFunction('getMainWindow', deps.getMainWindow);
    const setCurrentFingerprint = requireFunction('setCurrentFingerprint', deps.setCurrentFingerprint);
    const setCurrentSessionStartedAt = requireFunction('setCurrentSessionStartedAt', deps.setCurrentSessionStartedAt);

    const desktopIdentityPrivateJwkStoreKey = deps.desktopIdentityPrivateJwkStoreKey || DESKTOP_IDENTITY_PRIVATE_JWK_STORE_KEY;
    const desktopIdentityPublicJwkStoreKey = deps.desktopIdentityPublicJwkStoreKey || DESKTOP_IDENTITY_PUBLIC_JWK_STORE_KEY;
    const desktopIdentityKeyStoreKey = deps.desktopIdentityKeyStoreKey || DESKTOP_IDENTITY_KEY_STORE_KEY;
    const e2eUnauthenticatedCloseCode = deps.e2eUnauthenticatedCloseCode ?? E2E_UNAUTHENTICATED_CLOSE_CODE;
    const e2eUnavailableCloseCode = deps.e2eUnavailableCloseCode ?? E2E_UNAVAILABLE_CLOSE_CODE;
    const e2eUnauthenticatedCloseReason = deps.e2eUnauthenticatedCloseReason || E2E_UNAUTHENTICATED_CLOSE_REASON;
    const e2eUnavailableCloseReason = deps.e2eUnavailableCloseReason || E2E_UNAVAILABLE_CLOSE_REASON;

    const PAIRING_JWK_PRIVATE_FIELDS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth'];
    const E2E_INFO = Buffer.from('root-operator-e2e-v2');
    const E2E_SETUP_TIMEOUT_MS = 10000;

    let cachedDesktopIdentityKeyPair = undefined;
    const loggedInvalidStoredPairingKids = new Set();

    function getDesktopIdentityKeyPair() {
        return cachedDesktopIdentityKeyPair ?? null;
    }

    function clearDesktopIdentityKeyPairCache() {
        cachedDesktopIdentityKeyPair = undefined;
    }

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
            buildE2ETranscript(clientEcdhPubJwk, serverEcdhPubJwk),
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
            && jwk.e,
        );
    }

    function isValidRsaPrivateJwk(jwk) {
        return Boolean(
            isValidRsaPssJwk(jwk)
            && typeof jwk.d === 'string'
            && jwk.d,
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

        const store = getStore();
        store.set(desktopIdentityKeyStoreKey, storedKeyPair);

        const verified = store.get(desktopIdentityKeyStoreKey, null);
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
            safeStorage.decryptString(Buffer.from(storedKeyPair.privateJwkEncrypted, 'base64')),
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
            && typeof jwk.d !== 'string',
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

        const store = getStore();
        if (!safeStorage.isEncryptionAvailable()) {
            logDebug('[SECURITY] safeStorage unavailable, desktop identity cannot be secured. E2E disabled.');
            cachedDesktopIdentityKeyPair = null;
            return null;
        }

        const encryptedRecord = store.get(desktopIdentityKeyStoreKey, null);
        if (isEncryptedDesktopIdentityKeyRecord(encryptedRecord)) {
            try {
                cachedDesktopIdentityKeyPair = decryptStoredDesktopIdentityKeyPair(encryptedRecord);
                return cachedDesktopIdentityKeyPair;
            } catch {
                logDebug('[SECURITY] Failed to decrypt desktop identity private key — regenerating');
                const regeneratedKeyPair = generateDesktopIdentityKeyPair();
                storeEncryptedDesktopIdentityKeyPair(regeneratedKeyPair);
                cachedDesktopIdentityKeyPair = regeneratedKeyPair;
                return cachedDesktopIdentityKeyPair;
            }
        }

        const storedPublicJwk = store.get(desktopIdentityPublicJwkStoreKey);
        const storedPrivateJwk = store.get(desktopIdentityPrivateJwkStoreKey);

        if (isValidRsaPssJwk(storedPublicJwk) && isValidRsaPrivateJwk(storedPrivateJwk)) {
            const migratedKeyPair = {
                publicKeyJwk: storedPublicJwk,
                privateKeyJwk: storedPrivateJwk,
            };

            storeEncryptedDesktopIdentityKeyPair(migratedKeyPair);
            store.delete(desktopIdentityPrivateJwkStoreKey);
            store.delete(desktopIdentityPublicJwkStoreKey);

            const verifiedRecord = store.get(desktopIdentityKeyStoreKey, null);
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
            },
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
            ws.close(e2eUnauthenticatedCloseCode, e2eUnauthenticatedCloseReason);
        }
    }

    function closeE2EUnavailable(ws, reason) {
        logDebug(`[E2E] ${reason}`);

        if (ws.e2eTimeout) {
            clearTimeout(ws.e2eTimeout);
            ws.e2eTimeout = null;
        }

        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            ws.close(e2eUnavailableCloseCode, e2eUnavailableCloseReason);
        }
    }

    async function generateECDHKeyPair() {
        const keyPair = await crypto.webcrypto.subtle.generateKey(
            {
                name: 'ECDH',
                namedCurve: 'P-256',
            },
            true,
            ['deriveBits'],
        );

        const publicJwk = await crypto.webcrypto.subtle.exportKey('jwk', keyPair.publicKey);
        return { keyPair, publicJwk };
    }

    async function deriveSharedSecret(privateKey, otherPublicKeyJwk) {
        const otherPublicKey = await crypto.webcrypto.subtle.importKey(
            'jwk',
            otherPublicKeyJwk,
            { name: 'ECDH', namedCurve: 'P-256' },
            false,
            [],
        );

        const sharedSecret = await crypto.webcrypto.subtle.deriveBits(
            { name: 'ECDH', public: otherPublicKey },
            privateKey,
            256,
        );

        return Buffer.from(sharedSecret);
    }

    function deriveSessionKey(sharedSecret, salt) {
        const key = crypto.hkdfSync('sha256', sharedSecret, salt, E2E_INFO, 32);
        return Buffer.from(key);
    }

    function generateFingerprint(sharedSecret, salt) {
        const combined = Buffer.concat([sharedSecret, salt]);
        const hash = crypto.createHash('sha256').update(combined).digest();
        return hash.subarray(0, 8).toString('hex');
    }

    function encryptMessage(plaintext, sessionKey) {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', sessionKey, iv);

        const encrypted = Buffer.concat([
            cipher.update(plaintext, 'utf8'),
            cipher.final(),
        ]);
        const authTag = cipher.getAuthTag();

        return {
            iv: iv.toString('base64'),
            data: encrypted.toString('base64'),
            tag: authTag.toString('base64'),
        };
    }

    function decryptMessage(encrypted, sessionKey) {
        try {
            const iv = Buffer.from(encrypted.iv, 'base64');
            const data = Buffer.from(encrypted.data, 'base64');
            const authTag = Buffer.from(encrypted.tag, 'base64');

            const decipher = crypto.createDecipheriv('aes-256-gcm', sessionKey, iv);
            decipher.setAuthTag(authTag);

            const decrypted = Buffer.concat([
                decipher.update(data),
                decipher.final(),
            ]);

            return decrypted.toString('utf8');
        } catch (error) {
            logDebug(`[E2E] Decryption failed: ${error.message}`);
            return null;
        }
    }

    async function initE2EKeyExchange(ws) {
        const desktopIdentityKeyPair = getDesktopIdentityKeyPair();
        if (!desktopIdentityKeyPair?.privateKeyJwk || !desktopIdentityKeyPair?.publicKeyJwk) {
            logDebug('[E2E] FATAL: desktop identity keypair unavailable; refusing authenticated E2E setup');
            closeE2EUnavailable(ws, 'Desktop identity keypair unavailable');
            return false;
        }

        const keyPair = await generateECDHKeyPair();
        ws.e2e = {
            keyPair: keyPair.keyPair,
            publicJwk: keyPair.publicJwk,
            sessionKey: null,
            fingerprint: null,
            ready: false,
        };

        ws.e2eTimeout = setTimeout(() => {
            if (!ws.e2e?.ready) {
                logDebug('[SECURITY] E2E setup timeout, closing connection');
                ws.close(1008, 'E2E setup timeout');
            }
        }, E2E_SETUP_TIMEOUT_MS);

        logDebug('[E2E] Authenticated key exchange ready; awaiting client key');
        return true;
    }

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

            const transcriptSalt = deriveE2ETranscriptSalt(clientEcdhPubJwk, ws.e2e.publicJwk);
            const sharedSecret = await deriveSharedSecret(ws.e2e.keyPair.privateKey, clientEcdhPubJwk);
            ws.e2e.sessionKey = deriveSessionKey(sharedSecret, transcriptSalt);
            ws.e2e.fingerprint = generateFingerprint(sharedSecret, transcriptSalt);
            ws.e2e.ready = true;

            if (ws.e2eTimeout) {
                clearTimeout(ws.e2eTimeout);
                ws.e2eTimeout = null;
            }

            setCurrentFingerprint(ws.e2e.fingerprint);
            setCurrentSessionStartedAt(new Date().toISOString());

            logDebug(`[E2E] Key exchange complete. Fingerprint: ${ws.e2e.fingerprint}`);

            const desktopIdentityKeyPair = getDesktopIdentityKeyPair();
            const serverSignature = signRsaPssPayload(
                desktopIdentityKeyPair.privateKeyJwk,
                buildE2ETranscript(clientEcdhPubJwk, ws.e2e.publicJwk),
            );

            ws.send(JSON.stringify({
                type: 'e2e_server_key',
                serverEcdhPubJwk: ws.e2e.publicJwk,
                serverSignature,
            }));

            ws.send(JSON.stringify({
                type: 'operating_mode',
                mode: getOperatingMode(),
            }));

            if (ws.pendingOutput && ws.pendingOutput.length > 0) {
                logDebug(`[E2E] Flushing ${ws.pendingOutput.length} buffered messages`);
                for (const data of ws.pendingOutput) {
                    sendEncryptedOutput(ws, data);
                }
                ws.pendingOutput = [];
            }

            const mainWindow = getMainWindow();
            if (mainWindow) {
                mainWindow.webContents.send('E2E_FINGERPRINT', ws.e2e.fingerprint, new Date().toISOString());
            }

            return true;
        } catch (error) {
            closeE2EUnauthenticated(ws, `Key exchange failed: ${error.message}`);
            return false;
        }
    }

    function ensureDesktopIdentityReady() {
        try {
            const desktopIdentityKeyPair = getOrCreateDesktopIdentityKeyPair();
            if (desktopIdentityKeyPair) {
                logDebug('[E2E] Desktop identity keypair ready');
            }
        } catch (error) {
            logDebug(`[E2E] FATAL: failed to initialize desktop identity keypair: ${error.message}`);
        }
    }

    function sendEncryptedOutput(ws, data) {
        if (!ws.e2e || !ws.e2e.ready) {
            if (!ws.pendingOutput) {
                ws.pendingOutput = [];
            }
            ws.pendingOutput.push(data);
            logDebug(`[E2E] Buffering output (${data.length} bytes) until E2E ready`);
            return;
        }

        const encrypted = encryptMessage(data, ws.e2e.sessionKey);
        ws.send(JSON.stringify({
            type: 'e2e_output',
            ...encrypted,
        }));
    }

    function decryptInput(ws, encrypted) {
        if (!ws.e2e || !ws.e2e.ready) {
            return null;
        }
        return decryptMessage(encrypted, ws.e2e.sessionKey);
    }

    function isValidKeyId(keyId) {
        return typeof keyId === 'string' && /^[a-f0-9]{64}$/i.test(keyId);
    }

    function isValidPairingJwk(jwk) {
        return isValidRsaPssJwk(jwk) && !hasForbiddenPairingJwkFields(jwk);
    }

    function getPairedDeviceLabel(kid) {
        if (!kid) {
            return 'Unknown device';
        }

        const keys = getStore()?.get('keys', []) || [];
        const device = keys.find((item) => item.kid === kid);
        return device?.name || kid.substring(0, 12);
    }

    function getStoredPairedKeys() {
        const store = getStore();
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
                Buffer.from(signature, encoding),
            );
        } catch (error) {
            logDebug(`[SECURITY] Pairing signature verification error: ${error.message}`);
            return false;
        }
    }

    return {
        getDesktopIdentityKeyPair,
        clearDesktopIdentityKeyPairCache,
        canonicalizeJwk,
        toPublicPairingJwk,
        assertNoPrivatePairingJwkMaterial,
        getOrCreateDesktopIdentityKeyPair,
        ensureDesktopIdentityReady,
        signRsaPssPayload,
        closeE2EUnauthenticated,
        closeE2EUnavailable,
        initE2EKeyExchange,
        completeE2EKeyExchange,
        sendEncryptedOutput,
        decryptInput,
        isValidKeyId,
        isValidPairingJwk,
        getPairedDeviceLabel,
        getStoredPairedKeys,
        getAuthorizedPairedKeys,
        computeKeyIdFromJwk,
        verifySignatureWithJwk,
    };
}

module.exports = {
    init,
};
