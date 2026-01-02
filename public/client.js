/**
 * POCKET BRIDGE - CLIENT (iOS PWA)
 */

let socket;
let term;
let fitAddon;
let keyPair;
let keyId;

const statusEl = document.getElementById('auth-status');
const overlayEl = document.getElementById('auth-overlay');
let outputQueue = [];
let ctrlActive = false;
let shiftActive = false;

// E2E Encryption State
let e2eState = {
    ready: false,
    sessionKey: null,
    fingerprint: null
};

// Word list for fingerprint (must match server)
const FINGERPRINT_WORDS = [
    'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel',
    'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa',
    'quebec', 'romeo', 'sierra', 'tango', 'uniform', 'victor', 'whiskey', 'xray',
    'yankee', 'zulu', 'amber', 'bronze', 'coral', 'dune', 'ember', 'frost'
];

// E2E Helper Functions
function base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
}

function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

// Handle E2E key exchange initiation from server
async function handleE2EInit(serverPublicKey, saltBase64) {
    try {
        console.log('[E2E] Received server public key, starting key exchange');

        // Import server's public key
        const serverKeyBytes = base64ToArrayBuffer(serverPublicKey);
        const serverKey = await window.crypto.subtle.importKey(
            'raw',
            serverKeyBytes,
            { name: 'ECDH', namedCurve: 'P-256' },
            false,
            []
        );

        // Generate our ECDH key pair
        const clientKeyPair = await window.crypto.subtle.generateKey(
            { name: 'ECDH', namedCurve: 'P-256' },
            true,
            ['deriveBits']
        );

        // Export our public key to send to server
        const clientPublicKeyRaw = await window.crypto.subtle.exportKey('raw', clientKeyPair.publicKey);
        const clientPublicKeyBase64 = arrayBufferToBase64(clientPublicKeyRaw);

        // Derive shared secret
        const sharedSecretBits = await window.crypto.subtle.deriveBits(
            { name: 'ECDH', public: serverKey },
            clientKeyPair.privateKey,
            256
        );

        // Derive session key using HKDF
        const salt = base64ToArrayBuffer(saltBase64);
        const sharedSecretKey = await window.crypto.subtle.importKey(
            'raw',
            sharedSecretBits,
            'HKDF',
            false,
            ['deriveKey']
        );

        e2eState.sessionKey = await window.crypto.subtle.deriveKey(
            {
                name: 'HKDF',
                hash: 'SHA-256',
                salt: salt,
                info: new TextEncoder().encode('pocket-bridge-e2e-v1')
            },
            sharedSecretKey,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
        );

        // Generate fingerprint (must match server algorithm)
        const combined = new Uint8Array(sharedSecretBits.byteLength + salt.byteLength);
        combined.set(new Uint8Array(sharedSecretBits), 0);
        combined.set(new Uint8Array(salt), sharedSecretBits.byteLength);
        const hash = await window.crypto.subtle.digest('SHA-256', combined);
        const hashBytes = new Uint8Array(hash);

        const words = [];
        for (let i = 0; i < 4; i++) {
            const index = hashBytes[i] % FINGERPRINT_WORDS.length;
            words.push(FINGERPRINT_WORDS[index]);
        }
        e2eState.fingerprint = words.join('-');

        console.log('[E2E] Fingerprint:', e2eState.fingerprint);

        // Send our public key to server
        socket.send(JSON.stringify({
            type: 'e2e_client_key',
            publicKey: clientPublicKeyBase64
        }));

        console.log('[E2E] Sent client public key');
    } catch (e) {
        console.error('[E2E] Key exchange failed:', e);
    }
}

// Handle E2E ready confirmation from server
function handleE2EReady(serverFingerprint) {
    if (serverFingerprint === e2eState.fingerprint) {
        e2eState.ready = true;
        console.log('[E2E] Encryption active! Fingerprint verified:', e2eState.fingerprint);
        showFingerprintUI();
    } else {
        console.error('[E2E] FINGERPRINT MISMATCH! Possible MITM attack.');
        console.error('  Server:', serverFingerprint);
        console.error('  Client:', e2eState.fingerprint);
        // Could show warning UI here
    }
}

