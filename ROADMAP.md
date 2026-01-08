# Root Operator - Development Roadmap

Last updated: 2026-01-08 (Security Audit Added)

---

## Tech Stack Roadmap

### Phase 1: Modern Frontend Migration ✅ COMPLETED

**Goal:** Migrate from vanilla JS to React + Vite + Tailwind to support multiple terminal tabs and better scalability.

#### Tech Stack (Implemented)

```bash
Build System:
- Vite (fast builds, HMR, Electron-compatible)
- Dual Vite configs: renderer (port 5174) + client (port 5175)

Frontend:
- React 18
- Tailwind CSS
- shadcn/ui components
- Lucide React icons

Terminal:
- xterm.js
- xterm-addon-fit
- xterm-addon-web-links
```

#### Completed Steps

- [x] Setup Vite build system with HMR
- [x] Create `src/client/` and `src/renderer/` directory structure
- [x] Convert WebSocket connection logic to `useWebSocket` hook
- [x] Convert E2E encryption to `useE2E` hook
- [x] Convert terminal to `Terminal` component
- [x] Migrate authentication flow to `useAuth` hook
- [x] Add `useTerminal` hook for terminal management
- [x] Add `useTerminalPersistence` hook for session storage
- [x] Build Header component with encryption badge
- [x] Build VirtualKeyboard component for iOS
- [x] Build PairingScreen component
- [x] Electron build produces working .app
- [x] PWA works on iOS

### Phase 2: Multiple Terminal Tabs (Planned)

- [ ] Create session store for tab management
- [ ] Build TabBar component
- [ ] Modify WebSocket handler to support multiple sessions
- [ ] Session-based E2E encryption
- [ ] Tab persistence (optional)

---

## Security Roadmap

### Completed ✅

| Area | Implementation | Date |
|------|----------------|------|
| Electron security | Context isolation, sandbox, preload | 2026-01 |
| Authentication | RSA-PSS 2048-bit with 6-char pairing codes | 2026-01 |
| **Challenge-Response** | **Enforced for ALL reconnections (proves key possession)** | **2026-01-08** |
| Rate limiting | Connection + attempt limits, 30s challenge expiry | 2026-01 |
| Path traversal | Protected | 2026-01 |
| Origin validation | WebSocket verifyClient | 2026-01 |
| Secrets storage | OS keychain (keytar) | 2026-01 |
| Security headers | CSP, X-Frame-Options | 2026-01 |
| ANSI escape filtering | Blocks OSC 52, title changes, DCS/APC/PM/SOS | 2026-01 |
| **E2E Encryption** | ECDH P-256 + AES-256-GCM + BIP39 fingerprint | **2026-01** |
| **Connection Resilience** | Auto-reconnect with backoff, heartbeat ping/pong | **2026-01-08** |

### E2E Encryption Architecture

**Zero-knowledge design:** Even when traffic routes through Cloudflare infrastructure, terminal content remains cryptographically private.

**Trust Model:**
| Configuration | What Operator Sees | Trust Level |
|---------------|-------------------|-------------|
| User's own Cloudflare | Nothing | Full privacy |
| App's CF, no E2E | Everything | Must trust operator |
| App's CF + E2E | Encrypted blobs | Trust key exchange |
| **App's CF + E2E + verification** | **Nothing** | **Cryptographically guaranteed** |

**Implementation:**
- ECDH key exchange (P-256 curve)
- HKDF key derivation
- AES-256-GCM encryption
- 12-word BIP39 fingerprint verification
- Forward secrecy (ephemeral keys per session)
- Authenticated encryption (GCM tag)

**Security Properties:**
- ✅ Confidentiality (only endpoints read content)
- ✅ Integrity (tampering detected via GCM)
- ✅ Forward secrecy (new keys per session)
- ✅ MITM protection (fingerprint verification)
- ✅ Replay protection (unique IV per message)

### Security Audit Findings (2026-01-08)

**Audit performed:** Comprehensive code review of main.js, preload.js, and client hooks.
**Overall Rating:** 7.5/10 - Strong foundations, needs critical fixes before production.

---

#### CRITICAL Issues (Must Fix Before Production)

##### 1. Null Origin Attack Vector

**Location:** `main.js:854-856`
```javascript
function isOriginAllowed(origin, cfSettings) {
    if (!origin) return true; // ← CRITICAL FLAW
```

**Impact:** Attackers can bypass origin validation by:
- Using non-browser tools (curl, websocket clients)
- Proxies that strip Origin headers
- `file://` URLs

**Risk Level:** Critical - Allows unauthorized WebSocket connections

