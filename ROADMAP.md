# Root Operator - Development Roadmap

Last updated: 2026-01-08

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

### Planned Security Improvements

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

#### Priority 3: Enterprise Features

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
