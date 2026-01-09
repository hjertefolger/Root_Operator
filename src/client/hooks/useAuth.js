import { useState, useRef, useEffect, useCallback } from 'react';

// RSA-PSS algorithm parameters
const RSA_PSS_PARAMS = {
  name: "RSA-PSS",
  hash: "SHA-256"
};

// Pairing code characters (no ambiguous chars)
const PAIRING_CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

// IndexedDB configuration
const DB_NAME = 'root_operator_keys';
const DB_VERSION = 1;
const STORE_NAME = 'keys';

// Generate 6-character pairing code
function generatePairingCode() {
  const array = new Uint8Array(6);
  crypto.getRandomValues(array);
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += PAIRING_CODE_CHARS[array[i] % PAIRING_CODE_CHARS.length];
  }
  return code;
}

// IndexedDB helper functions
function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
  });
}

async function getKeysFromIndexedDB() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get('device_keys');

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

async function saveKeysToIndexedDB(keyData) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.put({ id: 'device_keys', ...keyData });

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}

async function clearIndexedDB() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.clear();

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}

// Migrate from localStorage to IndexedDB (one-time migration)
async function migrateFromLocalStorage() {
  const storedKeys = localStorage.getItem('pocket_bridge_keys');
  if (!storedKeys) return null;

  try {
    const { publicJwk, kid } = JSON.parse(storedKeys);
    // Note: We cannot migrate the old private key because we're switching to non-extractable keys
    // The old key will need to be re-registered with the server
    console.log('[AUTH] Found legacy localStorage keys - will need to re-pair');

    // Clear the old localStorage entry
    localStorage.removeItem('pocket_bridge_keys');

    // Return the old kid so we can log it
    return { oldKid: kid, hadLegacyKeys: true };
  } catch (e) {
    console.error('[AUTH] Failed to parse legacy keys:', e);
    localStorage.removeItem('pocket_bridge_keys');
    return null;
  }
}