// Encrypt message for sending
async function encryptInput(plaintext) {
    if (!e2eState.ready || !e2eState.sessionKey) {
        return null;
    }

    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plaintext);

    const ciphertext = await window.crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv },
        e2eState.sessionKey,
        encoded
    );

    // Extract auth tag (last 16 bytes of ciphertext in WebCrypto)
    const ciphertextArray = new Uint8Array(ciphertext);
    const data = ciphertextArray.slice(0, -16);
    const tag = ciphertextArray.slice(-16);

    return {
        iv: arrayBufferToBase64(iv),
        data: arrayBufferToBase64(data),
        tag: arrayBufferToBase64(tag)
    };
}

// Decrypt message from server
async function decryptOutput(encrypted) {
    if (!e2eState.ready || !e2eState.sessionKey) {
        return null;
    }

    try {
        const iv = base64ToArrayBuffer(encrypted.iv);
        const data = base64ToArrayBuffer(encrypted.data);
        const tag = base64ToArrayBuffer(encrypted.tag);

        // Combine data and tag (WebCrypto expects them together)
        const combined = new Uint8Array(data.byteLength + tag.byteLength);
        combined.set(new Uint8Array(data), 0);
        combined.set(new Uint8Array(tag), data.byteLength);

        const decrypted = await window.crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: iv },
            e2eState.sessionKey,
            combined
        );

        return new TextDecoder().decode(decrypted);
    } catch (e) {
        console.error('[E2E] Decryption failed:', e);
        return null;
    }
}

// Send input (encrypted if E2E ready, otherwise plain)
function sendInput(data) {
    if (e2eState.ready) {
        encryptInput(data).then(encrypted => {
            if (encrypted) {
                socket.send(JSON.stringify({
                    type: 'e2e_input',
                    ...encrypted
                }));
            }
        });
    } else {
        socket.send(JSON.stringify({ type: 'input', data: data }));
    }
}

// Show fingerprint in UI for verification
function showFingerprintUI() {
    // Create or update fingerprint display
    let fpEl = document.getElementById('e2e-fingerprint');
    if (!fpEl) {
        fpEl = document.createElement('div');
        fpEl.id = 'e2e-fingerprint';
        fpEl.style.cssText = `
            position: fixed;
            top: 8px;
            right: 8px;
            background: rgba(0, 128, 0, 0.8);
            color: white;
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 11px;
            font-family: monospace;
            z-index: 1000;
            cursor: pointer;
        `;
        fpEl.title = 'E2E Encrypted - Verify this matches your Mac';
        fpEl.onclick = () => {
            alert('E2E Fingerprint (verify matches Mac tray):\n\n' + e2eState.fingerprint);
        };
        document.body.appendChild(fpEl);
    }
    fpEl.innerText = '🔒 ' + e2eState.fingerprint;
}

