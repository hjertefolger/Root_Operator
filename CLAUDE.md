# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Root Operator** is an Electron-based desktop app that provides secure remote terminal access via Cloudflare Tunnel. It creates a bridge between a macOS desktop terminal and iOS/web clients with end-to-end encryption.

## Build & Development Commands

```bash
# Install dependencies (triggers automatic native rebuild)
npm install

# Start app in development mode
npm start

# Rebuild native modules (node-pty, keytar) after node/electron version changes
npm run rebuild

# Build for macOS (unsigned, for local development)
npm run build:unsigned

# Build for macOS (requires Apple Developer credentials)
npm run build
```

## Architecture Overview

### Process Architecture

**Main Process** (`main.js`):
- Electron main process that manages the app window, tray, and system integration
- HTTP server (port 22000) that serves PWA client and handles WebSocket connections
- Cloudflare tunnel manager that creates public URLs via `cloudflared` package
- PTY (pseudoterminal) manager using `node-pty` for shell process spawning
- E2E encryption layer using ECDH key exchange + AES-256-GCM
- Secure credential storage via `keytar` (macOS Keychain)

**Renderer Process** (`ui/index.html`):
- UI for tunnel management (start/stop, settings, QR code display)
- No UI JavaScript - all logic in inline `<script>` tags within the HTML
- Communicates with main process via IPC (see `preload.js` for channel whitelist)

**Client/PWA** (`public/client.js`):
- Standalone web client that connects via WebSocket to the bridge server
- Implements xterm.js terminal emulator with fit and web-links addons
- E2E encryption with fingerprint verification (12-word BIP39 phrases)
- Authentication using public key signatures (Web Crypto API)
- Can be added to iOS home screen as PWA

### Security Architecture

**IPC Security** (`preload.js`):
- Context isolation enabled
- Channel whitelist pattern - only specific IPC channels are allowed
- Renderer cannot access Node.js APIs directly

**ANSI Sanitization** (`main.js:42-101`):
- Filters dangerous ANSI escape sequences (OSC, DCS, APC, PM, SOS)
- Blocks clipboard manipulation (OSC 52) and title spoofing (OSC 0/1/2)
- Allows safe color palette sequences

**E2E Encryption Flow** (`main.js:103-285`, `public/client.js`):
1. Client connects via WebSocket
2. Server initiates ECDH key exchange, sends public key + salt
3. Client generates keypair, derives shared secret, sends public key
4. Both sides derive AES-256-GCM session key via HKDF
5. Both sides compute 12-word BIP39 fingerprint from shared secret + salt
6. User verifies fingerprint match between desktop tray menu and iOS client
7. All terminal I/O encrypted with AES-256-GCM (random IV per message)

**Authentication**:
- Public key authentication using ECDSA (P-256 curve)
- Client generates keypair on first connection
- Server challenges client with random nonce
- Client signs challenge, server verifies signature
- Approved keys stored in electron-store
- Rate limiting: max 5 auth attempts per minute

**Origin Validation**:
- WebSocket connections validated against Cloudflare tunnel URL
- Blocks connections from unauthorized origins

### State Management

**Electron Store**:
- Keys: `cloudflare-token` (stored in keytar/Keychain, NOT electron-store)
- Keys: `allowed-origin` (custom domain for tunnel)
- Keys: `keys` (array of approved client public keys: `{kid, jwk}`)
- Keys: `debug-logging-enabled` (boolean, default: false)

**Global State** (`main.js:26-37`):
- `mainWindow`: BrowserWindow instance
- `tray`: Tray icon instance
- `server`: HTTP server instance
- `wss`: WebSocket server instance
- `ptyProcess`: Active PTY process
- `tunnelProcess`: Cloudflare tunnel child process
- `pendingConns`: Map of pending WebSocket connections awaiting auth
- `activeClients`: Set of authenticated WebSocket connections
- `currentTunnelUrl`: Current tunnel URL for state sync
- `currentFingerprint`: E2E session fingerprint (shown in tray)

### File Structure

```
main.js              Main process (Electron, server, tunnel, PTY, E2E)
preload.js           IPC bridge with channel whitelist
ui/index.html        Renderer UI (inline styles and scripts)
public/client.js     PWA client (terminal + E2E + auth)
public/bip39-words.json  BIP39 wordlist for fingerprints
build/entitlements.mac.plist  macOS entitlements for signing
scripts/notarize.js  Notarization script (currently disabled)
```

## Key Implementation Details

### Debug Logging

Debug logging is OFF by default and can be toggled via Settings in the UI. When enabled, logs are written to:
- macOS: `~/Library/Logs/RootOperator/debug.log` (or `~/Library/Logs/PocketBridge/debug.log` if using legacy name)

Logs auto-rotate at 10 MB (keeps last 3 files). Check `isDebugLoggingEnabled()` before logging with `logDebug()`.

### Cloudflare Tunnel

The app uses the `cloudflared` npm package which provides a managed wrapper. On start:
1. Spawns `cloudflared tunnel --url http://localhost:22000`
2. Package emits `url` event with tunnel URL
3. Tunnel URL sent to renderer via `TUNNEL_LIVE` IPC event
4. QR code generated for iOS scanning

Custom domains can be configured via `allowed-origin` store setting, which requires a Cloudflare token with tunnel permissions.

### Native Module Dependencies

- `node-pty`: PTY/shell spawning (requires native rebuild)
- `keytar`: Keychain access (requires native rebuild)

Both are listed in `asarUnpack` in package.json because they contain native code that cannot be inside asar archives.

### Path Traversal Protection

The PWA server (`servePWA()`) implements strict path validation:
- Normalizes all paths
- Validates against base directories (`/public`, `/node_modules`)
- Rejects null bytes and parent directory traversal
- See `main.js:1078-1088` for implementation

## Common Development Pitfalls

1. **After changing Node/Electron version**: Run `npm run rebuild` to recompile native modules
2. **E2E not working**: Check that both client and server show matching fingerprints
3. **Tunnel fails to start**: Check Cloudflare token is valid (if using custom domain)
4. **IPC channel blocked**: Add channel to whitelist in `preload.js`
5. **Logs not appearing**: Check if debug logging is enabled via Settings UI

## macOS Code Signing & Notarization

Currently DISABLED for easier local development. To enable:

1. Join Apple Developer Program ($99/year)
2. Update `package.json`:
   - `identity: null` → `identity: "Developer ID Application: Your Name (TEAM_ID)"`
   - `hardenedRuntime: false` → `hardenedRuntime: true`
3. Set environment variables:
   - `APPLE_ID`
   - `APPLE_APP_SPECIFIC_PASSWORD`
   - `APPLE_TEAM_ID`

See `scripts/notarize.js` for full setup instructions.
