# Outbound Attachments Implementation Notes

## What Changed

- Extended `mcp__root-operator__reply` / `reply` to accept optional `attachments: string[]` absolute image paths.
- Added outbound attachment staging under `~/.root-operator/workspace/attachments/outbound/`.
- Validated outbound files as images only (`png`, `jpeg/jpg`, `webp`, `gif`) with MIME sniffing and a `10 MB` cap.
- Stored attachment metadata on assistant `channel_message` records in `ChatStore`, while stripping `bytesBase64` before JSONL persistence.
- Sent attachment bytes inline over the existing E2E WebSocket in assistant `channel_message.attachments[].bytesBase64`.
- Added a WebSocket capability handshake via `client_capabilities { supportsAttachments: true }`.
- Added downgrade behavior for older clients: assistant text is preserved and attachments become `"[Attachment: <name> — open in a newer client]"`.
- Rendered outbound assistant attachment pills plus inline image previews in the shared chat UI used by the web client and desktop local chat.

## GC Design

- Outbound staged files stay in `attachments/outbound/`.
- When `ChatStore` truncation evicts messages, the main process touches the referenced staged files to mark the start of the GC grace period.
- A periodic sweep runs at boot and every 6 hours.
- Sweep deletes outbound staged files that are:
  - no longer referenced by current chat history, and
  - older than the 7 day grace period since their last GC touch.

## Verification

- `node --check channel-bridge.cjs`
- `node --check main.js`
- `node --check src/chat-store.js`
- `node --check src/outbound-attachments.js`
- `node --check src/workspace.js`
- `node --check src/claude-session-supervisor/pr3-effect-ledger.test.js`
- `npm run build:client`
- `npm run build:renderer`
- `npm run build:bridge`
- `npm run test:supervisor` -> `114 passing, 0 failing`

## Deferred

- Non-image outbound attachments (`pdf`, docs, text files, video).
- Separate Electron viewer window for attachments.
- Chunked / on-demand attachment fetch instead of inline base64 transport.
- Any iOS-specific client work outside the shared web chat surface.
