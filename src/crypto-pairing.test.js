const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { init } = require('./main/crypto-pairing');

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
        privateJwk,
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
    };
}

function createFakeSocket() {
    const sent = [];
    const closeCalls = [];

    return {
        readyState: WebSocket.OPEN,
        sent,
        closeCalls,
        send(message) {
            sent.push(JSON.parse(message));
        },
        close(code, reason) {
            closeCalls.push({ code, reason });
            this.readyState = WebSocket.CLOSED;
        },
    };
}

async function generateClientEcdh() {
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

function canonicalizeJwkBuffer(jwk) {
    return Buffer.from(JSON.stringify(jwk), 'utf8');
}

async function deriveClientSessionKey(clientKeyPair, clientPublicJwk, serverPublicJwk) {
    const serverPublicKey = await crypto.webcrypto.subtle.importKey(
        'jwk',
        serverPublicJwk,
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        [],
    );

    const sharedSecret = Buffer.from(await crypto.webcrypto.subtle.deriveBits(
        { name: 'ECDH', public: serverPublicKey },
        clientKeyPair.privateKey,
        256,
    ));

    const transcript = Buffer.concat([
        canonicalizeJwkBuffer(clientPublicJwk),
        canonicalizeJwkBuffer(serverPublicJwk),
    ]);
    const salt = crypto.createHash('sha256').update(transcript).digest();
    return Buffer.from(crypto.hkdfSync('sha256', sharedSecret, salt, Buffer.from('root-operator-e2e-v2'), 32));
}

function decryptOutputMessage(message, sessionKey) {
    const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        sessionKey,
        Buffer.from(message.iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(message.tag, 'base64'));
    return Buffer.concat([
        decipher.update(Buffer.from(message.data, 'base64')),
        decipher.final(),
    ]).toString('utf8');
}

function createHarness({ keys = [] } = {}) {
    const store = createStore({ keys });
    const windowMessages = [];
    let currentFingerprint = null;
    let currentSessionStartedAt = null;

    const pairing = init({
        crypto,
        safeStorage: {
            isEncryptionAvailable: () => true,
            encryptString: (value) => Buffer.from(value, 'utf8'),
            decryptString: (value) => Buffer.from(value).toString('utf8'),
        },
        WebSocket,
        getStore: () => store,
        getOperatingMode: () => 'channel',
        getMainWindow: () => ({
            webContents: {
                send: (...args) => {
                    windowMessages.push(args);
                },
            },
        }),
        setCurrentFingerprint: (value) => {
            currentFingerprint = value;
        },
        setCurrentSessionStartedAt: (value) => {
            currentSessionStartedAt = value;
        },
        logDebug: () => {},
    });

    return {
        pairing,
        store,
        getCurrentFingerprint: () => currentFingerprint,
        getCurrentSessionStartedAt: () => currentSessionStartedAt,
        windowMessages,
    };
}

test('successful E2E handshake flushes queued output and updates fingerprint state', async () => {
    const device = createPairingIdentity();
    const harness = createHarness({
        keys: [{ kid: device.kid, jwk: device.publicJwk, name: 'Phone' }],
    });
    const ws = createFakeSocket();
    ws.kid = device.kid;

    harness.pairing.ensureDesktopIdentityReady();
    harness.pairing.sendEncryptedOutput(ws, 'queued-output');

    const initialized = await harness.pairing.initE2EKeyExchange(ws);
    assert.equal(initialized, true);
    assert.deepEqual(ws.pendingOutput, ['queued-output']);

    const client = await generateClientEcdh();
    const clientSignature = device.signBase64(canonicalizeJwkBuffer(client.publicJwk));

    const completed = await harness.pairing.completeE2EKeyExchange(
        ws,
        client.publicJwk,
        clientSignature,
    );

    assert.equal(completed, true);
    assert.equal(ws.e2e.ready, true);
    assert.equal(ws.e2eTimeout, null);
    assert.equal(ws.sent[0].type, 'e2e_server_key');
    assert.equal(ws.sent[1].type, 'operating_mode');
    assert.equal(ws.sent[1].mode, 'channel');
    assert.equal(ws.sent[2].type, 'e2e_output');

    const sessionKey = await deriveClientSessionKey(
        client.keyPair,
        client.publicJwk,
        ws.sent[0].serverEcdhPubJwk,
    );
    assert.equal(decryptOutputMessage(ws.sent[2], sessionKey), 'queued-output');
    assert.equal(harness.getCurrentFingerprint(), ws.e2e.fingerprint);
    assert.match(harness.getCurrentSessionStartedAt(), /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(harness.windowMessages[0][0], 'E2E_FINGERPRINT');
    assert.equal(harness.windowMessages[0][1], ws.e2e.fingerprint);
    assert.deepEqual(ws.pendingOutput, []);
});

test('invalid client E2E signature closes the connection as unauthenticated', async () => {
    const device = createPairingIdentity();
    const harness = createHarness({
        keys: [{ kid: device.kid, jwk: device.publicJwk, name: 'Phone' }],
    });
    const ws = createFakeSocket();
    ws.kid = device.kid;

    harness.pairing.ensureDesktopIdentityReady();
    const initialized = await harness.pairing.initE2EKeyExchange(ws);
    assert.equal(initialized, true);

    const client = await generateClientEcdh();
    const completed = await harness.pairing.completeE2EKeyExchange(
        ws,
        client.publicJwk,
        'invalid-signature',
    );

    assert.equal(completed, false);
    assert.deepEqual(ws.closeCalls.at(-1), {
        code: 4002,
        reason: 'e2e_unauthenticated',
    });
    assert.equal(ws.e2e.ready, false);
    assert.equal(ws.e2eTimeout, null);
});