**Fix:**
```javascript
function isOriginAllowed(origin, cfSettings) {
    // Only allow null origin in development mode
    if (!origin) {
        return isDev; // Reject in production
    }
    // ... rest of validation
}
```

**Status:** [ ] Not fixed

---

##### 2. Hardened Runtime Disabled

**Location:** `package.json:97-98`
```json
"hardenedRuntime": false,
"gatekeeperAssess": false,
```

**Impact:** Without hardened runtime:
- Code injection attacks are easier
- Library validation is bypassed
- macOS security protections are disabled

**Risk Level:** Critical for macOS distribution

**Fix:** For production builds:
```json
"hardenedRuntime": true,
"gatekeeperAssess": true,
"identity": "Developer ID Application: Your Name (TEAM_ID)"
```

**Status:** [ ] Intentionally disabled for development (requires Apple Developer account)

---

##### 3. Content Security Policy Gaps

**Location:** `main.js:1502`
```javascript
"Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' wss: ws:;"
```

**Missing directives:**
- `frame-ancestors 'none'` - clickjacking protection
- `object-src 'none'` - plugin blocking
- `base-uri 'self'` - base tag injection protection
- `form-action 'self'` - form redirect protection
- `upgrade-insecure-requests` - force HTTPS

**Risk Level:** High - XSS amplification, clickjacking

**Fix:**
```javascript
"Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' wss: ws:; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self';"
```

**Status:** [ ] Not fixed

---

#### HIGH Priority Issues

##### 4. Client Private Keys in localStorage

**Location:** `src/client/hooks/useAuth.js:97-101`
```javascript
localStorage.setItem('pocket_bridge_keys', JSON.stringify({
    privateJwk,
    publicJwk,
    kid
}));
```

**Impact:**
- Any XSS attack can steal the private key
- localStorage is accessible to all scripts on the same origin
- Private key should never be extractable

**Risk Level:** High - Complete device impersonation on XSS

**Fix Options:**
1. Generate keys with `extractable: false` (prevents export)
2. Use IndexedDB with CryptoKey objects (non-serializable)
3. Use sessionStorage (clears on tab close, reduces exposure window)

**Recommended Implementation:**
```javascript
// Generate non-extractable keys
const keyPair = await window.crypto.subtle.generateKey(
    { name: "RSA-PSS", modulusLength: 2048, publicExponent: new Uint8Array([0x01, 0x00, 0x01]), hash: "SHA-256" },
    false, // extractable = false
    ["sign", "verify"]
);
// Store public JWK only; private key stays in CryptoKey object
// Use IndexedDB to persist the CryptoKey reference
```

**Status:** [ ] Not fixed

---

##### 5. No Key Rotation Mechanism

**Impact:**
- Compromised keys remain valid indefinitely
- No remote revocation capability
- No key expiration policy

**Recommended Features:**
- [ ] Device key expiration (e.g., 90 days)
- [ ] Remote key revocation via IPC
- [ ] Key rotation on security events
- [ ] "Sign out all devices" functionality

**Status:** [ ] Planned

---

##### 6. Session Key Never Rotates

**Location:** E2E session key persists for entire connection lifetime

**Impact:**
- Long sessions increase exposure if key is compromised
- No forward secrecy within a session

**Best Practice:** Rotate session keys:
- Every N messages (e.g., 10,000)
- Every N minutes (e.g., 30)
- Every N bytes transferred (e.g., 100MB)

**Status:** [ ] Planned

---

##### 7. WebSocket Message Size Limit

**Location:** `main.js:1111-1115`
```javascript
if (msg.length > 65536) { // 64KB
    logDebug('[SECURITY] Message too large, ignoring');
    return;
}
```

**Issue:** 64KB JSON parsing is expensive. Check occurs after receiving full message.

**Fix Options:**
- Lower limit to 16KB or 32KB
- Use streaming parser for large messages
- Add ws `maxPayload` option at server level

**Status:** [ ] Not fixed

---

#### MEDIUM Priority Issues

##### 8. Debug Logging May Leak Sensitive Data

**Locations:**
- `main.js:274` - logs fingerprints
- `main.js:298` - logs key exchange details
- Various connection details logged

**Fix:** Sanitize or redact sensitive fields before logging:
```javascript
function logDebug(msg, sensitiveFields = []) {
    let sanitized = msg;
    for (const field of sensitiveFields) {
        sanitized = sanitized.replace(new RegExp(field, 'g'), '[REDACTED]');
    }
    // ... write to log
}
```

**Status:** [ ] Not fixed

