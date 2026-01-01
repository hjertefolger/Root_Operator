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

        socket.send(JSON.stringify({ type: 'input', data: finalData }));
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

        const send = (str) => socket.send(JSON.stringify({ type: 'input', data: str }));

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
