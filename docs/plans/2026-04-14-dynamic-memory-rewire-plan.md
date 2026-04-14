# Dynamic Memory Rewire — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Dynamic Memory injection from one-shot spawn-time system-prompt append → per-turn bridge-prefix enrichment in the Electron main process, add dev-mode perf instrumentation, and keep the channel-bridge subprocess untouched.

**Architecture:** Electron owns `dynamicMemory` and the inbound-message boundary. Enrichment happens before `channelManager.sendToChannel()`. Indexing still runs on the original (un-enriched) content so the DB stays clean. The bridge (`channel-bridge.cjs`) receives the enriched text in `client_message.content` exactly as if the user had typed it — zero bridge edits.

**Tech Stack:** Node.js (Electron main), better-sqlite3, nomic-embed-text-v1.5 (transformers.js). Branch: `feat/dynamic-memory`.

**Spec:** `docs/plans/2026-04-14-dynamic-memory-rewire-design.md`

---

## File Structure

| File | Change | Purpose |
|---|---|---|
| `main.js` | Modify ~2126–2164 (inbound path) | Add enrichment before `sendToChannel` |
| `main.js` | Delete ~2929–2958 (spawn injection) | Remove cache-once injection |
| `src/dynamic-memory/index.js` | Modify | Add `[MEMORY-PERF]` instrumentation behind env gate |
| `scripts/test-dynamic-memory.js` | Extend | New test for enrichment-path flow |
| `docs/plans/2026-04-14-dynamic-memory-rewire-design.md` | (already exists, untracked) | Commit with plan |

---

## Task 1: Extend smoke test with enrichment-path verification

**Files:**
- Modify: `scripts/test-dynamic-memory.js`

This adds a verification that `buildContextForSpawn(query, chatId)` returns non-null when we have relevant chunks indexed, and that the content wrapped inside `<memory-context>` matches what `buildMemoryBlock` produced. It's the closest thing to a unit test without introducing a new test framework to the repo.

- [ ] **Step 1: Add enrichment-simulation block to the smoke test**

Open `scripts/test-dynamic-memory.js`. After the existing `const block = await dm.buildContextForSpawn(...)` call (around line 68), add:

```javascript
        // --- Per-turn enrichment simulation ---
        // Verifies the exact shape the new main.js block will produce.
        const userTurn = 'How do we handle the spawn timeout for claude memory injection?';
        const hint = await dm.buildContextForSpawn(userTurn, 'test-chat-1', 3);
        if (!hint) {
            console.error('FAIL: enrichment produced null for a query that should match indexed content');
            process.exit(1);
        }
        const enriched = `<memory-context>\n${hint}\n</memory-context>\n\n${userTurn}`;
        console.log('==== enriched user turn ====');
        console.log(enriched);
        console.log('============================');
        if (!enriched.includes('<memory-context>') || !enriched.endsWith(userTurn)) {
            console.error('FAIL: enriched content malformed');
            process.exit(1);
        }
        console.log('OK: enrichment shape verified');
```

- [ ] **Step 2: Run smoke test and verify the new assertions pass**

```bash
cd ~/Documents/Dev/55-Root_Operator
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/test-dynamic-memory.js 2>&1 | tail -40
```

Expected: the output includes `==== enriched user turn ====` followed by a `<memory-context>` block with `## Relevant Context from Memory` header and fragments, followed by the userTurn text, then `OK: enrichment shape verified`. No `FAIL` lines.

- [ ] **Step 3: Commit**

```bash
cd ~/Documents/Dev/55-Root_Operator
git add scripts/test-dynamic-memory.js
git commit -m "test(dynamic-memory): add enrichment-shape verification to smoke test"
```

---

## Task 2: Remove spawn-time injection

**Files:**
- Modify: `main.js:2929–2958` (delete the whole dynamic-memory injection block inside `spawnClaudeCode` / `prepareClaudeWorkspaceRuntime` area)

The block calls `buildContextForSpawn(recentContent, undefined)` and appends to `systemPromptFile`. Per the empirical cache-once test on 2026-04-14, this only reaches the first turn. Removing it also removes the 1500ms race-timeout wrapper — that was specific to spawn-time.

