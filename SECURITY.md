# Pocket Bridge Security Assessment

## Current Status: Personal/Small Team Use → Zero-Knowledge Architecture Planned

Last updated: 2026-01-01

**Roadmap:** Implementing E2E encryption with key verification to achieve cryptographically guaranteed privacy, even when using shared infrastructure.

---

## What's Solid

| Area | Implementation | Status |
|------|----------------|--------|
| Electron security | Context isolation, sandbox, preload | Done |
| Authentication | RSA-PSS challenge-response | Done |
| Rate limiting | Connection + attempt limits | Done |
| Path traversal | Protected | Done |
| Origin validation | WebSocket verifyClient | Done |
| Secrets storage | OS keychain (keytar) | Done |
| Security headers | CSP, X-Frame-Options | Done |
| ANSI escape filtering | Blocks OSC 52, title changes, DCS/APC/PM/SOS | Done |

---

## Planned: End-to-End Encryption with Key Verification

### Overview

Implement zero-knowledge E2E encryption so that even when traffic routes through the app's Cloudflare infrastructure, terminal content remains private.

**Trust Model:**
| Configuration | What Operator Sees | Trust Level |
|---------------|-------------------|-------------|
| User's own Cloudflare | Nothing | Full privacy |
| App's CF, no E2E | Everything | Must trust operator |
| App's CF + E2E | Encrypted blobs | Trust key exchange |
| **App's CF + E2E + key verification** | **Nothing** | **Cryptographically guaranteed** |

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                 App's Cloudflare Infrastructure              │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  Gateway / Tunnel                                      │  │
│  │  • Routes traffic to user's machine                   │  │
│  │  • Can see: metadata (who, when, bytes transferred)   │  │
│  │  • Cannot see: terminal content (encrypted)           │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
              ↑                                    ↑
        Encrypted                            Encrypted
         payload                              payload
              ↑                                    ↑
       ┌─────────────┐                     ┌─────────────┐
       │   Client    │◄─── E2E Session ───►│   Server    │
       │  (Browser)  │       Key           │   (Mac)     │
       └─────────────┘                     └─────────────┘
              │                                    │
              └──── Key Fingerprint Verification ──┘
                    (Out-of-band confirmation)
```

### Implementation Components

#### 1. Session Key Derivation

During RSA-PSS authentication, derive a shared AES-256-GCM session key:

```javascript
// Server generates ephemeral key material
const ephemeralSecret = crypto.randomBytes(32);

// Encrypt with client's RSA public key (from auth)
const encryptedSecret = crypto.publicEncrypt(
    { key: clientPublicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING },
    ephemeralSecret
);

// Both sides derive session key using HKDF
const sessionKey = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: sessionSalt, info: 'terminal-e2e' },
    ephemeralSecret,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
);
```

#### 2. Message Encryption (AES-256-GCM)

All `input` and `output` messages encrypted:

```javascript
async function encryptMessage(plaintext, sessionKey) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plaintext);

    const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        sessionKey,
        encoded
    );

    return {
        iv: base64Encode(iv),
        data: base64Encode(ciphertext),
        // GCM includes authentication tag automatically
    };
}

