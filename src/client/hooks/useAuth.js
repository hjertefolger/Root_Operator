import { useState, useRef, useEffect, useCallback } from 'react';

// RSA-PSS algorithm parameters
const RSA_PSS_PARAMS = {
  name: "RSA-PSS",
  hash: "SHA-256"
};

// Pairing code characters (no ambiguous chars)
const PAIRING_CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

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

export function useAuth(socket) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [pairingCode, setPairingCode] = useState(null);
  const [pairingStatus, setPairingStatus] = useState('connecting'); // connecting, authenticating, waiting, paired
  const [pairingError, setPairingError] = useState(null);
  const [keysReady, setKeysReady] = useState(false);
  const [serverReady, setServerReady] = useState(false);
  const [isReturningDevice, setIsReturningDevice] = useState(false);
  const keyPairRef = useRef(null);
  const keyIdRef = useRef(null);
  const pairingInitiatedRef = useRef(false);

  // Setup or load RSA-PSS keys
  useEffect(() => {
    async function setupKeys() {
      const storedKeys = localStorage.getItem('pocket_bridge_keys');

      if (storedKeys) {
        try {
          const { privateJwk, publicJwk, kid } = JSON.parse(storedKeys);
          keyIdRef.current = kid;

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

          keyPairRef.current = { privateKey, publicKey };
          console.log('[AUTH] Loaded existing keypair - returning device');
          setIsReturningDevice(true);
          setKeysReady(true);
          setIsLoading(false);
          return;
        } catch (e) {
          console.error("[AUTH] Failed to load stored keys:", e);
        }
      }

      // Generate new RSA-PSS keys
      console.log('[AUTH] Generating new keypair');
      const keyPair = await window.crypto.subtle.generateKey(
        {
          name: "RSA-PSS",
          modulusLength: 2048,
          publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
          hash: "SHA-256",
        },
        true,
        ["sign", "verify"]
      );

      keyPairRef.current = keyPair;

      const publicJwk = await window.crypto.subtle.exportKey("jwk", keyPair.publicKey);
      const privateJwk = await window.crypto.subtle.exportKey("jwk", keyPair.privateKey);

      // Generate key ID from public key hash
      const pubKeyString = JSON.stringify(publicJwk);
      const hashBuffer = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(pubKeyString));
      const kid = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
      keyIdRef.current = kid;

      localStorage.setItem('pocket_bridge_keys', JSON.stringify({
        privateJwk,
        publicJwk,
        kid
      }));

      console.log('[AUTH] Generated and stored new keypair');
      setKeysReady(true);
      setIsLoading(false);
    }

    setupKeys();
  }, []);

  // Export public key as JWK
  const exportPublicKey = useCallback(async () => {
    if (!keyPairRef.current) {
      throw new Error('Keys not initialized');
    }
    return await window.crypto.subtle.exportKey("jwk", keyPairRef.current.publicKey);
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

      // Server ready - mark server as ready
      if (msg.type === 'connected') {
        console.log('[AUTH] Server connected');
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
