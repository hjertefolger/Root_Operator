# Root_Operator

A secure remote terminal access app for macOS that lets you control your Mac's terminal from your iPhone or any web browser. Built with Electron and powered by Cloudflare Tunnel for secure, zero-config remote access.

## Features

- **Secure Remote Access** - Access your Mac's terminal from anywhere via Cloudflare Tunnel
- **End-to-End Encryption** - All terminal I/O is encrypted with AES-256-GCM using ECDH key exchange
- **Visual Fingerprint Verification** - 12-word BIP39 mnemonic fingerprint to verify secure connection
- **Device Pairing** - Simple 6-character pairing code for new device authorization
- **PWA Support** - Install on iOS home screen for native app-like experience
- **Persistent Sessions** - Terminal state persists across reconnections
- **Custom Operator URL** - Set your own URL at `yourname.rootoperator.dev` for easy sharing

## Screenshots

<!-- Add screenshots here -->

## Requirements

- macOS 11+ (Big Sur or later)
- Node.js 18+ (for building from source)

## Installation

### From Release

Download the latest `.dmg` from the [Releases](https://github.com/hjertefolger/Root_Operator/releases) page.

> **Important**
> The app is unsigned. macOS will block it on first launch. To allow it to run, either:
> - Go to **System Settings → Privacy & Security** and click "Open Anyway", or
> - Run this command to sign it locally:
>   ```bash
>   xattr -cr /Applications/Root_Operator.app && codesign --force --deep --sign - /Applications/Root_Operator.app
>   ```

### From Source

```bash
# Clone the repository
git clone https://github.com/hjertefolger/Root_Operator.git
cd Root_Operator

# Install dependencies (automatically rebuilds native modules)
npm install

# Start in development mode
npm run dev:app

# Or build for production
npm run build:unsigned
```

## Configuration

Copy `.env.example` to `.env` and configure your domain:

```bash
cp .env.example .env
# Edit .env with your domain settings
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `WORKER_BASE_URL` | Yes | Cloudflare Worker API URL (e.g., `https://cf.yourdomain.com`) |
| `WORKER_DOMAIN` | Yes | Your domain for custom subdomains (e.g., `yourdomain.com`) |
| `VITE_WORKER_DOMAIN` | Yes | Same as WORKER_DOMAIN (for UI display) |
| `INTERNAL_PORT` | No | Local HTTP/WebSocket server port (default: 22000) |
| `VITE_RENDERER_PORT` | No | Vite dev server port for tray app (default: 5174) |
| `VITE_CLIENT_PORT` | No | Vite dev server port for PWA client (default: 5175) |

## Usage

1. **Start the app** - Launch Root_Operator from Applications or run `npm run dev:app`
2. **Connect tunnel** - Click "Jump" to start the secure tunnel
3. **Copy the link** - Click the copy icon to copy the tunnel URL
4. **Open on device** - Paste the URL in Safari on your iPhone or any browser
5. **Pair device** - A 6-character pairing code appears on the client; enter it in the desktop app to authorize
6. **Verify fingerprint** - Confirm the 12-word fingerprint matches on both devices
7. **Start typing** - You now have secure terminal access!

### Operator URL

You can set a custom Operator URL (e.g., `myname.rootoperator.dev`) for easier sharing:
1. Open Settings in the tray menu
2. Enter your desired name in the Operator URL field
3. Your tunnel will be accessible at `yourname.rootoperator.dev`

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   iOS Client    │────▶│ Cloudflare Tunnel│────▶│  Root_Operator  │
│   (PWA/xterm)   │◀────│   (cloudflared)  │◀────│   (Electron)    │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                                                         │
                                                         ▼
                                                 ┌─────────────────┐
                                                 │   PTY Process   │
                                                 │   (node-pty)    │
                                                 └─────────────────┘
```

### Security Model

- **Transport Security**: Cloudflare Tunnel provides TLS encryption
- **End-to-End Encryption**: Additional AES-256-GCM encryption layer
- **Key Exchange**: ECDH P-256 with HKDF key derivation
- **Authentication**: RSA-PSS 2048-bit signatures with challenge-response
- **Credential Storage**: Cloudflare tokens stored in macOS Keychain via keytar
- **ANSI Sanitization**: Dangerous escape sequences are filtered

## Development

```bash
# Start with hot reload (recommended)
npm run dev:app

# Build client and renderer
npm run build:all

# Rebuild native modules after Node/Electron update
npm run rebuild

# Run security audit
npm run security:check
```

### Project Structure

```
├── main.js                 # Electron main process
├── preload.js              # IPC bridge with security whitelist
├── src/
│   ├── renderer/           # Tray app (React)
│   │   ├── App.jsx
│   │   └── components/
│   └── client/             # PWA client (React)
│       ├── App.jsx
│       ├── components/
│       └── hooks/
├── worker/                 # Cloudflare Worker (optional)
└── public/                 # Static assets
```

## Troubleshooting

### Native modules fail to build

```bash
npm run rebuild
```

### Tunnel fails to connect

- Check your internet connection
- If using a custom Operator URL, try disconnecting and reconnecting
- Check Console.app for detailed logs (enable Debug Logging in Settings)

### Can't type after reconnection

This is fixed in recent versions. If you experience this, update to the latest version.

## Roadmap

Planned features for future releases:

- **Custom Tunnel Settings** - Advanced Cloudflare tunnel configuration options
- **Terminal Tabs** - Multiple terminal sessions in a single window
- **Team Collaboration** - Individual sessions for team members with separate access controls

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

[MIT](LICENSE) - Copyright (c) 2026 Tomas Krajcik

## Acknowledgments

- [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/) for secure tunneling
- [xterm.js](https://xtermjs.org/) for terminal emulation
- [node-pty](https://github.com/microsoft/node-pty) for PTY support
- [Electron](https://www.electronjs.org/) for cross-platform desktop app
