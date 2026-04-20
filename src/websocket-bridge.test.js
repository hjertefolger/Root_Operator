const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { init } = require('./main/websocket-bridge');

const WebSocket = {
    CONNECTING: 0,
    OPEN: 1,
    CLOSED: 3,
};

function createStore(initial = {}) {
    const values = new Map(Object.entries(initial));
    return {
        get(key, fallback) {
            return values.has(key) ? values.get(key) : fallback;
        },
        set(key, value) {
            values.set(key, value);
        },
        delete(key) {
            values.delete(key);
        },
    };
}

function createPairingIdentity() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicExponent: 0x10001,
    });
    const publicJwk = publicKey.export({ format: 'jwk' });
    const privateJwk = privateKey.export({ format: 'jwk' });
    const kid = crypto.createHash('sha256').update(JSON.stringify(publicJwk)).digest('hex');

    return {
        kid,
        publicJwk,
        signHex(payload) {
            return crypto.sign(
                'sha256',
                Buffer.isBuffer(payload) ? payload : Buffer.from(payload),
                {
                    key: privateKey,
                    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
                    saltLength: 32,
                },
            ).toString('hex');
        },
        signBase64(payload) {
            return crypto.sign(
                'sha256',
                Buffer.isBuffer(payload) ? payload : Buffer.from(payload),
                {
                    key: privateKey,
                    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
                    saltLength: 32,
                },
            ).toString('base64');
        },
        privateJwk,
    };
}

function createFakeSocket() {
    const handlers = new Map();
    const sent = [];
    const closeCalls = [];

    return {
        readyState: WebSocket.OPEN,
        authAttempts: 0,
        sent,
        closeCalls,
        on(event, handler) {
            handlers.set(event, handler);
        },
        send(message) {
            sent.push(JSON.parse(message));
        },
        close(code, reason) {
            closeCalls.push({ code, reason });
            this.readyState = WebSocket.CLOSED;
            const handler = handlers.get('close');
            if (typeof handler === 'function') {
                handler();
            }
        },
        async emitMessage(message) {
            const handler = handlers.get('message');
            if (typeof handler !== 'function') {
                throw new Error('message handler not registered');
            }
            await handler(JSON.stringify(message));
        },
    };
}

function isValidRsaPublicJwk(jwk) {
    return Boolean(
        jwk
        && typeof jwk === 'object'
        && jwk.kty === 'RSA'
        && typeof jwk.n === 'string'
        && jwk.n
        && typeof jwk.e === 'string'
        && jwk.e
        && typeof jwk.d !== 'string'
    );
}

function verifySignatureWithJwk(jwk, signature, payload, encoding = 'hex') {
    if (!isValidRsaPublicJwk(jwk) || typeof signature !== 'string' || !signature) {
        return false;
    }

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
}

function createHarness({ storedKeys = [] } = {}) {
    const store = createStore({ keys: storedKeys });
    const activeClients = new Set();
    const startPtyCalls = [];
    const notificationStateCalls = [];
    const subscriptionCalls = [];
    const removeSubscriptionCalls = [];
    const setModeCalls = [];
    const serverIdentity = createPairingIdentity();

    const bridge = init({
        fs: {
            existsSync: () => false,
            writeFileSync: () => {},
        },
        path: require('node:path'),
        crypto,
        WebSocket,
        logDebug: () => {},
        getStore: () => store,
        getOperatingMode: () => 'channel',
        setOperatingMode: (mode) => {
            setModeCalls.push(mode);
        },
        getPtyProcess: () => null,
        getStoredPairedKeys: () => store.get('keys', []),
        getAuthorizedPairedKeys: () => store.get('keys', []),
        getActiveClients: () => activeClients,
        startPty: (ws) => {
            startPtyCalls.push(ws);
        },
        ensureAttachmentsDir: () => {},
        submitChannelUserMessage: async () => ({ success: true }),
        parseStructuredChannelInput: (value) => value,
        buildAttachmentBytesResponsePayload: () => ({ isError: false }),
        sendNotificationState: (ws) => {
            notificationStateCalls.push(ws);
        },
        upsertPushSubscription: (payload) => {
            subscriptionCalls.push(payload);
            return true;
        },
        removePushSubscriptionsForKid: (kid) => {
            removeSubscriptionCalls.push(kid);
        },
        toPublicPairingJwk: (jwk) => (isValidRsaPublicJwk(jwk) ? { kty: jwk.kty, n: jwk.n, e: jwk.e } : null),
        assertNoPrivatePairingJwkMaterial: (jwk) => {
            if (jwk && typeof jwk === 'object' && typeof jwk.d === 'string') {
                throw new Error('private material not allowed');
            }
        },
        getDesktopIdentityKeyPair: () => ({
            publicKeyJwk: serverIdentity.publicJwk,
            privateKeyJwk: serverIdentity.privateJwk,
        }),
        closeE2EUnavailable: (ws, reason) => {
            ws.close(4003, reason);
        },
        closeE2EUnauthenticated: (ws, reason) => {
            ws.close(4002, reason);
        },
        initE2EKeyExchange: async (ws) => {
            ws.e2e = { ready: false };
            return true;
        },
        completeE2EKeyExchange: async () => true,
        sendEncryptedOutput: () => {},
        decryptInput: () => null,
        isValidKeyId: (keyId) => typeof keyId === 'string' && /^[a-f0-9]{64}$/i.test(keyId),
        isValidPairingJwk: isValidRsaPublicJwk,
        computeKeyIdFromJwk: (jwk) => crypto.createHash('sha256').update(JSON.stringify(jwk)).digest('hex'),
        verifySignatureWithJwk,
        attachmentsDir: '/tmp/attachments',
    });

    function connectSocket(req = { headers: {}, socket: { remoteAddress: '127.0.0.1' } }) {
        const ws = createFakeSocket();
        bridge.handleConnection(ws, req);
        return ws;
    }

    return {
        bridge,
        store,
        connectSocket,
        startPtyCalls,
        notificationStateCalls,
        subscriptionCalls,
        removeSubscriptionCalls,
        setModeCalls,
    };
}

