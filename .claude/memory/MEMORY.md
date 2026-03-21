# Root Operator Project Memory

## Architecture
- Main process: `main.js` (Electron, HTTP server port 22000, WebSocket, tunnel, PTY, E2E encryption)
- Tray renderer: `src/renderer/` (React + Tailwind + shadcn)
- Chat window: `src/chat/App.jsx` (separate BrowserWindow, shares preload.js)
- PWA client: `src/client/` (terminal access for paired devices)
- Worker: `worker/index.js` (Cloudflare Worker for tunnel assignment + message relay)
- IPC whitelist: `preload.js` — channels MUST be added here for renderer/chat to use

## Key Patterns
- Worker auth: ECDSA P-256 signatures with `signMessage()`, `getOrCreateWorkerKeyPair()`, `getMachineId()`
- Worker URL: `WORKER_BASE_URL` env var, domain: `WORKER_DOMAIN`
- HTTP API endpoints on tunnel server: in `handleApiRoute()` function
- Tunnel lifecycle: `startBridge()` → `tunnelProcess.on('url')` → `stopBridge()`
- Chat window: created in `showChatWindow()`, `chatWindow` global variable
- Conversations stored in electron-store under key `conversations`
- Contacts stored in electron-store under key `knownOperators`

## Recent Changes (Feb 2026)
- Replaced group chat with 1:1 DM system (feature/collab-sessions branch)
- Worker gained: /api/v1/messages/send, messages/poll, invites/relay + MESSAGES KV
- main.js: DM_SEND, DM_HISTORY, DM_CONVERSATIONS, DM_MARK_READ IPC handlers
- POST /api/dm endpoint on tunnel server for receiving DMs
- 30s polling interval for offline message relay via Worker
- SEND_INVITE now falls back to Worker relay when target offline
- wrangler.toml needs MESSAGES KV IDs replaced after `wrangler kv namespace create MESSAGES`