export function useAuth(socket) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [pairingCode, setPairingCode] = useState(null);
  const [pairingStatus, setPairingStatus] = useState('connecting'); // connecting, authenticating, waiting, paired
  const [pairingError, setPairingError] = useState(null);
  const [keysReady, setKeysReady] = useState(false);
  const [serverReady, setServerReady] = useState(false);
  const [isReturningDevice, setIsReturningDevice] = useState(false);
  const keyPairRef = useRef(null); // Holds CryptoKey objects (non-extractable private key)
  const keyIdRef = useRef(null);
  const publicJwkRef = useRef(null); // Cached public JWK for sending to server
  const pairingInitiatedRef = useRef(false);

  // Setup or load RSA-PSS keys from IndexedDB
  useEffect(() => {
    async function setupKeys() {
      // First, check for and migrate any legacy localStorage keys
      const migrationResult = await migrateFromLocalStorage();
      if (migrationResult?.hadLegacyKeys) {
        console.log('[AUTH] Legacy keys detected, generating new secure keys');
      }

      // Try to load keys from IndexedDB
      try {
        const storedData = await getKeysFromIndexedDB();

        if (storedData && storedData.privateKey && storedData.publicKey && storedData.kid) {
          // SECURITY: Keys stored in IndexedDB are CryptoKey objects
          // The private key is non-extractable, so it cannot be stolen via XSS
          keyPairRef.current = {
            privateKey: storedData.privateKey,
            publicKey: storedData.publicKey
          };
          keyIdRef.current = storedData.kid;
          publicJwkRef.current = storedData.publicJwk;

          console.log('[AUTH] Loaded existing keypair from IndexedDB - returning device');
          setIsReturningDevice(true);
          setKeysReady(true);
          setIsLoading(false);
          return;
        }
      } catch (e) {
        console.error('[AUTH] Failed to load keys from IndexedDB:', e);
        // Continue to generate new keys
      }

      // Generate new RSA-PSS keys with non-extractable private key
      // SECURITY: extractable: false prevents the private key from being exported
      // This means even if an attacker exploits XSS, they cannot steal the private key
      console.log('[AUTH] Generating new non-extractable keypair');
      const keyPair = await window.crypto.subtle.generateKey(
        {
          name: "RSA-PSS",
          modulusLength: 2048,
          publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
          hash: "SHA-256",
        },
        false, // SECURITY: Non-extractable - private key cannot be exported
        ["sign", "verify"]
      );

      keyPairRef.current = keyPair;

      // Export public key only (public keys are always extractable for verification)
      const publicJwk = await window.crypto.subtle.exportKey("jwk", keyPair.publicKey);
      publicJwkRef.current = publicJwk;

      // Generate key ID from public key hash
      const pubKeyString = JSON.stringify(publicJwk);
      const hashBuffer = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(pubKeyString));
      const kid = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
      keyIdRef.current = kid;

      // Store in IndexedDB (CryptoKey objects are stored natively, not serialized)
      // SECURITY: IndexedDB can store CryptoKey objects directly
      // The non-extractable private key remains protected by the browser
      try {
        await saveKeysToIndexedDB({
          privateKey: keyPair.privateKey,
          publicKey: keyPair.publicKey,
          publicJwk: publicJwk,
          kid: kid
        });
        console.log('[AUTH] Generated and stored new secure keypair in IndexedDB');
      } catch (e) {
        console.error('[AUTH] Failed to store keys in IndexedDB:', e);
        // Continue anyway - keys will work for this session
      }

      setKeysReady(true);
      setIsLoading(false);
    }

    setupKeys();
  }, []);

  // Export public key as JWK (cached)
  const exportPublicKey = useCallback(async () => {
    if (!publicJwkRef.current) {
      throw new Error('Public key not initialized');
    }
    return publicJwkRef.current;
  }, []);

  // Sign a challenge with the private key
  const signChallenge = useCallback(async (challenge) => {
    if (!keyPairRef.current?.privateKey) {
      throw new Error('Private key not available');
    }
    const encoder = new TextEncoder();
    const data = encoder.encode(challenge);
    const signature = await window.crypto.subtle.sign(
      { name: "RSA-PSS", saltLength: 32 },
      keyPairRef.current.privateKey,
      data
    );
    // Convert to hex (server expects hex format)
    return Array.from(new Uint8Array(signature))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }, []);

  // Send pairing request
  const sendPairingRequest = useCallback(async () => {
    if (!socket || !keyPairRef.current || pairingInitiatedRef.current) {
      return;
    }

    pairingInitiatedRef.current = true;

    try {
      const code = generatePairingCode();
      setPairingCode(code);

      // For returning devices, show "authenticating" instead of pairing code
      // Server will respond with auth_success if device is registered
      if (isReturningDevice) {
        setPairingStatus('authenticating');
      }

      const publicJwk = await exportPublicKey();

      socket.send(JSON.stringify({
        type: 'pairing_request',
        code: code,
        keyId: keyIdRef.current,
        jwk: publicJwk
      }));

      console.log('[AUTH] Sent pairing request with code:', code);
    } catch (e) {
      console.error('[AUTH] Failed to send pairing request:', e);
      setPairingError('Failed to initiate pairing');
      pairingInitiatedRef.current = false;
    }
  }, [socket, exportPublicKey, isReturningDevice]);

  // Initiate pairing when both server and keys are ready
  useEffect(() => {
    if (serverReady && keysReady && socket && socket.readyState === WebSocket.OPEN) {
      console.log('[AUTH] Both server and keys ready, initiating pairing');
      sendPairingRequest();
    }
  }, [serverReady, keysReady, socket, sendPairingRequest]);

  // Listen for WebSocket messages
  useEffect(() => {
    if (!socket) return;

    const handleMessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (e) {
        return;
      }

      // Server ready - reset for fresh auth on this connection
      if (msg.type === 'connected') {
        console.log('[AUTH] Server connected');
        // Reset pairing state for this connection (fixes reconnection re-pairing bug)
        pairingInitiatedRef.current = false;
        setPairingError(null);
        setServerReady(true);
      }

      // Pairing request accepted - show code
      if (msg.type === 'pairing_pending') {
        console.log('[AUTH] Pairing pending, showing code');
        setPairingStatus('waiting');
      }

      // Pairing successful
      if (msg.type === 'pairing_success') {
        console.log('[AUTH] Pairing successful');
        setPairingStatus('paired');
        setIsAuthenticated(true);
      }

      // Challenge for returning device - sign and respond
      if (msg.type === 'auth_challenge' && msg.challenge) {
        console.log('[AUTH] Received challenge, signing...');
        (async () => {
          try {
            const signature = await signChallenge(msg.challenge);
            socket.send(JSON.stringify({
              type: 'auth_response',
              keyId: keyIdRef.current,
              signature
            }));
            console.log('[AUTH] Sent signed challenge response');
          } catch (e) {
            console.error('[AUTH] Failed to sign challenge:', e);
            setPairingError('Authentication failed');
          }
        })();
      }

      // Auth success (after challenge-response or new pairing)
      if (msg.type === 'auth_success') {
        console.log('[AUTH] Authentication successful');
        setPairingStatus('paired');
        setIsAuthenticated(true);
      }

      // Pairing expired
      if (msg.type === 'pairing_expired') {
        console.log('[AUTH] Pairing code expired');
        setPairingError('Pairing code expired. Please refresh to try again.');
      }

      // Pairing error
      if (msg.type === 'pairing_error') {
        console.log('[AUTH] Pairing error:', msg.message);
        setPairingError(msg.message || 'Pairing failed');
      }

      // Auth error (challenge-response failed)
      if (msg.type === 'auth_error') {
        console.log('[AUTH] Auth error:', msg.message);
        setPairingError(msg.message || 'Authentication failed');
        setPairingStatus('waiting'); // Fall back to showing pairing code
      }
    };

    socket.addEventListener('message', handleMessage);
    return () => socket.removeEventListener('message', handleMessage);
  }, [socket, signChallenge]);

  return {
    isAuthenticated,
    isLoading,
    pairingCode,
    pairingStatus,
    pairingError,
    isReturningDevice
  };
}
