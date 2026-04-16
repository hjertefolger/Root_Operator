# Outbound Attachments Implementation Notes

## What Changed

- Extended `mcp__root-operator__reply` / `reply` to accept optional `attachments: string[]` absolute image paths.
- Added outbound attachment staging under `~/.root-operator/workspace/attachments/outbound/`.
- Validated outbound files as images only (`png`, `jpeg/jpg`, `webp`, `gif`) with MIME sniffing and a `10 MB` cap.
- Stored attachment metadata on assistant `channel_message` records in `ChatStore`, while stripping `bytesBase64` before JSONL persistence.
- Stripped `bytesBase64` from all `channel_message` and `channel_history` envelopes; transport now carries metadata only (`id`, `name`, `mime`, `size`, `sha256`, `kind`, plus `external_ref` on the parent message).
- Added a WebSocket capability handshake via `client_capabilities { supportsAttachments: true }`.
- Added downgrade behavior for older clients: assistant text is preserved and attachments become `"[Attachment: <name> — open in a newer client]"`.
- Added authenticated on-demand fetch via `fetch_attachment_bytes { request_id, attachment_id, external_ref }`, with `attachment_bytes_response` returned over the same E2E wrapper as chat traffic.
- Updated the shared chat UI (web + desktop local chat) to lazily fetch attachment bytes on first open, cache them in memory, and show loading/error states with retry.

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
- `node --check preload.js`
- `npm run build:client`
- `npm run build:renderer`
- `npm run build:bridge`
- `npm run test:supervisor` -> `116 passing, 0 failing`

## Deferred

- Non-image outbound attachments (`pdf`, docs, text files, video).
- Separate Electron viewer window for attachments.
- Any iOS-specific client work outside the shared web chat surface.