---

##### 9. Missing HSTS Header

**Location:** `main.js:1497-1503`

**Fix:** Add to security headers:
```javascript
'Strict-Transport-Security': 'max-age=31536000; includeSubDomains'
```

**Note:** Traffic goes through Cloudflare (which adds HSTS), but defense in depth recommends adding it locally too.

**Status:** [ ] Not fixed

---

##### 10. Timing Side-Channel in Auth Verification

**Location:** `main.js:1316-1342`
```javascript
function verifySignature(kid, signature, challenge) {
    const key = authorized.find(k => k.kid === kid);
    if (!key) return false; // ← Early return leaks timing info
```

**Impact:** Attackers can enumerate valid key IDs by measuring response time

**Fix:** Use constant-time comparison or add artificial delay:
```javascript
function verifySignature(kid, signature, challenge) {
    const authorized = store.get('keys', []);
    const key = authorized.find(k => k.kid === kid);

    // Always perform full verification flow
    const dummyKey = { jwk: generateDummyJWK() };
    const keyToVerify = key || dummyKey;

    try {
        // ... verification logic
        return key ? isValid : false;
    } catch {
        return false;
    }
}
```

**Status:** [ ] Not fixed

---

##### 11. Worker API Timestamp Validation

**Location:** `main.js:434-436`
```javascript
const timestamp = Date.now();
const message = `${machineId}:${challenge}:${timestamp}`;
```

**Issue:** Client controls timestamp. Server must validate timestamp freshness (e.g., within 5 minutes).

**Status:** [ ] Depends on Worker API implementation

---

#### LOW Priority Issues

##### 12. Encrypted Payload Size Check Order

**Location:** `main.js:1268-1279`
```javascript
const decrypted = decryptInput(ws, { iv: m.iv, data: m.data, tag: m.tag });
// ... later ...
if (inputData.length > MAX_INPUT_SIZE) {
```

**Issue:** Large encrypted payloads are fully decrypted before size validation.

**Fix:** Check base64 encoded size before decryption:
```javascript
const estimatedSize = (m.data.length * 3) / 4; // base64 -> bytes
if (estimatedSize > MAX_INPUT_SIZE * 1.5) {
    logDebug('[SECURITY] Encrypted payload too large');
    return;
}
```

**Status:** [ ] Not fixed

---

##### 13. Pairing Code Brute Force Window

**Current:** 6 chars from 31-char alphabet = ~887M combinations, 2-minute expiry

**Analysis:** With rate limiting (20 conn/min, 3 attempts/conn), max 60 attempts in 2 minutes. Probability of success: 60/887M ≈ 0.000007%

**Verdict:** Acceptable risk. No change needed.

**Status:** [x] Acceptable

---

### Missing Security Features Checklist

| Feature | Priority | Status | Notes |
|---------|----------|--------|-------|
| Fix null origin validation | Critical | [ ] | Required for production |
| Enable hardened runtime | Critical | [ ] | Requires Apple Developer |
| Strengthen CSP | High | [ ] | Add missing directives |
| Non-extractable client keys | High | [ ] | Use IndexedDB + CryptoKey |
| Key rotation mechanism | High | [ ] | Device + session keys |
| Device naming/identification | Medium | [ ] | UX improvement for revocation |
| Connection audit logging | Medium | [ ] | IP, timestamp, device forensics |
| New device notifications | Medium | [ ] | Alert on pairing |
| Certificate pinning | Low | [ ] | Pin Worker API certs |
| HSTS header | Low | [ ] | Defense in depth |
| Constant-time auth | Low | [ ] | Prevent enumeration |

---

### Planned Security Improvements

#### Priority 1: Critical Fixes (Before Production)

- [ ] **Fix origin validation** - Reject null origins in production
- [ ] **Strengthen CSP** - Add frame-ancestors, object-src, base-uri, form-action
- [ ] **Non-extractable keys** - Migrate to IndexedDB + CryptoKey

#### Priority 2: Infrastructure Hardening

**Local TLS for WebSocket** (Medium priority)
- **Current:** Uses `ws://` on localhost
- **Risk:** Local network MITM possible
- **Fix:** Add TLS with self-signed cert
- **Complexity:** Medium
- **Status:** Planned

**Tunnel Access Control** (Low-Medium priority)
- **Current:** URL = access (with auth required)
- **Risk:** URL discovery gives connection attempt
- **Improvements:**
  - URL rotation capability
  - IP allowlisting
  - Cloudflare Access integration
- **Status:** Planned

