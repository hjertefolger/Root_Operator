# Root Operator - Development Roadmap

Last updated: 2026-01-04

---

## Tech Stack Roadmap

### Phase 1: Modern Frontend Migration (Planned)

**Goal:** Migrate from vanilla JS to React + Vite + Tailwind to support multiple terminal tabs and better scalability.

**Timeline:** ~10-15 hours

#### Why Migrate?

- **Multiple tabs support** (planned feature)
- Better state management as features grow
- Component reusability
- Modern development experience
- Tailwind for rapid UI iteration

#### Tech Stack

```bash
Build System:
- Vite (fast builds, HMR, Electron-compatible)

Frontend:
- React (component model for tabs/sessions)
- Tailwind CSS (rapid UI development)
- Zustand or Jotai (lightweight state management)

Terminal:
- xterm.js (keep existing)
- xterm-addon-fit
- xterm-addon-web-links
```

#### Implementation Steps

**Step 1: Setup Build System** (2-3 hours)
- [ ] Install Vite, React, Tailwind
- [ ] Configure Vite for Electron (`base: './'` for file:// protocol)
- [ ] Setup Tailwind config
- [ ] Update package.json scripts:
  ```json
  {
    "dev": "vite",
    "build:client": "vite build",
    "prebuild": "npm run build:client",
    "start": "electron ."
  }
  ```

**Step 2: Project Restructure** (1-2 hours)
- [ ] Create `src/client/` directory structure
- [ ] Move current client.js logic to src
- [ ] Setup component structure:
  ```
  src/client/
  ├── App.jsx
  ├── components/
  │   ├── Terminal.jsx
  │   ├── TabBar.jsx
  │   ├── ConnectionStatus.jsx
  │   └── EncryptionBadge.jsx
  ├── hooks/
  │   ├── useWebSocket.js
  │   ├── useE2E.js
  │   └── useTerminal.js
  ├── store/
  │   └── sessionStore.js
  └── main.jsx
  ```

**Step 3: Migrate Existing Features** (4-6 hours)
- [ ] Convert WebSocket connection logic to `useWebSocket` hook
- [ ] Convert E2E encryption to `useE2E` hook
- [ ] Convert terminal to `Terminal` component
- [ ] Migrate authentication flow
- [ ] Migrate connection status UI
- [ ] Migrate encryption badge

**Step 4: Add Tab Functionality** (3-4 hours)

**Client Side:**
- [ ] Create Zustand store for session management:
  ```jsx
  const useSessionStore = create((set) => ({
    sessions: [],
    activeId: null,
    addSession: () => set((state) => ({ ... })),
    closeSession: (id) => set((state) => ({ ... })),
    setActive: (id) => set({ activeId: id })
  }));
  ```
- [ ] Build `TabBar` component (tabs, close buttons, new tab)
- [ ] Implement tab switching logic
- [ ] Add keyboard shortcuts (Cmd+T, Cmd+W, Cmd+1-9)

**Server Side (main.js):**
- [ ] Modify WebSocket handler to support multiple sessions
- [ ] Create session map: `sessionId -> { ptyProcess, e2e }`
- [ ] Route messages by sessionId
- [ ] Handle session creation/cleanup
- [ ] Update protocol to include sessionId in messages

**Step 5: Polish & Testing** (2-3 hours)
- [ ] Test E2E encryption with multiple tabs
- [ ] Test tab switching, creation, deletion
- [ ] Test PTY cleanup on tab close
- [ ] Update UI styling with Tailwind
- [ ] Test Electron build with Vite output
- [ ] Verify PWA still works on iOS

#### Updated File Serving

**main.js changes:**
```javascript
function servePWA(req, res) {
  // Serve from Vite build output
  const publicDir = path.join(__dirname, 'public', 'dist');
  // ... rest of logic
}
```

**electron-builder config:**
```json
{
  "files": [
    "main.js",
    "preload.js",
    "ui/**/*",
    "public/dist/**/*",        // Vite output
    "public/bip39-words.json",
    "!public/src"              // Exclude source
  ]
}
```

#### Success Criteria

- [ ] Multiple terminal tabs working
- [ ] Each tab has independent PTY process
- [ ] E2E encryption works per session
- [ ] Clean tab UI with Tailwind
- [ ] Electron build produces working .app
- [ ] Bundle size < 500KB gzipped
- [ ] PWA loads in < 2 seconds on mobile

---

## Security Roadmap

### Completed ✅

| Area | Implementation | Date |
|------|----------------|------|
| Electron security | Context isolation, sandbox, preload | 2026-01 |
| Authentication | RSA-PSS challenge-response | 2026-01 |
| Rate limiting | Connection + attempt limits | 2026-01 |
| Path traversal | Protected | 2026-01 |
| Origin validation | WebSocket verifyClient | 2026-01 |
| Secrets storage | OS keychain (keytar) | 2026-01 |
| Security headers | CSP, X-Frame-Options | 2026-01 |
| ANSI escape filtering | Blocks OSC 52, title changes, DCS/APC/PM/SOS | 2026-01 |
| **E2E Encryption** | ECDH + AES-256-GCM + fingerprint verification | **2026-01** |

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

### Near Term

**Multiple Terminal Tabs** (Next major feature)
- Tech stack migration to React (see above)
- Tab management UI
- Multiple PTY processes
- Session-based E2E encryption
- Tab persistence (optional)

**UI/UX Improvements**
- Modern UI with Tailwind
- Responsive design
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
- ✅ E2E encryption
- ✅ Public key authentication
- ✅ Cloudflare tunnel
- ✅ macOS app

### v1.1 (Next)
- React + Vite + Tailwind migration
- Multiple terminal tabs
- Improved UI/UX
- Tab persistence

### v1.2
- Session management
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
