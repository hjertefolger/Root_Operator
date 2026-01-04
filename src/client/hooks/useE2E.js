import { useState, useRef, useCallback } from 'react';

// Helper functions
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

// Load BIP39 wordlist
async function loadBIP39Words() {
  const response = await fetch('/public/bip39-words.json');
  return await response.json();
}

export function useE2E(socket) {
  const [e2eReady, setE2eReady] = useState(false);
  const [fingerprint, setFingerprint] = useState(null);
  const sessionKeyRef = useRef(null);

  // Handle E2E key exchange initiation from server
  const handleE2EInit = useCallback(async (serverPublicKey, saltBase64) => {
    if (!socket) return;

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

      sessionKeyRef.current = await window.crypto.subtle.deriveKey(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt: salt,
          info: new TextEncoder().encode('root-operator-e2e-v1')
        },
        sharedSecretKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      );

      // Generate fingerprint (must match server algorithm - 12 words = 132 bits)
      const combined = new Uint8Array(sharedSecretBits.byteLength + salt.byteLength);
      combined.set(new Uint8Array(sharedSecretBits), 0);
      combined.set(new Uint8Array(salt), sharedSecretBits.byteLength);
      const hash = await window.crypto.subtle.digest('SHA-256', combined);
      const hashBytes = new Uint8Array(hash);

      // Load BIP39 wordlist
      const wordlist = await loadBIP39Words();

      // Use 11 bits per word to select from 2048-word BIP39 list
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
      const fp = words.join('-');
      setFingerprint(fp);

      console.log('[E2E] Fingerprint:', fp);

      // Send our public key to server
      socket.send(JSON.stringify({
        type: 'e2e_client_key',
        publicKey: clientPublicKeyBase64
      }));

      console.log('[E2E] Sent client public key');
    } catch (e) {
      console.error('[E2E] Key exchange failed:', e);
    }
  }, [socket]);

  // Handle E2E ready confirmation from server
  const handleE2EReady = useCallback((serverFingerprint) => {
    if (serverFingerprint === fingerprint) {
      setE2eReady(true);
      console.log('[E2E] Encryption active! Fingerprint verified:', fingerprint);
    } else {
      console.error('[E2E] FINGERPRINT MISMATCH! Possible MITM attack.');
      console.error('  Server:', serverFingerprint);
      console.error('  Client:', fingerprint);
    }
  }, [fingerprint]);

  // Encrypt message for sending
  const encryptInput = useCallback(async (plaintext) => {
    if (!e2eReady || !sessionKeyRef.current) {
      return null;
    }

    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plaintext);

    const ciphertext = await window.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv },
      sessionKeyRef.current,
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
  }, [e2eReady]);

  // Decrypt message from server
  const decryptOutput = useCallback(async (encrypted) => {
    if (!e2eReady || !sessionKeyRef.current) {
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
        sessionKeyRef.current,
        combined
      );

      return new TextDecoder().decode(decrypted);
    } catch (e) {
      console.error('[E2E] Decryption failed:', e);
      return null;
    }
  }, [e2eReady]);

  return {
    e2eReady,
    fingerprint,
    encryptInput,
    decryptOutput,
    handleE2EInit,
    handleE2EReady
  };
}
