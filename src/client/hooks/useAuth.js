import { useState, useRef, useEffect, useCallback } from 'react';

// RSA-PSS algorithm parameters
const RSA_PSS_PARAMS = {
  name: "RSA-PSS",
  hash: "SHA-256"
};

const RSA_PSS_SIGN_PARAMS = {
  name: "RSA-PSS",
  saltLength: 32
};

export function useAuth(socket) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const keyPairRef = useRef(null);
  const keyIdRef = useRef(null);

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
          console.log('[AUTH] Loaded existing keypair');
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
      setIsLoading(false);
    }

    setupKeys();
  }, []);

  // Sign challenge
  const signChallenge = useCallback(async (challenge) => {
    if (!keyPairRef.current) {
      throw new Error('Keys not initialized');
    }

    const encoder = new TextEncoder();
    const data = encoder.encode(challenge);
    const signature = await window.crypto.subtle.sign(
      RSA_PSS_SIGN_PARAMS,
      keyPairRef.current.privateKey,
      data
    );
    return Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, '0')).join('');
  }, []);

  // Export public key as JWK
  const exportPublicKey = useCallback(async () => {
    if (!keyPairRef.current) {
      throw new Error('Keys not initialized');
    }
    return await window.crypto.subtle.exportKey("jwk", keyPairRef.current.publicKey);
  }, []);

  // Handle auth challenge from server
  const handleAuthChallenge = useCallback(async (challenge) => {
    if (!socket || !keyPairRef.current) {
      console.error('[AUTH] Cannot respond to challenge: socket or keys not ready');
      return;
    }

    try {
      const signature = await signChallenge(challenge);
      const publicJwk = await exportPublicKey();

      socket.send(JSON.stringify({
        type: 'auth_response',
        keyId: keyIdRef.current,
        signature: signature,
        jwk: publicJwk
      }));

      console.log('[AUTH] Sent auth response');
    } catch (e) {
      console.error('[AUTH] Failed to respond to challenge:', e);
    }
  }, [socket, signChallenge, exportPublicKey]);

  // Listen for auth success
  useEffect(() => {
    if (!socket) return;

    const handleMessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (e) {
        return;
      }

      if (msg.type === 'auth_success') {
        console.log('[AUTH] Authentication successful');
        setIsAuthenticated(true);
      }

      if (msg.type === 'registered') {
        console.log("[AUTH] Device registered successfully");
      }
    };

    socket.addEventListener('message', handleMessage);
    return () => socket.removeEventListener('message', handleMessage);
  }, [socket]);

  return {
    isAuthenticated,
    isLoading,
    handleAuthChallenge
  };
}