async function init() {
    statusEl.innerText = "Loading Security Keys...";
    await setupKeys();

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    // Handle cases where we might be accessing via an IP or custom domain
    const wsUrl = `${protocol}//${window.location.host}`;

    socket = new WebSocket(wsUrl);

    socket.onopen = () => {
        statusEl.innerText = "Connected. Authenticating...";
    };

    socket.onmessage = async (event) => {
        let msg;
        try {
            msg = JSON.parse(event.data);
            console.log('[WS] Received message:', msg.type);
        } catch (e) {
            return;
        }

        if (msg.type === 'auth_challenge') {
            const signature = await signChallenge(msg.data);
            socket.send(JSON.stringify({
                type: 'auth_response',
                keyId: keyId,
                signature: signature,
                jwk: await exportPublicKey()
            }));
        }

        if (msg.type === 'auth_success') {
            overlayEl.style.display = 'none';
            initTerminal();
        }

        // E2E: Server initiates key exchange
        if (msg.type === 'e2e_init') {
            handleE2EInit(msg.publicKey, msg.salt);
        }

        // E2E: Server confirms encryption is ready
        if (msg.type === 'e2e_ready') {
            handleE2EReady(msg.fingerprint);
        }

        // E2E: Encrypted output from server
        if (msg.type === 'e2e_output') {
            decryptOutput({ iv: msg.iv, data: msg.data, tag: msg.tag }).then(plaintext => {
                if (plaintext !== null) {
                    if (term) {
                        term.write(plaintext);
                    } else {
                        outputQueue.push(plaintext);
                    }
                }
            });
        }

        // Unencrypted output (fallback during E2E setup)
        if (msg.type === 'output') {
            if (term) {
                term.write(msg.data);
            } else {
                console.log('QUEUING OUTPUT:', msg.data.length);
                outputQueue.push(msg.data);
            }
        }

        if (msg.type === 'registered') {
            console.log("Device registered successfully");
        }
    };

    socket.onclose = () => {
        overlayEl.style.display = 'flex';
        statusEl.innerText = "Connection Closed. Refresh to reconnect.";
    };

    socket.onerror = (err) => {
        statusEl.innerText = "WebSocket Error. Check tunnel status.";
        console.error("WS Error:", err);
    };
}

// RSA-PSS algorithm parameters
const RSA_PSS_PARAMS = {
    name: "RSA-PSS",
    hash: "SHA-256"
};

const RSA_PSS_SIGN_PARAMS = {
    name: "RSA-PSS",
    saltLength: 32
};

async function setupKeys() {
    const storedKeys = localStorage.getItem('pocket_bridge_keys');
    if (storedKeys) {
        try {
            const { privateJwk, publicJwk, kid } = JSON.parse(storedKeys);
            keyId = kid;

            const privateKey = await window.crypto.subtle.importKey(
                "jwk",
                privateJwk,
                RSA_PSS_PARAMS,
                true,
                ["sign"]
            );

            const publicKey = await window.crypto.subtle.importKey(
                "jwk",
                publicJwk,
                RSA_PSS_PARAMS,
                true,
                ["verify"]
            );

            keyPair = { privateKey, publicKey };
            return;
        } catch (e) {
            console.error("Failed to load stored keys:", e);
        }
    }

    // Generate new RSA-PSS keys
    keyPair = await window.crypto.subtle.generateKey(
        {
            name: "RSA-PSS",
            modulusLength: 2048,
            publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
            hash: "SHA-256",
        },
        true,
        ["sign", "verify"]
    );

    const publicJwk = await exportPublicKey();
    const privateJwk = await window.crypto.subtle.exportKey("jwk", keyPair.privateKey);

    const pubKeyString = JSON.stringify(publicJwk);
    const hashBuffer = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(pubKeyString));
    keyId = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

    localStorage.setItem('pocket_bridge_keys', JSON.stringify({
        privateJwk,
        publicJwk,
        kid: keyId
    }));
}