**Key Management** (High priority)
- [ ] Key expiration policy (90 days)
- [ ] Remote revocation capability
- [ ] Session key rotation
- [ ] "Sign out all devices" feature

#### Priority 3: Enterprise Features

**Code Signing & Hardened Runtime** (Required for distribution)
- **Current:** Disabled for easier local development
- **Risk:** Users cannot run app without security warnings
- **Fix:** Enable hardened runtime, code signing, notarization
- **Requires:** Apple Developer account ($99/year)
- **Status:** Planned for v1.2

**Auto-Updates** (Medium priority)
- **Current:** Manual updates required
- **Risk:** Users on vulnerable versions
- **Fix:** `electron-updater` with GitHub Releases
- **Requires:** Code signing, release infrastructure
- **Status:** Planned

**Audit Logging** (Low priority for personal use)
- **Current:** Debug logs only
- **Fix:** Structured security event logging
- **Events to log:**
  - Connection attempts (IP, timestamp, result)
  - Authentication attempts (device ID, result)
  - Device approvals/rejections
  - PTY spawns and exits
  - Tunnel lifecycle
- **Status:** Planned

**Custom Subdomains**
- [ ] Custom subdomain routing (e.g., `username.rootoperator.dev`)
- [ ] Cloudflare API integration for DNS
- [ ] User subdomain registration

**Compliance & Audits**
- [ ] Third-party security audit
- [ ] SOC2 compliance documentation
- [ ] Penetration testing

### Threat Model

**In Scope:**
- Remote terminal access over internet
- Device authentication and authorization
- Protection against common terminal attacks
- Privacy from infrastructure operator (E2E encryption)
- MITM protection (key fingerprint verification)

**Out of Scope (accepted risks):**
- Nation-state attackers with endpoint access
- Physical access to host machine
- Zero-day exploits in Electron/Node.js
- ~~Compromise of Cloudflare infrastructure~~ ✅ Mitigated by E2E

---

## Feature Roadmap

### Completed ✅

**Modern React Stack** (2026-01)
- [x] React + Vite + Tailwind migration
- [x] shadcn/ui component library
- [x] Hot module replacement (HMR) for development
- [x] Dual build system (renderer + client)

**PWA Client Improvements** (2026-01-08)
- [x] WebSocket auto-reconnection with exponential backoff
- [x] Heartbeat ping/pong (25s interval, 5s timeout)
- [x] Network online/offline detection
- [x] iOS PWA visibility change handling
- [x] Terminal content persistence (sessionStorage)
- [x] Server output buffer (1MB) for history preservation
- [x] Custom virtual keyboard for iOS
- [x] Reconnecting/Authenticating overlay states

**Authentication UX** (2026-01-08)
- [x] Quick "Authenticating..." state for returning devices
- [x] Proper challenge-response for security
- [x] Graceful fallback to pairing code on auth failure

### Near Term

**Multiple Terminal Tabs** (Next major feature)
- Tab management UI
- Multiple PTY processes
- Session-based E2E encryption
- Tab persistence (optional)

**UI/UX Improvements**
- Dark/light theme toggle
- Keyboard shortcuts
- Terminal customization (fonts, colors)

### Medium Term

**Session Management**
- Named sessions
- Session history/reconnect
- Session sharing (view-only mode)
- Session recording/playback

**File Transfer**
- Drag & drop file upload
- Download file from terminal
- Progress indicators
- Transfer encryption

### Long Term

**Collaboration Features**
- Multi-user sessions
- Real-time cursor sharing
- Chat/annotations
- Permission levels (read/write)

**Advanced Features**
- Split panes (horizontal/vertical)
- Command snippets/macros
- Session templates
- Custom shell profiles

---

## Release Planning

### v1.0 (Current)
- ✅ Single terminal session
- ✅ E2E encryption (ECDH + AES-256-GCM)
- ✅ RSA-PSS authentication with challenge-response
- ✅ Cloudflare tunnel integration
- ✅ macOS Electron app
- ✅ iOS PWA client

### v1.1 (Current) ✅
- ✅ React + Vite + Tailwind migration
- ✅ WebSocket auto-reconnection
- ✅ Terminal persistence
- ✅ Virtual keyboard for iOS
- ✅ Improved authentication UX

### v1.2 (Next)
- Multiple terminal tabs
- Tab persistence
- Session management

### v1.3
- File transfer
- Auto-updates

### v2.0
- Collaboration features
- Split panes
- Custom domains
- Advanced customization

---

## Reporting Security Issues

If you discover a security vulnerability, please report it privately rather than opening a public issue.

Contact: [Add contact method]