async function decryptMessage(encrypted, sessionKey) {
    const iv = base64Decode(encrypted.iv);
    const ciphertext = base64Decode(encrypted.data);

    const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        sessionKey,
        ciphertext
    );

    return new TextDecoder().decode(plaintext);
}
```

#### 3. Key Fingerprint Verification

Prevent MITM by allowing users to verify key fingerprints out-of-band:

```javascript
// Generate fingerprint from session key material
async function getKeyFingerprint(keyMaterial) {
    const hash = await crypto.subtle.digest('SHA-256', keyMaterial);
    const bytes = new Uint8Array(hash);

    // Format as verification words or emoji for easy comparison
    // Example: "alpha-bravo-charlie-delta" or "🔵🟢🔴🟡"
    return formatAsWords(bytes.slice(0, 8));
}
```

**Verification UI:**

```
┌─────────────────────────────────────────┐
│  🔐 Verify Secure Connection            │
│                                         │
│  Your device shows:                     │
│  ┌─────────────────────────────────┐   │
│  │  alpha-bravo-charlie-delta      │   │
│  └─────────────────────────────────┘   │
│                                         │
│  Confirm this matches your Mac app:    │
│                                         │
│  [Matches ✓]    [Doesn't Match ✗]      │
└─────────────────────────────────────────┘
```

**Mac app shows same fingerprint in tray menu for comparison.**

#### 4. Protocol Flow

```
Client                          Server (Mac)
   │                                │
   │──── WebSocket Connect ────────►│
   │                                │
   │◄─── auth_challenge ────────────│  (existing)
   │                                │
   │──── auth_response ────────────►│  (existing RSA-PSS)
   │                                │
   │◄─── auth_success + ────────────│  NEW: encrypted ephemeral
   │     encrypted_ephemeral        │       secret for key derivation
   │                                │
   │  [Both derive sessionKey]      │
   │                                │
   │◄─── key_fingerprint ──────────►│  NEW: both display for
   │                                │       out-of-band verification
   │                                │
   │──── encrypted input ──────────►│  AES-256-GCM
   │◄─── encrypted output ──────────│  AES-256-GCM
   │                                │
```

### Security Properties

| Property | Guarantee |
|----------|-----------|
| **Confidentiality** | Only endpoints can read content |
| **Integrity** | GCM tag detects tampering |
| **Forward secrecy** | New ephemeral key per session |
| **MITM protection** | Key fingerprint verification |
| **Replay protection** | Unique IV per message |

### What Operator Infrastructure Sees

| Data | Visible? |
|------|----------|
| Connection timestamp | Yes |
| Session duration | Yes |
| Bytes transferred | Yes |
| Client IP | Yes |
| Terminal content | **No** (encrypted) |
| Commands typed | **No** (encrypted) |
| Passwords/secrets | **No** (encrypted) |

### Complexity

**Medium-High**
- Client-side: ~150 lines (encryption, key derivation, UI)
- Server-side: ~100 lines (encryption, key derivation, tray display)
- Testing: Verify encryption works, key verification UX

---

## Remaining Gaps

### 1. No Transport Encryption Locally (Medium)

**Current state:** Uses `ws://` on localhost, relies on Cloudflare for HTTPS.

**Risk:** Local network MITM possible if attacker is on same machine/network.

**Fix:** Add TLS for local WebSocket using self-signed certificate.

```javascript
// Conceptual implementation
const https = require('https');
const fs = require('fs');

const server = https.createServer({
    key: fs.readFileSync('server-key.pem'),
    cert: fs.readFileSync('server-cert.pem')
});

const wss = new WebSocket.Server({ server });
```

**Complexity:** Medium - requires cert generation, storage, and client trust.

---

### 2. Tunnel URL = Access (Low-Medium)

**Current state:** Anyone with the Cloudflare tunnel URL can attempt connections.

**Risk:** Security through obscurity for URL discovery. Brute-force of URLs theoretically possible.

**Mitigations already in place:**
- RSA-PSS authentication required after connection
- Rate limiting on auth attempts
- Device approval required for new keys

**Potential improvements:**
- Add URL rotation capability
- Add IP allowlisting option
- Add tunnel access tokens (Cloudflare Access)

**Complexity:** Variable - Cloudflare Access integration is significant.

---

### 3. No Per-Message Authentication (Low) — *Superseded by E2E*

**Note:** This gap will be resolved by the E2E encryption implementation above. AES-256-GCM provides both confidentiality AND integrity (authentication tag), making separate HMAC signing unnecessary.

---

### 4. No Auto-Updates (Medium)

**Current state:** Security patches require manual app updates.

**Risk:** Users running vulnerable versions indefinitely.

**Fix options:**
- `electron-updater` with GitHub Releases
- Squirrel.Mac for macOS
- Custom update check + notification

```javascript
// Example with electron-updater
const { autoUpdater } = require('electron-updater');

autoUpdater.checkForUpdatesAndNotify();

autoUpdater.on('update-available', () => {
    // Notify user
});

autoUpdater.on('update-downloaded', () => {
    // Prompt to restart
});
```

**Complexity:** Medium - requires code signing, release infrastructure.

---

### 5. No Audit Logging (Low for personal use)

**Current state:** Debug logging exists but no persistent audit trail.

**Risk:** Cannot investigate past security incidents.

**Fix:** Add structured logging for security events.

```javascript
// Events to log:
// - Connection attempts (IP, timestamp, success/fail)
// - Authentication attempts (device ID, success/fail)
// - Device approvals/rejections
// - PTY spawns and exits
// - Tunnel start/stop

function auditLog(event, details) {
    const entry = {
        timestamp: new Date().toISOString(),
        event,
        ...details
    };
    fs.appendFileSync('audit.log', JSON.stringify(entry) + '\n');
}
```

**Complexity:** Low - straightforward implementation.

---

## Implementation Checklist

### Priority 1: E2E Encryption (Privacy Critical)
- [ ] Session key derivation during auth handshake
- [ ] AES-256-GCM encryption for `input` messages
- [ ] AES-256-GCM encryption for `output` messages
- [ ] Key fingerprint generation
- [ ] Fingerprint display in client UI
- [ ] Fingerprint display in Mac tray menu
- [ ] Verification confirmation flow

### Priority 2: Infrastructure
- [ ] Custom subdomain routing (e.g., `username.pocketbridge.dev`)
- [ ] Cloudflare API integration for DNS management
- [ ] User subdomain registration/customization

### Priority 3: Enterprise Features (Optional)
- [ ] Local TLS for WebSocket
- [ ] Audit logging with rotation
- [ ] Auto-update mechanism
- [ ] Cloudflare Access integration
- [ ] Third-party security audit
- [ ] SOC2 compliance documentation

---

## Threat Model

### In Scope
- Remote terminal access over internet
- Device authentication and authorization
- Protection against common terminal attacks
- **Privacy from infrastructure operator** (with E2E encryption)
- **MITM protection** (with key fingerprint verification)

### Out of Scope (accepted risks)
- Nation-state attackers with endpoint access
- Physical access to host machine
- Zero-day exploits in Electron/Node.js
- ~~Compromise of Cloudflare infrastructure~~ → **Mitigated by E2E encryption**

---

## Reporting Security Issues

If you discover a security vulnerability, please report it privately rather than opening a public issue.