async function signChallenge(challenge) {
    const encoder = new TextEncoder();
    const data = encoder.encode(challenge);
    const signature = await window.crypto.subtle.sign(
        RSA_PSS_SIGN_PARAMS,
        keyPair.privateKey,
        data
    );
    return Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function exportPublicKey() {
    return await window.crypto.subtle.exportKey("jwk", keyPair.publicKey);
}

function initTerminal() {
    if (term) return; // Prevent double init

    term = new Terminal({
        cursorBlink: true,
        theme: {
            background: '#000',
            foreground: '#fff',
            cursor: '#888',
            selectionBackground: '#333'
        },
        fontSize: 14,
        fontFamily: 'Menlo, Monaco, "Courier New", monospace'
    });

    fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(document.getElementById('terminal'));

    // Slight delay to ensure parent dimensions are ready
    setTimeout(() => {
        fitAddon.fit();
        socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        term.focus();

        // Flush queue
        console.log('FLUSHING OUTPUT QUEUE:', outputQueue.length);
        while (outputQueue.length > 0) {
            term.write(outputQueue.shift());
        }
    }, 100);

    // Suppress iOS keyboard accessory bar (the "Done" bar)
    function refineTextarea() {
        const textarea = document.querySelector('.xterm-helper-textarea');
        if (textarea) {
            textarea.setAttribute('autocomplete', 'off');
            textarea.setAttribute('autocorrect', 'off');
            textarea.setAttribute('autocapitalize', 'off');
            textarea.setAttribute('spellcheck', 'false');
            // 'email' or 'url' inputmode sometimes removes the accessory bar
            textarea.setAttribute('inputmode', 'email');
            textarea.setAttribute('enterkeyhint', 'send');
        }
    }

    // xterm might recreate the textarea, so we check periodically
    setInterval(refineTextarea, 1000);

    // Click terminal to force focus (important for mobile safari)
    document.body.addEventListener('click', (e) => {
        if (!e.target.closest('#toolbar')) {
            term.focus();
            // Force scroll to top to prevent iOS bounce
            window.scrollTo(0, 0);
        }
    });

    // Handle Visual Viewport for mobile keyboards
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', () => {
            const container = document.getElementById('terminal-container');
            container.style.height = `${window.visualViewport.height}px`;
            window.scrollTo(0, 0);
            fitAddon.fit();
        });
    }

    term.onData(data => {
        let finalData = data;

        if (ctrlActive && data.length === 1) {
            const code = data.charCodeAt(0);
            // Handle lowercase a-z (97-122) -> 1-26
            if (code >= 97 && code <= 122) {
                finalData = String.fromCharCode(code - 96);
            }
            // Handle uppercase A-Z (65-90) -> 1-26
            else if (code >= 65 && code <= 90) {
                finalData = String.fromCharCode(code - 64);
            }
            // Handle other common Ctrl mappings
            else if (data === '[') finalData = '\x1b';
            else if (data === '\\') finalData = '\x1c';
            else if (data === ']') finalData = '\x1d';
            else if (data === '^') finalData = '\x1e';
            else if (data === '_') finalData = '\x1f';

            // Reset Ctrl
            ctrlActive = false;
            const ctrlBtn = document.querySelector('[data-key="ctrl"]');
            if (ctrlBtn) ctrlBtn.classList.remove('active');
        } else if (shiftActive && data.length === 1) {
            finalData = data.toUpperCase();

            // Reset Shift
            shiftActive = false;
            const shiftBtn = document.querySelector('[data-key="shift"]');
            if (shiftBtn) shiftBtn.classList.remove('active');
        }

        sendInput(finalData);
    });

    initToolbar();

    window.addEventListener('resize', () => {
        fitAddon.fit();
        socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    });
}

function initToolbar() {
    const toolbar = document.getElementById('toolbar');
    if (!toolbar) return;

    toolbar.addEventListener('click', (e) => {
        const btn = e.target.closest('.tool-btn');
        if (!btn) return;
        const key = btn.dataset.key;

        // Prevent stealing focus from terminal
        e.preventDefault();
        term.focus();

        // Use sendInput for E2E encryption support
        const send = (str) => sendInput(str);

        switch (key) {
            case 'esc': send('\x1b'); break;
            case 'tab': send('\x09'); break;
            case 'shift':
                shiftActive = !shiftActive;
                btn.classList.toggle('active', shiftActive);
                break;
            case 'ctrl':
                ctrlActive = !ctrlActive;
                btn.classList.toggle('active', ctrlActive);
                break;
            case 'up': send('\x1b[A'); break;
            case 'down': send('\x1b[B'); break;
            case 'left': send('\x1b[D'); break;
            case 'right': send('\x1b[C'); break;
        }
    });
}

init();
