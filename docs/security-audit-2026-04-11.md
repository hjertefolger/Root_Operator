# Root Operator Security Audit — 2026-04-11

## Executive summary
- `HIGH` The E2E layer does not authenticate the desktop's ephemeral key. The app marks the session "encrypted" before any meaningful fingerprint verification, so an active MITM can proxy auth and still read/modify traffic.
- `HIGH` WebSocket origin trust extends beyond the live tunnel hostname to cached/custom hostnames. If an old hostname is ever reassigned or attacker-served, same-origin browser storage can be abused to impersonate a paired device.
- `HIGH` The bridge HTTP/WebSocket server listens on all interfaces, not just loopback. That exposes the service directly to the LAN and reduces Cloudflare/tunnel isolation to a spoofable `Origin` header check.
- `HIGH` Removing a paired device does not terminate already-authenticated sockets. A stolen device that is already connected keeps access until it disconnects on its own.
- `MEDIUM` Unauthenticated global quotas are easy to exhaust. One actor can block all new connections or fill all pending pairing slots without ever authenticating.
- `MEDIUM` Some sensitive material is still stored in plaintext at rest: notably the push VAPID private key in `electron-store`, plus persistent chat/debug artifacts on disk.

## Findings
### [HIGH] E2E session setup is not authenticated
- Where: `main.js:406-489`; `src/client/hooks/useE2E.js:49-166`; `src/client/components/Header.jsx:194-262`
- What: After WebSocket auth, the desktop sends an unsigned ephemeral ECDH public key and the client accepts it as soon as the server echoes back the derived fingerprint. That fingerprint is not bound to any long-term desktop identity, and the UI comparison is optional and only available after `e2eReady` has already been set.
- Impact: An active attacker between client and desktop can relay pairing/authentication, terminate two separate ECDH handshakes, and read or modify the supposedly "end-to-end encrypted" terminal/chat traffic.
- Repro / reasoning: Proxy the connection, forward `pairing_request` and `auth_challenge`/`auth_response` intact, but answer `e2e_init` with the attacker's own public key. The client computes a fingerprint for the attacker-client secret; the real desktop computes a different fingerprint for the attacker-desktop secret. The attacker sends each side the fingerprint for its own leg, and both sides accept because neither side authenticates the transcript.
- Fix: Bind the E2E handshake to a long-term desktop identity or a pairing-derived secret, and do not mark the session secure until that verification succeeds. If manual fingerprint comparison is part of the design, make it explicit and blocking rather than advisory.

### [HIGH] Stale origin trust can combine with same-origin key reuse
- Where: `main.js:3219-3273`; `main.js:3338-3418`; `src/client/hooks/useAuth.js:29-67`; `src/client/hooks/useAuth.js:128-147`; `src/client/hooks/useAuth.js:180-189`
- What: Origin validation allows not only the active tunnel hostname, but also `store.tunnelSubdomain` and `cfSettings.domain`. Client pairing keys are persisted in IndexedDB under the web origin and then reused automatically on reconnect.
- Impact: If a previously valid hostname is ever reassigned, parked, or attacker-controlled, script served from that origin can reuse the stored `CryptoKey` material to authenticate to the current live bridge, giving the attacker full remote access as an already paired device.
- Repro / reasoning: Pair a device on hostname `A`. Later, run the desktop on a quick tunnel or different hostname `B`, while `store.tunnelSubdomain` still points at `A`. A malicious page served from `A` executes with access to the origin's IndexedDB, loads the stored non-extractable private key, uses it to answer `auth_challenge`, and opens a WebSocket to `B`. The desktop accepts the socket because `isOriginAllowed()` still trusts `A`.
- Fix: Only trust the currently active hostname for browser-origin checks, clear stale origin entries when the tunnel changes, and consider scoping browser-stored device keys to a stable pinned app origin or adding authenticated E2E that does not trust origin continuity.