- [ ] **Step 1: Confirm the exact block to delete**

Run:

```bash
cd ~/Documents/Dev/55-Root_Operator
grep -n "Dynamic Memory: if enabled" main.js
```

Expected: one match around line 2929 reading `// Dynamic Memory: if enabled, search for relevant past context and append`.

- [ ] **Step 2: Delete the block**

Delete exactly these lines in `main.js` (the `if (dynamicMemory && dynamicMemory.isEnabled()) { ... }` block plus the comment above it and any trailing blank line, currently lines 2929–2958):

```javascript
    // Dynamic Memory: if enabled, search for relevant past context and append
    // it to the system prompt file before Claude Code spawns. Bounded by a
    // 1500ms timeout so a slow embed never blocks spawn materially.
    if (dynamicMemory && dynamicMemory.isEnabled()) {
        try {
            const inject = (async () => {
                try {
                    const recentContent = (chatStore ? chatStore.loadMessages() : [])
                        .slice(-10)
                        .filter((m) => m && m.role === 'user' && typeof m.content === 'string')
                        .map((m) => m.content)
                        .join(' ');
                    if (recentContent.trim().length <= 20) return;
                    // chatId=undefined => global query across all stored fragments
                    // (chatId scoped storage, but v1 queries globally per plan).
                    const memoryBlock = await dynamicMemory.buildContextForSpawn(recentContent, undefined);
                    if (memoryBlock && typeof memoryBlock === 'string' && memoryBlock.length) {
                        fs.appendFileSync(systemPromptFile, '\n\n' + memoryBlock, 'utf-8');
                        logDebug(`[MEMORY] Injected ${memoryBlock.length} chars into system prompt`);
                    }
                } catch (err) {
                    logDebug(`[MEMORY] Context injection failed: ${err.message}`);
                }
            })();
            const timeout = new Promise((resolve) => setTimeout(resolve, 1500));
            await Promise.race([inject, timeout]);
        } catch (err) {
            logDebug(`[MEMORY] Injection race failed: ${err.message}`);
        }
    }
```

- [ ] **Step 3: Verify the file is still syntactically valid**

```bash
cd ~/Documents/Dev/55-Root_Operator
node --check main.js
```

Expected: no output (exit 0).

- [ ] **Step 4: Verify the spawn path still builds**

```bash
cd ~/Documents/Dev/55-Root_Operator
npm run build:all 2>&1 | tail -10
```

Expected: clean build, no errors.

- [ ] **Step 5: Commit**

```bash
cd ~/Documents/Dev/55-Root_Operator
git add main.js
git commit -m "refactor(dynamic-memory): remove cache-once spawn-time injection

The spawn-time buildContextForSpawn append to --append-system-prompt-file
is read once and cached in the prompt prefix for the session. Subsequent
turns never see updated memory. Verified empirically on 2026-04-14 via
MEMORY.md marker test. Bridge-prefix enrichment replaces this in next commit."
```

---

## Task 3: Add bridge-prefix enrichment

**Files:**
- Modify: `main.js` around line 2134 (inside `submitChannelUserMessage`)

Core rewire: before `channelManager.sendToChannel(...)`, if the feature is enabled, query memory and wrap the content in a `<memory-context>` block. Keep the original `content` for the existing `dynamicMemory.indexMessage('user', content, chatId)` call so the DB is indexed on original text, not enriched.

Budget: a 500 ms Promise.race guards against a stuck embedder. If the race times out, we forward the original content unchanged.

- [ ] **Step 1: Replace the inbound-message block**

In `main.js`, locate:

```javascript
    const ts = new Date().toISOString();
    const sentToBridge = channelManager.sendToChannel(chatId, content, userId || chatId);

    if (dynamicMemory && dynamicMemory.isEnabled()) {
        dynamicMemory.indexMessage('user', content, chatId).catch((err) => {
            logDebug(`[MEMORY] Index (user) error: ${err.message}`);
        });
    }
```

Replace with:

```javascript
    const ts = new Date().toISOString();

    // Dynamic Memory: enrich outbound content with a per-turn memory hint
    // before forwarding to the channel bridge. Indexing below still stores
    // the ORIGINAL content so the DB doesn't get polluted with hint wrappers.
    // Bounded by a 500ms Promise.race so a stuck embedder never delays
    // message delivery to Claude.
    let outboundContent = content;
    if (dynamicMemory && dynamicMemory.isEnabled()) {
        const perfStart = Date.now();
        try {
            const memoryBlock = await Promise.race([
                dynamicMemory.buildContextForSpawn(content, chatId, 5),
                new Promise((resolve) => setTimeout(() => resolve(null), 500)),
            ]);
            if (memoryBlock && typeof memoryBlock === 'string' && memoryBlock.length) {
                outboundContent = `<memory-context>\n${memoryBlock}\n</memory-context>\n\n${content}`;
            }
            if (process.env.NODE_ENV === 'development' || process.env.DYNAMIC_MEMORY_PERF === '1') {
                const wall = Date.now() - perfStart;
                const hit = outboundContent !== content;
                console.error(`[MEMORY-PERF] enrichment wall=${wall}ms hit=${hit} original_len=${content.length} enriched_len=${outboundContent.length}`);
                logDebug(`[MEMORY-PERF] enrichment wall=${wall}ms hit=${hit} original_len=${content.length} enriched_len=${outboundContent.length}`);
            }
        } catch (err) {
            logDebug(`[MEMORY] Enrichment failed: ${err.message}`);
            outboundContent = content;
        }
    }

    const sentToBridge = channelManager.sendToChannel(chatId, outboundContent, userId || chatId);

    if (dynamicMemory && dynamicMemory.isEnabled()) {
        dynamicMemory.indexMessage('user', content, chatId).catch((err) => {
            logDebug(`[MEMORY] Index (user) error: ${err.message}`);
        });
    }
```

Key invariants to double-check in this diff:
- `channelManager.sendToChannel(chatId, outboundContent, ...)` — uses enriched version
- `dynamicMemory.indexMessage('user', content, chatId)` — uses original version (unchanged)
- Feature flag gate wraps the whole enrichment block

- [ ] **Step 2: Verify syntax**

```bash
cd ~/Documents/Dev/55-Root_Operator
node --check main.js
```

Expected: exit 0, no output.

- [ ] **Step 3: Confirm `submitChannelUserMessage` is still an `async function`**

Run:

```bash
cd ~/Documents/Dev/55-Root_Operator
grep -n "function submitChannelUserMessage" main.js
```

Expected: the match must read `async function submitChannelUserMessage`. If it reads `function submitChannelUserMessage` (no `async`), edit it to add `async`. Reason: we now `await` the Promise.race inside the function.

- [ ] **Step 4: Update all four call sites of `submitChannelUserMessage`**

There are exactly four callers in `main.js`. Each has been audited. Apply these exact edits:

**Site A — `main.js:3553–3559` (IPC handler `SEND_LOCAL_CHAT_MESSAGE`):**

Current:
```javascript
ipcMain.handle('SEND_LOCAL_CHAT_MESSAGE', (event, text) => {
    if (typeof text !== 'string' || !text.trim()) {
        return { success: false, error: 'Message is empty' };
    }

    return submitChannelUserMessage('desktop-local', text.trim(), 'desktop-local');
});
```

Replace with:
```javascript
ipcMain.handle('SEND_LOCAL_CHAT_MESSAGE', async (event, text) => {
    if (typeof text !== 'string' || !text.trim()) {
        return { success: false, error: 'Message is empty' };
    }

    return await submitChannelUserMessage('desktop-local', text.trim(), 'desktop-local');
});
```

**Rationale:** `ipcMain.handle` natively supports Promise-returning handlers and passes the resolved value to `ipcRenderer.invoke`. Adding `async` + `await` is explicit for clarity; the behavior would be identical without them, but production-grade means "reads correctly" not "happens to work."

**Site B — `main.js:3614–3620` (IPC handler `SEND_LOCAL_CHAT_FILE`, tail of the handler):**

Current tail:
```javascript
    parts.push(`[File attached: ${filename}]\nSaved to: ${destPath}`);
    return submitChannelUserMessage('desktop-local', parts.join('\n\n'), 'desktop-local');
});
```

