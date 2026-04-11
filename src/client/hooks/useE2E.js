import { useState, useRef, useCallback, useEffect } from 'react';

const E2E_INFO = new TextEncoder().encode('root-operator-e2e-v2');

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

function canonicalizeJwk(jwk) {
  return JSON.stringify(jwk);
}

function canonicalizeJwkBytes(jwk) {
  return new TextEncoder().encode(canonicalizeJwk(jwk));
}

function buildTranscriptBytes(clientEcdhPubJwk, serverEcdhPubJwk) {
  const clientBytes = canonicalizeJwkBytes(clientEcdhPubJwk);
  const serverBytes = canonicalizeJwkBytes(serverEcdhPubJwk);
  const transcript = new Uint8Array(clientBytes.length + serverBytes.length);
  transcript.set(clientBytes, 0);
  transcript.set(serverBytes, clientBytes.length);
  return transcript;
}

function isValidRsaPssJwk(jwk) {
  return Boolean(
    jwk
    && typeof jwk === 'object'
    && jwk.kty === 'RSA'
    && typeof jwk.n === 'string'
    && jwk.n
    && typeof jwk.e === 'string'
    && jwk.e
  );
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
    && typeof jwk.d !== 'string'
  );
}

async function loadBIP39Words() {
  const response = await fetch('/bip39-words.json');
  return await response.json();
}

async function generateFingerprint(sharedSecretBits, transcriptSalt) {
  const combined = new Uint8Array(sharedSecretBits.byteLength + transcriptSalt.byteLength);
  combined.set(new Uint8Array(sharedSecretBits), 0);
  combined.set(new Uint8Array(transcriptSalt), sharedSecretBits.byteLength);
  const hash = await window.crypto.subtle.digest('SHA-256', combined);
  const hashBytes = new Uint8Array(hash);
  const wordlist = await loadBIP39Words();
  const words = [];
  let bitBuffer = 0;
  let bitsInBuffer = 0;
  let byteIndex = 0;

  for (let i = 0; i < 12; i++) {
    while (bitsInBuffer < 11 && byteIndex < hashBytes.length) {
      bitBuffer = (bitBuffer << 8) | hashBytes[byteIndex++];
      bitsInBuffer += 8;
    }
    bitsInBuffer -= 11;
    const index = (bitBuffer >> bitsInBuffer) & 0x7FF;
    words.push(wordlist[index]);
  }

  return words.join('-');
}