### [HIGH] Revoking a device does not evict active sessions
- Where: `main.js:3813-3920`; `main.js:3981-3987`; `main.js:4327-4333`
- What: Authorization is latched onto the WebSocket via `ws.authenticated` and `ws.kid`. `REMOVE_PAIRED_DEVICE` removes the key from storage and deletes push subscriptions, but it never closes matching live sockets or re-checks revocation before handling subsequent messages.
- Impact: If a stolen device is already connected when the operator removes it, that session keeps full PTY/chat control and keeps receiving output until it disconnects on its own.
- Repro / reasoning: Authenticate a client, then remove its `kid` through `REMOVE_PAIRED_DEVICE`. The socket stays in `activeClients`, `ws.authenticated` remains `true`, and handlers such as `e2e_input`, `resize`, `notifications_*`, and `set_mode` continue to run.
- Fix: On removal, enumerate connected sockets by `ws.kid` and close them immediately. For defense in depth, also reject post-auth messages if the backing key has been revoked.

### [HIGH] The bridge binds to all interfaces instead of loopback
- Where: `main.js:3284-3338`; `main.js:3414-3418`
- What: The internal HTTP/WebSocket bridge is started with `server.listen(INTERNAL_PORT)` and no host binding. The tunnel itself is configured to forward to `localhost:${INTERNAL_PORT}`, but the Node server is also reachable directly on the host's LAN interfaces.
- Impact: Anyone on the same local network can reach the bridge directly, bypass the Cloudflare/TLS exposure model, and attack pairing/auth/availability surfaces with a raw WebSocket client.
- Repro / reasoning: From another machine on the LAN, connect to `ws://<desktop-ip>:22000` and set an allowed `Origin` header manually. The server accepts or rejects based on that header alone; it is not actually restricted to loopback.
- Fix: Bind the bridge explicitly to `127.0.0.1` and `::1`, or add real network-layer authentication if direct LAN access is intended.

### [MEDIUM] Global connection and pairing quotas are trivially exhaustible
- Where: `main.js:3526-3531`; `main.js:3613-3620`; `main.js:3661-3723`
- What: Rate limiting is a single global timestamp array, not per source. Pending pairings are also a single global map capped at five entries, and one unauthenticated socket can submit multiple `pairing_request` messages to consume all available slots.
- Impact: One attacker can block all new connections for everyone, or prevent legitimate pairing attempts, without ever authenticating.
- Repro / reasoning: Open 20 sockets in a minute to trip `MAX_CONNECTIONS_PER_MINUTE`, or send five unique `pairing_request` messages on one socket to fill `pendingPairings`. Both conditions deny service to legitimate users.
- Fix: Rate-limit by source identity (`CF-Connecting-IP` or equivalent), cap one pending pairing per socket/device, and keep abusive-client buckets separate from global service capacity.

### [MEDIUM] Push VAPID private key is stored unencrypted in `electron-store`
- Where: `main.js:1016-1048`; `main.js:2919-2922`
- What: The app initializes `electron-store` with default settings and persists the generated VAPID keypair directly under `pushVapidKeys`, including the private key used to sign Web Push messages.
- Impact: Any local user or process that can read the app's store file can send spoofed push notifications to all subscribed devices. Because the service worker honors payload-provided URLs, this can be used for convincing phishing flows.
- Repro / reasoning: `getStoredPushVapidKeys()` loads existing keys from the plaintext store or generates and writes a new pair there. Nothing moves the private key into Keychain/Keytar or another protected secret store.
- Fix: Store the VAPID private key in Keychain/Keytar or equivalent OS secret storage, and treat the plaintext store copy as a bug rather than normal configuration.

### [MEDIUM] The production CSP is too permissive to contain a web-client compromise
- Where: `main.js:4153-4167`
- What: The production CSP allows `script-src 'self' 'unsafe-inline'`, `style-src 'unsafe-inline'`, and `connect-src 'self' wss: ws:`. That is not a strict CSP; it permits inline script execution and arbitrary WebSocket destinations.
- Impact: If the PWA ever gets an injection bug, CSP will do little to stop it from running arbitrary code and exfiltrating over WebSockets. That matters because the client keeps authentication material in IndexedDB and terminal/chat state in web storage.
- Repro / reasoning: The header itself explicitly authorizes inline script and broad WebSocket scheme access. There is no nonce/hash-based restriction or tight destination allowlist.
- Fix: Remove `unsafe-inline` from `script-src`, tighten `connect-src` to explicit origins, and move any required inline code/styles behind nonces, hashes, or build-time extraction.

