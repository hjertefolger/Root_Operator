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
- Replaced the inline `360px` preview with a shared fullscreen overlay viewer (web + desktop local chat) rendered via portal, with `Escape`, backdrop click, top-right close button, and body-scroll locking.
- Added message-local attachment navigation inside the fullscreen viewer via keyboard arrow keys plus on-screen prev/next chevrons.
- Added viewport-fit image scaling with wheel zoom, touch-friendly pinch/pan gestures, and automatic re-fit on resize/orientation changes.
- Added a canvas-backed annotation layer in the fullscreen viewer with a pen toggle, six color swatches, four stroke widths, undo/redo (`Cmd/Ctrl+Z`, `Cmd/Ctrl+Shift+Z`, `Ctrl+Y`), and clear-all.
- Stored annotation strokes in source-image coordinates so the overlay stays aligned while zooming/panning and export can composite at the original image resolution.
- Added `Send back` in the fullscreen viewer: it flattens the current image plus annotations into a PNG, names it `<original>-annotated-<timestamp>.png`, and routes it through the existing inbound file upload path so chat history shows it as a normal user attachment.

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