Replace with:
```javascript
    parts.push(`[File attached: ${filename}]\nSaved to: ${destPath}`);
    return await submitChannelUserMessage('desktop-local', parts.join('\n\n'), 'desktop-local');
});
```

Also confirm the handler signature at the `ipcMain.handle('SEND_LOCAL_CHAT_FILE', ...)` line is `async`. If not, add `async`. (Run `grep -n "SEND_LOCAL_CHAT_FILE" main.js` — if the matching line shows `(event, {...}) =>` without async, add it.)

**Site C — `main.js:4735–4747` (WebSocket `e2e_input` handler in channel mode — THE CRITICAL ONE):**

Current:
```javascript
            if (operatingMode === 'channel') {
                // Channel mode: forward to Claude Code via channel bridge
                const deviceId = ws.kid || 'unknown';
                const result = submitChannelUserMessage(deviceId, inputData, deviceId, {
                    echoToLocalChat: true,
                    senderWs: ws,
                });

                if (result.success) {
                    logDebug(`[CHANNEL] Forwarded input to channel bridge (len: ${inputData.length})`);
                } else {
                    logDebug(`[CHANNEL] Failed to forward input to channel bridge: ${result.error}`);
                }
            } else if (ptyProcess) {
```

Replace with:
```javascript
            if (operatingMode === 'channel') {
                // Channel mode: forward to Claude Code via channel bridge
                const deviceId = ws.kid || 'unknown';
                const result = await submitChannelUserMessage(deviceId, inputData, deviceId, {
                    echoToLocalChat: true,
                    senderWs: ws,
                });

                if (result.success) {
                    logDebug(`[CHANNEL] Forwarded input to channel bridge (len: ${inputData.length})`);
                } else {
                    logDebug(`[CHANNEL] Failed to forward input to channel bridge: ${result.error}`);
                }
            } else if (ptyProcess) {
```

Only change: added `await`. The outer handler is already `async` (verified: `ws.on('message', async (msg) => { ... })` at `main.js:4417`), so this is a single-token edit.

**This is the site that would silently misbehave** if we skipped this edit: `result` would become a Promise, `result.success` would be `undefined`, the log would always say "Failed to forward input to channel bridge: undefined" even when the forward actually succeeded.

**Site D — `main.js:4914–4918` (WebSocket `e2e_file_chunk` handler, fire-and-forget):**

Current:
```javascript
                parts.push(`[File attached: ${transfer.filename}]\nSaved to: ${absPath}`);
                submitChannelUserMessage(transfer.deviceId, parts.join('\n\n'), transfer.deviceId, {
                    echoToLocalChat: true,
                    senderWs: ws,
                });
```

Replace with:
```javascript
                parts.push(`[File attached: ${transfer.filename}]\nSaved to: ${absPath}`);
                const fileResult = await submitChannelUserMessage(transfer.deviceId, parts.join('\n\n'), transfer.deviceId, {
                    echoToLocalChat: true,
                    senderWs: ws,
                }).catch((err) => {
                    logDebug(`[CHANNEL] File attachment forward failed: ${err.message}`);
                    return { success: false, error: err.message };
                });
                if (!fileResult.success) {
                    logDebug(`[CHANNEL] File attachment forward not successful: ${fileResult.error}`);
                }
```