### [LOW] The Electron IPC bridge is broader than it needs to be
- Where: `preload.js:8-37`; `main.js:2997-3004`; `main.js:3087-3118`
- What: The preload allowlist is channel-based, but it still exposes generic `GET_STORE` / `SET_STORE` plus direct secure-token access. The main process does not validate requested store keys or constrain which secrets/config entries a renderer may read or write.
- Impact: A renderer compromise would immediately become a security-state compromise: it could add/remove paired keys, replace VAPID material, read Cloudflare tokens, or mutate other protected state.
- Repro / reasoning: The desktop renderer already uses `GET_STORE` and `GET_SECURE_TOKEN`; nothing prevents a compromised renderer from invoking `SET_STORE('keys', ...)`, `GET_STORE('pushVapidKeys')`, or `GET_SECURE_TOKEN`.
- Fix: Replace generic store/token IPC with purpose-built handlers for exactly the settings each renderer view needs, and never expose secret-bearing reads to a renderer unless there is no alternative.

## What's already solid
- The three pairing fixes made earlier today are present: `keyId` is now bound to the submitted `jwk`, keys are no longer persisted before proof-of-possession, and pending challenge state is cleared after use. Verified in `main.js:3543-3586`, `main.js:3661-3809`, and `main.js:4242-4307`.
- The main desktop windows are using the right baseline Electron flags: `nodeIntegration: false`, `contextIsolation: true`, and `sandbox: true` in `main.js:733-748` and `main.js:848-864`.
- No unauthenticated WebSocket message handlers exist beyond `ping`, `pairing_request`, and `auth_response`. Notification, resize, mode-switch, E2E client-key, and encrypted input handlers are all gated on `ws.authenticated` in `main.js:3813-3920`.
- Challenge TTLs and auth timeouts are enforced server-side. Pairing codes expire after two minutes, auth challenges after 30 seconds, and unauthenticated sockets are closed after three minutes: `main.js:234-237`, `main.js:3519-3522`, `main.js:3597-3611`, `main.js:3625-3631`, `main.js:3743-3748`, `main.js:4277-4289`.
- The RSA-PSS parameters are consistent between sign and verify: SHA-256 with `saltLength: 32` on both client and server: `src/client/hooks/useAuth.js:218-226`, `main.js:3568-3579`, `main.js:3957-3970`.
- No renderer-exposed IPC handler directly accepts arbitrary file paths, shell strings, or binary paths for execution. PTY shell path, argv, cwd, and environment are chosen in main process code rather than by WebSocket or renderer input: `main.js:4017-4071`, `main.js:2467-2483`.
- The static asset server includes path-normalization checks that correctly block straightforward traversal attempts: `main.js:4170-4237`.
- No service-worker caching layer that would obviously allow stale code poisoning. `sw.js` claims clients immediately and handles push/click events, but it does not precache or proxy application responses: `public/sw.js:1-74`.

## Out of scope / needs human decision
- `npm audit` could not be completed in the audit sandbox (no network). Needs to be run separately.
- The client intentionally persists some sensitive UX state locally: terminal output in `sessionStorage` (`src/client/hooks/useTerminalPersistence.js:22-45`, `src/client/hooks/useTerminalPersistence.js:94-115`) and chat drafts in `sessionStorage` (`src/client/components/ChannelChat.jsx:307-321`). Local-data-retention decision, not a bug by itself.
- Channel mode intentionally writes conversation history and Claude activity artifacts under `~/.root-operator`. Whether that is acceptable depends on product expectations around local secrecy, supportability, and incident response.
- Manual fingerprint comparison exists on both desktop and client, but it is not enforced. If the product promise is "true E2E above Cloudflare," this likely needs an architectural decision rather than a one-line patch.