test('pairing_request from a new device enters pending state', async () => {
    const harness = createHarness();
    const device = createPairingIdentity();
    const ws = harness.connectSocket();

    try {
        assert.equal(ws.sent[0].type, 'connected');

        await ws.emitMessage({
            type: 'pairing_request',
            code: 'ABC234',
            keyId: device.kid,
            jwk: device.publicJwk,
        });

        assert.equal(ws.sent.at(-1).type, 'pairing_pending');
        assert.equal(ws.sent.at(-1).code, 'ABC234');
        assert.equal(harness.bridge.getPendingPairings().get('ABC234').kid, device.kid);
    } finally {
        harness.bridge.cleanupClientConnection(ws);
    }
});

test('pairing_request from an authorized device gets an auth challenge instead of pending pairing', async () => {
    const device = createPairingIdentity();
    const harness = createHarness({
        storedKeys: [{ kid: device.kid, jwk: device.publicJwk, name: 'Known phone' }],
    });
    const ws = harness.connectSocket();

    try {
        await ws.emitMessage({
            type: 'pairing_request',
            code: 'QRS789',
            keyId: device.kid,
            jwk: device.publicJwk,
        });

        const response = ws.sent.at(-1);
        assert.equal(response.type, 'auth_challenge');
        assert.equal(typeof response.challenge, 'string');
        assert.equal(response.challenge.length, 64);
        assert.equal(harness.bridge.getPendingPairings().size, 0);
        assert.equal(ws.challengeKeyId, device.kid);
    } finally {
        harness.bridge.cleanupClientConnection(ws);
    }
});

test('approved pairing auth_response stores the device and starts PTY', async () => {
    const harness = createHarness();
    const device = createPairingIdentity();
    const ws = harness.connectSocket();

    let approvalResult = null;

    try {
        const timeoutId = setTimeout(() => {}, 1000);
        ws.challenge = 'abc123-challenge';
        ws.challengeTime = Date.now();
        ws.challengeKeyId = device.kid;
        ws.pendingPairingApproval = {
            kid: device.kid,
            jwk: device.publicJwk,
            name: 'Night Lab Phone',
            timeoutId,
            resolve(result) {
                approvalResult = result;
            },
        };

        await ws.emitMessage({
            type: 'auth_response',
            keyId: device.kid,
            signature: device.signHex(ws.challenge),
        });

        const storedKeys = harness.store.get('keys', []);
        assert.equal(storedKeys.length, 1);
        assert.deepEqual(storedKeys[0], {
            kid: device.kid,
            jwk: device.publicJwk,
            name: 'Night Lab Phone',
        });
        assert.equal(ws.authenticated, true);
        assert.equal(ws.kid, device.kid);
        assert.equal(ws.sent.at(-1).type, 'pairing_success');
        assert.equal(ws.sent.at(-1).serverIdentityJwk.kty, 'RSA');
        assert.equal(harness.startPtyCalls.length, 1);
        assert.equal(harness.startPtyCalls[0], ws);
        assert.deepEqual(approvalResult, { success: true });
        assert.equal(ws.pendingPairingApproval, null);
        assert.equal(ws.challenge, null);
        assert.equal(ws.challengeTime, null);
        assert.equal(ws.challengeKeyId, null);
    } finally {
        harness.bridge.cleanupClientConnection(ws);
    }
});

test('revoked authenticated device is disconnected on the next privileged message', async () => {
    const device = createPairingIdentity();
    const harness = createHarness({
        storedKeys: [{ kid: device.kid, jwk: device.publicJwk, name: 'Known phone' }],
    });
    const ws = harness.connectSocket();
    ws.authenticated = true;
    ws.kid = device.kid;

    try {
        harness.store.set('keys', []);

        await ws.emitMessage({ type: 'notifications_get_state' });

        assert.equal(ws.sent.at(-1).type, 'session_revoked');
        assert.equal(ws.sent.at(-1).reason, 'Device removed');
        assert.deepEqual(ws.closeCalls.at(-1), { code: 4001, reason: 'revoked' });
        assert.equal(harness.notificationStateCalls.length, 0);
    } finally {
        harness.bridge.cleanupClientConnection(ws);
    }
});