export function useE2E({ socket, isAuthenticated, serverIdentityJwk, signPayload, onSecurityFailure, disconnect }) {
  const [e2eReady, setE2eReady] = useState(false);
  const [fingerprint, setFingerprint] = useState(null);
  const fingerprintRef = useRef(null);
  const sessionKeyRef = useRef(null);
  const e2eReadyRef = useRef(false);
  const handshakeStartedRef = useRef(false);
  const clientKeyPairRef = useRef(null);
  const clientEcdhPubJwkRef = useRef(null);
  const securityFailureHandledRef = useRef(false);

  const resetE2EState = useCallback(() => {
    setE2eReady(false);
    e2eReadyRef.current = false;
    setFingerprint(null);
    fingerprintRef.current = null;
    sessionKeyRef.current = null;
    handshakeStartedRef.current = false;
    clientKeyPairRef.current = null;
    clientEcdhPubJwkRef.current = null;
  }, []);

  const failClosed = useCallback((message, options = {}) => {
    const { closeSocket = true } = options;

    resetE2EState();

    if (securityFailureHandledRef.current) {
      return;
    }

    securityFailureHandledRef.current = true;
    console.error(`[E2E] ${message}`);
    onSecurityFailure?.(message);

    if (closeSocket && socket && (
      socket.readyState === WebSocket.OPEN
      || socket.readyState === WebSocket.CONNECTING
    )) {
      try {
        socket.close(4002, 'e2e_unauthenticated');
      } catch (error) {
        console.error('[E2E] Failed to close socket after security failure:', error);
      }
    }

    disconnect?.();
  }, [disconnect, onSecurityFailure, resetE2EState, socket]);

  useEffect(() => {
    if (!socket || !isAuthenticated) {
      resetE2EState();
      securityFailureHandledRef.current = false;
    }
  }, [isAuthenticated, resetE2EState, socket]);

  useEffect(() => {
    if (!socket) {
      return undefined;
    }

    const handleClose = (event) => {
      if (event.code === 4002 && event.reason === 'e2e_unauthenticated') {
        failClosed('Authenticated E2E setup failed. Reload and re-pair if the desktop identity changed.', { closeSocket: false });
      }
    };

    socket.addEventListener('close', handleClose);
    return () => socket.removeEventListener('close', handleClose);
  }, [failClosed, socket]);

  useEffect(() => {
    if (!socket || socket.readyState !== WebSocket.OPEN || !isAuthenticated) {
      return undefined;
    }

    if (e2eReadyRef.current || handshakeStartedRef.current) {
      return undefined;
    }

    if (!isValidRsaPssJwk(serverIdentityJwk)) {
      failClosed('Stored desktop identity missing or invalid. Re-pair this device before starting E2E.');
      return undefined;
    }

    handshakeStartedRef.current = true;
    let cancelled = false;

    (async () => {
      try {
        console.log('[E2E] Starting authenticated key exchange');

        const clientKeyPair = await window.crypto.subtle.generateKey(
          { name: 'ECDH', namedCurve: 'P-256' },
          true,
          ['deriveBits']
        );

        const clientEcdhPubJwk = await window.crypto.subtle.exportKey('jwk', clientKeyPair.publicKey);
        if (!isValidEcdhPublicJwk(clientEcdhPubJwk)) {
          throw new Error('generated an invalid ECDH public key');
        }

        const clientSignature = await signPayload(canonicalizeJwkBytes(clientEcdhPubJwk));
        if (cancelled || !socket || socket.readyState !== WebSocket.OPEN) {
          return;
        }

        clientKeyPairRef.current = clientKeyPair;
        clientEcdhPubJwkRef.current = clientEcdhPubJwk;

        socket.send(JSON.stringify({
          type: 'e2e_client_key',
          clientEcdhPubJwk,
          clientSignature
        }));

        console.log('[E2E] Sent signed client ECDH key');
      } catch (error) {
        if (!cancelled) {
          failClosed(`Failed to start authenticated E2E: ${error.message}`);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [failClosed, isAuthenticated, serverIdentityJwk, signPayload, socket]);

  const handleServerKeyMessage = useCallback(async (msg) => {
    if (e2eReadyRef.current) {
      return;
    }

    if (!clientKeyPairRef.current?.privateKey || !clientEcdhPubJwkRef.current) {
      failClosed('Received unexpected server E2E key before the client handshake was ready.');
      return;
    }

    if (!isValidRsaPssJwk(serverIdentityJwk)) {
      failClosed('Stored desktop identity missing or invalid. Re-pair this device before continuing.');
      return;
    }

    if (!isValidEcdhPublicJwk(msg.serverEcdhPubJwk) || typeof msg.serverSignature !== 'string' || !msg.serverSignature) {
      failClosed('Received malformed server E2E payload.');
      return;
    }

    try {
      const transcript = buildTranscriptBytes(clientEcdhPubJwkRef.current, msg.serverEcdhPubJwk);
      const transcriptSalt = await window.crypto.subtle.digest('SHA-256', transcript);
      const serverIdentityKey = await window.crypto.subtle.importKey(
        'jwk',
        serverIdentityJwk,
        {
          name: 'RSA-PSS',
          hash: 'SHA-256'
        },
        false,
        ['verify']
      );

      const verified = await window.crypto.subtle.verify(
        { name: 'RSA-PSS', saltLength: 32 },
        serverIdentityKey,
        base64ToArrayBuffer(msg.serverSignature),
        transcript
      );

      if (!verified) {
        failClosed('Desktop E2E signature verification failed.');
        return;
      }

      const serverEcdhKey = await window.crypto.subtle.importKey(
        'jwk',
        msg.serverEcdhPubJwk,
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        []
      );

      const sharedSecretBits = await window.crypto.subtle.deriveBits(
        { name: 'ECDH', public: serverEcdhKey },
        clientKeyPairRef.current.privateKey,
        256
      );

      const sharedSecretKey = await window.crypto.subtle.importKey(
        'raw',
        sharedSecretBits,
        'HKDF',
        false,
        ['deriveKey']
      );

      // Bind both ephemeral keys into the HKDF salt so the key schedule matches the signed transcript.
      sessionKeyRef.current = await window.crypto.subtle.deriveKey(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt: transcriptSalt,
          info: E2E_INFO
        },
        sharedSecretKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      );

      // Flip e2eReady BEFORE the fingerprint computation. The fingerprint is
      // informational only — the lock icon is the real indicator — so it must
      // never block decryption. Previously the BIP39 word-list fetch inside
      // generateFingerprint sat on the critical path, opening a window where
      // an already-decryptable session still silently dropped `channel_history`.
      e2eReadyRef.current = true;
      setE2eReady(true);
      console.log('[E2E] Encryption active. Desktop signature verified.');

      generateFingerprint(sharedSecretBits, transcriptSalt)
        .then((fp) => {
          fingerprintRef.current = fp;
          setFingerprint(fp);
        })
        .catch((err) => {
          console.warn('[E2E] Fingerprint generation failed (informational only):', err);
        });
    } catch (error) {
      failClosed(`Failed to verify authenticated E2E response: ${error.message}`);
    }
  }, [failClosed, serverIdentityJwk]);

  const encryptInput = useCallback(async (plaintext) => {
    if (!e2eReadyRef.current || !sessionKeyRef.current) {
      return null;
    }

    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plaintext);

    const ciphertext = await window.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv },
      sessionKeyRef.current,
      encoded
    );

    const ciphertextArray = new Uint8Array(ciphertext);
    const data = ciphertextArray.slice(0, -16);
    const tag = ciphertextArray.slice(-16);

    return {
      iv: arrayBufferToBase64(iv),
      data: arrayBufferToBase64(data),
      tag: arrayBufferToBase64(tag)
    };
  }, []);

  const decryptOutput = useCallback(async (encrypted) => {
    if (!e2eReadyRef.current || !sessionKeyRef.current) {
      return null;
    }

    try {
      const iv = base64ToArrayBuffer(encrypted.iv);
      const data = base64ToArrayBuffer(encrypted.data);
      const tag = base64ToArrayBuffer(encrypted.tag);
      const combined = new Uint8Array(data.byteLength + tag.byteLength);

      combined.set(new Uint8Array(data), 0);
      combined.set(new Uint8Array(tag), data.byteLength);

      const decrypted = await window.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv },
        sessionKeyRef.current,
        combined
      );

      return new TextDecoder().decode(decrypted);
    } catch (error) {
      console.error('[E2E] Decryption failed:', error);
      return null;
    }
  }, []);

  return {
    e2eReady,
    fingerprint,
    encryptInput,
    decryptOutput,
    handleServerKeyMessage
  };
}