The outer handler is already `async` (same `ws.on('message', async (msg) => ...)`). The `.catch()` is belt-and-suspenders: even if `submitChannelUserMessage` throws (it shouldn't, it always returns an object), we never leak an unhandled Promise rejection. The new `if (!fileResult.success)` block surfaces forwarding failures in the log instead of silently dropping them.

- [ ] **Step 5: Verify all four sites edited, no `.success` access remains without `await`**

```bash
cd ~/Documents/Dev/55-Root_Operator
grep -n "submitChannelUserMessage" main.js
```

Expected: 5 matches total — one function definition line (at ~2126) and four call sites (3558, 3619, 4738, 4915, with `await` or `await ... .catch()` in front of each call). No bare `submitChannelUserMessage(` without `await` in front.

Also:
```bash
grep -nB1 "if (result.success)" main.js | grep -A1 submitChannelUserMessage
```

Expected: any match of this pattern must have `await` on the preceding line (Site C).

- [ ] **Step 6: Verify syntax**

```bash
cd ~/Documents/Dev/55-Root_Operator
node --check main.js
```

Expected: exit 0, no output.

- [ ] **Step 7: Verify the build**

```bash
cd ~/Documents/Dev/55-Root_Operator
npm run build:all 2>&1 | tail -10
```

Expected: clean build.

- [ ] **Step 8: Commit**

```bash
cd ~/Documents/Dev/55-Root_Operator
git add main.js
git commit -m "feat(dynamic-memory): per-turn bridge-prefix enrichment

Inbound messages are now enriched with a <memory-context> block before
forwarding to the channel bridge. Indexing still uses the original
content (no DB pollution). 500ms Promise.race guards against stuck
embedders. Gated by dynamicMemory.isEnabled().

Converts submitChannelUserMessage to async (await Promise.race for the
memory lookup) and updates all 4 call sites:
- SEND_LOCAL_CHAT_MESSAGE handler (await pass-through)
- SEND_LOCAL_CHAT_FILE handler (await pass-through)
- e2e_input WebSocket handler (await + existing .success check now correct)
- e2e_file_chunk WebSocket handler (await + .catch for unhandled rejection safety)

Replaces the cache-once spawn-time injection removed in prior commit."
```

---

## Task 4: Add dev-mode perf instrumentation to DynamicMemory internals

**Files:**
- Modify: `src/dynamic-memory/index.js`

The enrichment-side `[MEMORY-PERF]` log (added in Task 3) only captures wall-clock. This task adds fine-grained timings inside `indexMessage` and `buildContextForSpawn` so we can see where time is actually going (embedder cold load, chunk embed, SQLite insert, vector search, FTS search).

Gate: `process.env.NODE_ENV === 'development'` OR `process.env.DYNAMIC_MEMORY_PERF === '1'`. Off in packaged builds.

- [ ] **Step 1: Add a perf helper at the top of `src/dynamic-memory/index.js`**

Directly below the existing `const STORE_KEY = 'dynamicMemory.enabled';` line, add:

```javascript
const PERF_ENABLED = process.env.NODE_ENV === 'development' || process.env.DYNAMIC_MEMORY_PERF === '1';
function perfLog(msg) {
    if (PERF_ENABLED) {
        try { console.error(`[MEMORY-PERF] ${msg}`); } catch (_) { /* ignore */ }
    }
}
```

- [ ] **Step 2: Instrument `indexMessage`**

Inside the existing `async indexMessage(role, content, chatId)` method, add timing without changing behavior:

At the start of the method (after the existing early returns for disabled / empty / excluded), add:

```javascript
        const _perfT0 = Date.now();
        let _perfEmbedTotal = 0;
        let _perfEmbedCount = 0;
        let _perfInsertTotal = 0;
```

Around `embedding = await embeddings.embedPassage(chunk);`, wrap with:

```javascript
            const _perfEmbedStart = Date.now();
            let embedding;
            try {
                embedding = await embeddings.embedPassage(chunk);
            } catch (err) {
                this._log(`[MEMORY] embedPassage failed: ${err.message}`);
                continue;
            }
            _perfEmbedTotal += Date.now() - _perfEmbedStart;
            _perfEmbedCount += 1;
```

(This replaces the existing embedPassage call; keep the `if (!this.isEnabled()) return;` line that follows it.)

Around the `insertMemory(...)` call, wrap with:

```javascript
            const _perfInsertStart = Date.now();
            try {
                insertMemory(this.db, {
                    content: chunk,
                    embedding,
                    chatId: chatId || null,
                    sourceRole: effectiveRole,
                    timestamp: ts,
                });
            } catch (err) {
                if (!/UNIQUE/i.test(err.message)) {
                    this._log(`[MEMORY] insertMemory failed: ${err.message}`);
                }
            }
            _perfInsertTotal += Date.now() - _perfInsertStart;
```

At the very end of the method (just before the method's closing brace), add:

```javascript
        perfLog(`indexMessage role=${effectiveRole} chunks=${chunks.length} embed_total=${_perfEmbedTotal}ms embed_count=${_perfEmbedCount} insert_total=${_perfInsertTotal}ms total=${Date.now() - _perfT0}ms`);
```

- [ ] **Step 3: Instrument `buildContextForSpawn`**

Inside `async buildContextForSpawn(query, chatId, limit = 5)`, add timing:

At the start of the method (after early returns), add:

```javascript
        const _perfT0 = Date.now();
```

Immediately before `results = await hybridSearch(this.db, query, { chatId, limit });`, add:

```javascript
        const _perfSearchStart = Date.now();
```

Immediately after, add:

```javascript
        const _perfSearchMs = Date.now() - _perfSearchStart;
```

At the return statement `return buildMemoryBlock(results);`, change to:

```javascript
        const block = buildMemoryBlock(results);
        perfLog(`buildContextForSpawn total=${Date.now() - _perfT0}ms search=${_perfSearchMs}ms results=${results.length} query_len=${query.length} block_len=${block ? block.length : 0}`);
        return block;
```

Also, for the null-result path just before `return null` on an empty result set, add perfLog:

```javascript
        if (!results.length) {
            perfLog(`buildContextForSpawn total=${Date.now() - _perfT0}ms search=${_perfSearchMs}ms results=0 query_len=${query.length} block_len=0`);
            return null;
        }
```

- [ ] **Step 4: Instrument `_ensureEmbedder` for cold-load timing**

Replace the existing `_ensureEmbedder()` method body, keeping its existing shape but adding start/end timing logs:

```javascript
    async _ensureEmbedder() {
        if (this._embedderReady) return;
        if (this._embedderInitPromise) return this._embedderInitPromise;
        const baseDir = this._modelBaseDir();
        this._log(`[MEMORY] Initializing embedder (baseDir=${baseDir})`);
        const _perfT0 = Date.now();
        this._embedderInitPromise = (async () => {
            await embeddings.initEmbedder(baseDir);
            this._embedderReady = true;
            this._log('[MEMORY] Embedder ready');
            perfLog(`embedder cold_load=${Date.now() - _perfT0}ms`);
        })();
        try {
            await this._embedderInitPromise;
        } finally {
            this._embedderInitPromise = null;
        }
    }
```

- [ ] **Step 5: Verify syntax**

```bash
cd ~/Documents/Dev/55-Root_Operator
node --check src/dynamic-memory/index.js
```

Expected: exit 0, no output.

- [ ] **Step 6: Run smoke test with perf enabled and confirm timing logs appear**

```bash
cd ~/Documents/Dev/55-Root_Operator
DYNAMIC_MEMORY_PERF=1 ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/test-dynamic-memory.js 2>&1 | grep -E "\[MEMORY-PERF\]"
```

Expected: multiple lines matching:
- `[MEMORY-PERF] embedder cold_load=...ms` (once, first call)
- `[MEMORY-PERF] indexMessage role=... chunks=... embed_total=...ms embed_count=... insert_total=...ms total=...ms` (one per indexed message)
- `[MEMORY-PERF] buildContextForSpawn total=...ms search=...ms results=... query_len=... block_len=...` (one per query)

Record typical numbers — we want to confirm we're comfortably under 500 ms for `buildContextForSpawn` (without cold load). Cold load of the embedder is expected to be 1–3 s on Apple Silicon; that only hits on first call after toggle-on.

- [ ] **Step 7: Run smoke test WITHOUT perf flag and confirm no perf noise**

```bash
cd ~/Documents/Dev/55-Root_Operator
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/test-dynamic-memory.js 2>&1 | grep -c "MEMORY-PERF"
```

Expected: `0` — no perf output in non-dev mode.

- [ ] **Step 8: Commit**

```bash
cd ~/Documents/Dev/55-Root_Operator
git add src/dynamic-memory/index.js
git commit -m "feat(dynamic-memory): dev-mode perf instrumentation

Gated by NODE_ENV=development or DYNAMIC_MEMORY_PERF=1. Logs cold-load,
per-chunk embed, insert, and buildContextForSpawn timings to stderr via
console.error so they surface in 'npm run dev:app' terminal. Zero
overhead in packaged builds."
```

---

## Task 5: End-to-end verification in dev app

This task has no code — it verifies the whole rewired path works in a running Electron session with Claude Code as a subprocess.

**Prerequisite:** Tom must have `~/.root-operator/workspace/brain/memory.db` populated with some prior conversations OR be willing to have a few seeded turns first. If the DB is empty, `buildContextForSpawn` will return null (no hits) and the enrichment path will be a no-op — the test then only verifies the no-op doesn't break anything.

- [ ] **Step 1: Launch dev app with perf flag**

```bash
cd ~/Documents/Dev/55-Root_Operator
DYNAMIC_MEMORY_PERF=1 npm run dev:app 2>&1 | tee /tmp/dyn-mem-dev.log
```

Leave this running. A Root Operator window should open.

- [ ] **Step 2: Verify bridge comes up cleanly**

In the dev log, look for:
- `[CHANNEL] Bridge connected`
- `[MEMORY] DB ready at ~/.root-operator/workspace/brain/memory.db (enabled=...)`

If the bridge does not connect within 20 s, stop. Check recent edits to `main.js` for syntax or await-chain issues. Do NOT proceed.

- [ ] **Step 3: Enable Dynamic Memory in Settings**

In the running app, open Settings → toggle Dynamic Memory ON. On the next message, you should see `[MEMORY-PERF] embedder cold_load=...ms` in the dev log (first time only).

- [ ] **Step 4: Send a test message from a paired device**

Send any message from the iOS/desktop client. In the dev log, look for:
- `[MEMORY-PERF] enrichment wall=...ms hit=true|false original_len=... enriched_len=...`
- `[MEMORY-PERF] buildContextForSpawn total=...ms search=...ms results=... query_len=... block_len=...`
- `[MEMORY-PERF] indexMessage role=user chunks=... embed_total=...ms ...`

Verify:
- `enrichment wall` is comfortably under 500 ms (after cold load)
- If `hit=true`, `enriched_len > original_len` by at least the header characters
- Indexing fires after forwarding (order doesn't matter — both async)

- [ ] **Step 5: Confirm Claude received the enriched content**

In the dev app's Claude activity panel, or by scripting a reply from Claude that quotes what it received, confirm the `<memory-context>` block is visible in Claude's turn.

Simplest verification path: message "please repeat the content of any <memory-context> block you received, verbatim." If Claude quotes a `<memory-context>...</memory-context>` block, enrichment works.

- [ ] **Step 6: DB hygiene check — confirm original content is indexed, not enriched**

In a separate terminal:

```bash
sqlite3 ~/.root-operator/workspace/brain/memory.db "SELECT substr(content, 1, 40), substr(content, -40) FROM memories ORDER BY id DESC LIMIT 5;"
```

Expected: no row's `content` should contain the substring `<memory-context>` or `</memory-context>`. Verify with:

```bash
sqlite3 ~/.root-operator/workspace/brain/memory.db "SELECT COUNT(*) FROM memories WHERE content LIKE '%memory-context%';"
```

Expected output: `0`. If non-zero, Task 3 mixed up the indexing source. Stop, revert, fix.

- [ ] **Step 7: Toggle-off test**

Toggle Dynamic Memory OFF in Settings. Send one more message. In the dev log:
- NO `[MEMORY-PERF] enrichment ...` line should appear (the outer `if (dynamicMemory && dynamicMemory.isEnabled())` gate is skipped entirely).
- NO `[MEMORY-PERF] buildContextForSpawn ...` line for this message.
- NO `[MEMORY-PERF] indexMessage ...` line either.

This confirms the toggle is instant-apply both ways.

- [ ] **Step 8: Failure-path test — break embedder, confirm message still delivers**

With the app stopped, rename the model dir:

```bash
cd ~/Documents/Dev/55-Root_Operator
mv models/nomic-embed-text-v1.5 models/nomic-embed-text-v1.5.hidden
```

Relaunch: `DYNAMIC_MEMORY_PERF=1 npm run dev:app`. In Settings, enable Dynamic Memory. Send a message.

Expected:
- Message reaches Claude (bridge forwards it — enrichment silently returns null on embedder failure).
- Dev log shows `[MEMORY] Embedder init failed: ...` but NOT a crashed session.
- `[MEMORY-PERF] enrichment wall=...ms hit=false` appears (the timeout race or the null from buildContextForSpawn both yield `hit=false`).

Restore model:

```bash
cd ~/Documents/Dev/55-Root_Operator
mv models/nomic-embed-text-v1.5.hidden models/nomic-embed-text-v1.5
```

- [ ] **Step 9: Record observed perf numbers in the plan for the record**

Append a block to `docs/plans/2026-04-14-dynamic-memory-rewire-design.md` under a new `## Observed Performance (dev, YYYY-MM-DD)` section, with actual numbers for:
- `embedder cold_load`
- `buildContextForSpawn total` (warm, typical)
- `enrichment wall` (warm, typical)
- `indexMessage total` (warm, typical)

This anchors our budget assumptions in real measurements for future reference.

- [ ] **Step 10: Commit the observed-performance update**

```bash
cd ~/Documents/Dev/55-Root_Operator
git add docs/plans/2026-04-14-dynamic-memory-rewire-design.md
git commit -m "docs(dynamic-memory): record observed perf numbers from dev verification"
```

---

## Task 6: Commit the design doc and open a PR (gated on Codex)

- [ ] **Step 1: Commit the design doc (currently untracked)**

```bash
cd ~/Documents/Dev/55-Root_Operator
git add docs/plans/2026-04-14-dynamic-memory-rewire-design.md docs/plans/2026-04-14-dynamic-memory-rewire-plan.md
git commit -m "docs(dynamic-memory): design + implementation plan for per-turn rewire"
```

(If Task 5 Step 10 already committed an update to the design doc, this step only needs to add the plan file. Adjust the `git add` path accordingly.)

- [ ] **Step 2: DO NOT push or merge to master**

Per feedback memory `feedback_push_discipline.md`: don't auto-push. Per this plan's gating: wait on Codex review (quota refresh 20:29 CET) before merging.

Leave the branch `feat/dynamic-memory` as-is with the new commits. Ask Tom before pushing.

- [ ] **Step 3: After Codex review (next session)**

Re-run:

```bash
cd ~/Documents/Dev/55-Root_Operator
codex exec "$(cat docs/plans/2026-04-14-dynamic-memory-rewire-design.md)" --review
```

or the equivalent review command. If Codex flags issues, address them as follow-up commits. If Codex approves, ask Tom before pushing / merging.

---

## Self-Review

**Spec coverage** — every section of the design doc maps to a task:
- ✅ Remove main.js:2932–2946 → Task 2
- ✅ Add enrichment before line 2135 → Task 3
- ✅ Index original not enriched → Task 3 (explicit invariant + Task 5 step 6 verification)
- ✅ `<memory-context>` wrapper tag → Task 3
- ✅ 500ms Promise.race timeout → Task 3
- ✅ Zero bridge changes → enforced by not touching `channel-bridge.cjs`
- ✅ Feature flag instant-apply → inherited from existing code, verified in Task 5 step 7
- ✅ Dev-mode perf instrumentation → Task 4
- ✅ Test plan (flag off / on / toggle mid / DB hygiene / failure path) → Task 5

**Placeholder scan** — no "TBD" / "TODO" / "similar to above" / unspecified error handling. Each code block shows exact code to add or delete.

**Type/signature consistency:**
- `buildContextForSpawn(query, chatId, limit = 5)` used consistently with three positional args in Task 3 (Step 1) and Task 4 (Step 3).
- `indexMessage('user', content, chatId)` signature unchanged across Task 3 (Step 1) — existing behavior preserved.
- Feature-flag accessor `dynamicMemory.isEnabled()` used consistently at every gate.
- `submitChannelUserMessage` — Task 3 Step 3 explicitly verifies it's `async` after the change, and Step 4 checks callers.

**Open risk acknowledged but not blocking:** Task 3 Step 4 (caller compatibility with now-async `submitChannelUserMessage`) is the single highest-risk step in this plan. If a caller treats the result as sync and does property access, it will silently become a Promise and read `undefined.success`. The step tells the engineer to grep every call site and convert. If in doubt, stop and surface before proceeding.
