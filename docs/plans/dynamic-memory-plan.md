# Dynamic Memory Implementation Plan

**Branch:** `feat/dynamic-memory`
**Base:** `main`
**Repo:** `/Users/rootoperator/Documents/Dev/55-Root_Operator/`
**Authored:** 2026-04-14

---

## 1. Branch Strategy

**Branch name:** `feat/dynamic-memory`

**Base:** `main` at its current HEAD. No rebase necessary until merge.

**Merge criteria:**
- Feature flag defaults OFF and survives app restart correctly
- Toggle in SettingsView immediately gates indexing and injection (no restart required)
- User message arrives, is indexed into SQLite; query embedding runs against the store; top-5 chunks appear in the system prompt before next Claude Code spawn
- Claude Code receives the injected context in `--append-system-prompt-file` and has no knowledge of the mechanism
- ONNX model loads from `extraResources` in the packaged app without network access
- `npm run build:unsigned` succeeds with no new audit criticals
- Manual smoke test: send 5 messages, restart app, verify relevant context surfaces in next session

---

## 2. What to Port from Cortex

### 2a. DB Schema + Init

| Cortex source | New location in Root Operator | Changes |
|---|---|---|
| `src/database.ts:createSchema()` | `src/dynamic-memory/db.js:createSchema()` | Drop `session_turns`, `session_summaries`, `session_progress` tables. Keep only `memories` table with FTS5 virtual table and triggers. Port `initDb()`, `saveDb()` (atomic write pattern), `contentExists()`, `hashContent()`, `insertMemory()`, `searchByVector()`, `searchByKeyword()`, `searchByFts5()`, `searchByLike()`, `cosineSimilarity()`. |
| `src/database.ts:initDb()` | `src/dynamic-memory/db.js:initDb()` | Remove sql.js init — use `better-sqlite3` instead (synchronous, Electron-compatible, no WASM overhead). |

**Why better-sqlite3 instead of sql.js:**
sql.js is WASM-based and ships its own ~1.5MB `sql-wasm.wasm` file. better-sqlite3 is a native Node addon (already in the native rebuild pipeline via `electron-rebuild`). It is synchronous, faster, and integrates cleanly with Electron's existing native module rebuild tooling. The trade-off is it requires a native rebuild step, which Root Operator already does for node-pty and keytar.

**Schema to implement in better-sqlite3 dialect:**

```sql
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL UNIQUE,
  embedding BLOB NOT NULL,
  chat_id TEXT,
  source_role TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_memories_chat_id ON memories(chat_id);
CREATE INDEX IF NOT EXISTS idx_memories_timestamp ON memories(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_memories_content_hash ON memories(content_hash);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content,
  content='memories',
  content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.id, old.content);
END;
```

Note: `project_id` becomes `chat_id` — Root Operator scopes memory to channel IDs, not filesystem project paths.

### 2b. Embedding Pipeline

| Cortex source | New location | Changes |
|---|---|---|
| `src/embeddings.ts` | `src/dynamic-memory/embeddings.js` | Convert TypeScript to plain CommonJS. Keep singleton `initEmbedder()` pattern, `embedPassage()`, `embedQuery()`, `embedBatch()` with retry. Add `modelPath` parameter to `initEmbedder()` that accepts an absolute path to the ONNX model directory (from `process.resourcesPath`), replacing HuggingFace hub download. Set `env.localModelPath` and `env.allowRemoteModels = false` before creating pipeline. |

**Model path in Electron:**
```js
const modelDir = app.isPackaged
  ? path.join(process.resourcesPath, 'nomic-embed-text-v1.5')
  : path.join(__dirname, 'models', 'nomic-embed-text-v1.5');
```

### 2c. Hybrid Search

| Cortex source | New location | Changes |
|---|---|---|
| `src/search.ts:hybridSearch()` | `src/dynamic-memory/search.js:hybridSearch()` | Drop `projectScope`/`includeAllProjects` options. Replace with `chatId` filter. Keep `combineWithRRF()` verbatim (pure math, no dependencies). Keep `applyRecencyDecay()` verbatim. Keep constants: `VECTOR_WEIGHT=0.6`, `KEYWORD_WEIGHT=0.4`, `RRF_K=60`, `RECENCY_HALF_LIFE_DAYS=7`. |

### 2d. Chunk Extraction

| Cortex source | New location | Changes |
|---|---|---|
| `src/archive.ts:extractChunks()` | `src/dynamic-memory/chunker.js:extractChunks()` | Port verbatim. Keep `MIN_CONTENT_LENGTH=75`, `OPTIMAL_CHUNK_SIZE=400`, `MAX_CHUNK_SIZE=600`. |
| `src/archive.ts:shouldExclude()` | same file | Port verbatim. |
| `src/archive.ts:getContentValue()` | same file | Port verbatim. |
| `EXCLUDED_PATTERNS`, `HIGH_VALUE_PATTERNS`, `VALUABLE_PATTERNS` | same file | Port verbatim. |
| Role-based prefix (`[User request] ...`) | same file | Keep — helps retrieval distinguish question from answer. |

### 2e. Dedup

| Cortex source | New location | Changes |
|---|---|---|
| `src/database.ts:hashContent()` | `src/dynamic-memory/db.js:hashContent()` | Port verbatim. SHA256 hex, truncated to 16 chars. |
| `src/database.ts:contentExists()` | same file | Port verbatim. |

### 2f. Explicit Skip List

The following Cortex components are NOT ported:

- `src/index.ts` — CLI entry point, command router, all command handlers
- `src/stdin.ts` — Claude Code stdin JSON reader
- `src/config.ts` — File-based ~/.cortex/config.json system
- `src/analytics.ts` — Session metrics
- `src/archive.ts:buildRestorationContext()` — Context restoration after /clear
- `src/archive.ts:appendSessionTurns()` — Raw turn storage
- `src/archive.ts:archiveSession()` — JSONL transcript parser
- `src/archive.ts:extractSessionInsights()` — Pattern extraction for summaries
- `hooks/hooks.json` — Claude Code hook manifest
- Backup/recovery logic — Defer. Simple atomic write is enough for v1.
- `session_turns`, `session_summaries`, `session_progress` tables

---

## 3. New Architecture

### Module Structure

```
src/dynamic-memory/
  index.js          DynamicMemory facade — the single object main.js touches
  db.js             SQLite init/schema/CRUD/search (better-sqlite3)
  embeddings.js     @xenova/transformers embedding pipeline singleton
  chunker.js        Content filtering, chunk extraction, dedup
  search.js         hybridSearch(), combineWithRRF(), applyRecencyDecay()
  prompt.js         buildMemoryBlock() — formats search results as prompt section
```

### Class Responsibilities

**`src/dynamic-memory/index.js` — `DynamicMemory` class**

```
constructor(userDataPath, resourcesPath)
  init(store)         — opens DB, initializes embedder lazily, sets enabled state from store
  isEnabled()         — returns in-memory flag (checked before every operation)
  setEnabled(bool)    — flips flag, persists to electron-store
  indexMessage(role, content, chatId)  — chunks → dedup → embed → insert (fire-and-forget)
  buildContextForSpawn(query, chatId, limit=5)  — hybridSearch → formatPromptBlock
  close()             — closes DB connection on app quit
```

### Data Flow

```
USER MESSAGE ARRIVES
        |
        v
submitChannelUserMessage()                    [main.js:2124]
        |
        +---> dynamicMemory.indexMessage('user', content, chatId)   [fire-and-forget]
        |         |
        |         v
        |     chunker.extractChunks(content, 'user')
        |         |
        |         v
        |     shouldExclude() + getContentValue()  -- drop noise
        |         |
        |         v
        |     db.contentExists() via hashContent()  -- SHA256 dedup
        |         |
        |         v
        |     embeddings.embedPassage(chunk)
        |         |
        |         v
        |     db.insertMemory(chunk, embedding, chatId, 'user', timestamp)
        |
        v
channelManager.sendToChannel()               [existing, unchanged]


CLAUDE REPLY ARRIVES
        |
        v
channelManager.on('claude_reply', handler)   [main.js:3081]
        |
        +---> dynamicMemory.indexMessage('assistant', reply.text, chatId)  [fire-and-forget]
        |
        v
chatStore.addMessage() + broadcast           [existing, unchanged]


BEFORE CLAUDE CODE SPAWN
        |
        v
prepareClaudeWorkspaceRuntime()              [main.js:2785]
        |
        +---> writeSystemPromptFile()        [workspace.js — existing]
        |
        +---> (async IIFE) dynamicMemory.buildContextForSpawn(query, chatId)
        |         |
        |         v
        |     extract query from last N user messages
        |         |
        |         v
        |     search.hybridSearch(db, query, {chatId, limit:5})
        |         |
        |         v
        |     prompt.buildMemoryBlock(results)
        |         |
        |         v
        |     fs.appendFileSync(systemPromptFile, memoryBlock)
        |
        v
pty.spawn('claude', ['--append-system-prompt-file', systemPromptFile, ...])
```

### Feature Flag Gate

The flag lives in memory as `dynamicMemory._enabled` (boolean). Initialized from `store.get('dynamicMemory.enabled', false)` at startup. `setEnabled()` writes to electron-store synchronously and updates the in-memory flag atomically. Every public method of `DynamicMemory` checks `this._enabled` as its first line. Re-checks after each async step inside `indexMessage()` to minimize wasted work on mid-operation disable.

### DB Location

```
app.getPath('userData')/dynamic-memory/memory.db
```

On macOS: `~/Library/Application Support/Root_Operator/dynamic-memory/memory.db`

### ONNX Model Location

- **Dev:** `~/.cache/huggingface/hub/` (default Xenova cache, populated by `scripts/download-model.js`)
- **Packaged:** `{app}.app/Contents/Resources/nomic-embed-text-v1.5/` (via `extraResources`)

---

## 4. Integration Points in Root Operator

### 4a. Message-Arrival Index Hook

**File:** `main.js` — Function: `submitChannelUserMessage()` at line 2124

After `channelManager.sendToChannel()` succeeds (line 2133), before `channelReplyPending = true`:

```js
if (dynamicMemory && dynamicMemory.isEnabled()) {
    dynamicMemory.indexMessage('user', content, chatId).catch(err =>
        logDebug(`[MEMORY] Index error: ${err.message}`)
    );
}
```

### 4b. Assistant-Reply Index Hook

**File:** `main.js` — `channelManager.on('claude_reply', handler)` at line 3081

After `chatStore.addMessage()` at line 3090:

```js
if (dynamicMemory && dynamicMemory.isEnabled()) {
    dynamicMemory.indexMessage('assistant', msg.content, msg.chat_id || reply.chat_id).catch(err =>
        logDebug(`[MEMORY] Index error: ${err.message}`)
    );
}
```

### 4c. Pre-Spawn Search + Prompt Injection Hook

**File:** `main.js` — Function: `spawnClaudeCode()` at line 2894

Wrap injection in an async IIFE (avoid converting the outer function to async to not break timeout callers):

```js
// Between prepareClaudeWorkspaceRuntime() and pty.spawn():
if (dynamicMemory && dynamicMemory.isEnabled()) {
    (async () => {
        try {
            const recentContent = chatStore.loadMessages()
                .slice(-10)
                .filter(m => m.role === 'user')
                .map(m => m.content)
                .join(' ');
            if (recentContent.trim().length > 20) {
                const memoryBlock = await dynamicMemory.buildContextForSpawn(recentContent, null);
                if (memoryBlock) {
                    fs.appendFileSync(systemPromptFile, '\n\n' + memoryBlock, 'utf-8');
                    logDebug(`[MEMORY] Injected ${memoryBlock.length} chars`);
                }
            }
        } catch (err) {
            logDebug(`[MEMORY] Context injection failed: ${err.message}`);
        }
    })();  // Fire async, don't block spawn
}
```

Note: Trade-off with this approach — spawn may happen before injection completes. For v1, prefer synchronous await on a 1.5s timeout wrapper to guarantee injection or fast fallback. Decision: use `Promise.race` with a 1500ms timeout.

### 4d. Settings Toggle (UI + Storage + In-Memory Flag)

**IPC Handlers — File:** `main.js` near line 3475

```js
ipcMain.handle('GET_DYNAMIC_MEMORY_ENABLED', () => {
    return dynamicMemory ? dynamicMemory.isEnabled() : false;
});

ipcMain.handle('SET_DYNAMIC_MEMORY_ENABLED', (event, enabled) => {
    if (!dynamicMemory) return { success: false, error: 'Not initialized' };
    dynamicMemory.setEnabled(Boolean(enabled));
    store.set('dynamicMemory.enabled', Boolean(enabled));
    return { success: true, enabled: dynamicMemory.isEnabled() };
});
```

**Preload whitelist — File:** `preload.js:9` add:
```js
'GET_DYNAMIC_MEMORY_ENABLED',
'SET_DYNAMIC_MEMORY_ENABLED',
```

**Settings UI — File:** `src/renderer/components/SettingsView.jsx`

New accordion section following the "Debug Logging" pattern:
- Load initial value via `invoke('GET_DYNAMIC_MEMORY_ENABLED')` in `loadSettings()`
- Toggle calls `invoke('SET_DYNAMIC_MEMORY_ENABLED', newValue)` immediately
- No Save button needed — applies instantly

---

## 5. Settings UX

**Location in UI:** New accordion section "Dynamic Memory" in `SettingsView.jsx`, between "Debug Logging" and "App Updates".

**Content:**
```
Dynamic Memory
  [Switch: OFF by default]
  "Indexes conversation history for context retrieval across sessions.
   Uses local AI embeddings (~300MB, runs fully on-device)."
```

**Default state:** OFF. The feature ships disabled. User must explicitly enable.

**Persistence:** `store.set('dynamicMemory.enabled', bool)` via electron-store.

**Instant disable behavior:**
- `setEnabled(false)` sets `this._enabled = false` immediately
- Re-checks inside `indexMessage()` after each async step minimize wasted work
- Worst case: one in-flight embed completes after toggle (acceptable)
- Pre-spawn injection gates on flag — no context appended when disabled

**Model load timing:** `initEmbedder()` is lazy — first call on first `indexMessage()` after enable. Takes 1-3 seconds on Apple Silicon (quantized model). Subsequent calls use singleton.

---

## 6. Packaging

### electron-builder extraResources

Add to `package.json` under `"build"`:

```json
"extraResources": [
  {
    "from": "models/nomic-embed-text-v1.5",
    "to": "nomic-embed-text-v1.5",
    "filter": ["**/*"]
  }
]
```

### asarUnpack additions

```json
"node_modules/better-sqlite3/**/*",
"node_modules/onnxruntime-node/**/*"
```

Full updated `asarUnpack`:

```json
"asarUnpack": [
  "channel-bridge.bundle.cjs",
  "claude-stop-hook.cjs",
  "workspace-templates/**/*",
  "node_modules/node-pty/**/*",
  "node_modules/keytar/**/*",
  "node_modules/cloudflared/**/*",
  "node_modules/uiohook-napi/**/*",
  "node_modules/better-sqlite3/**/*",
  "node_modules/onnxruntime-node/**/*"
]
```

### rebuild script

```json
"rebuild": "electron-rebuild -f -w node-pty keytar better-sqlite3",
"postinstall": "electron-rebuild -f -w node-pty keytar better-sqlite3"
```

### Model download script

`scripts/download-model.js` uses `@xenova/transformers` to download and cache the quantized model to `models/nomic-embed-text-v1.5/`. Run once during dev setup. Add `models/` to `.gitignore`. Document in README.

### Estimated DMG size increase

| Component | Size |
|---|---|
| nomic-embed-text-v1.5 (quantized ONNX) | ~274 MB |
| better-sqlite3 native binary | ~2 MB |
| onnxruntime-node binary | ~40 MB |
| @xenova/transformers JS | ~3 MB |
| **Total increase** | **~319 MB** |

Current DMG ~145 MB (arm64). New DMG ~464 MB.

---

## 7. Implementation Order

**Step 1 — Branch**
```bash
cd ~/Documents/Dev/55-Root_Operator
git checkout -b feat/dynamic-memory
```

**Step 2 — Install dependencies**
```bash
npm install better-sqlite3 @xenova/transformers
npm run rebuild
```

**Step 3 — Download ONNX model**
Write `scripts/download-model.js` first. Then:
```bash
node scripts/download-model.js
```

**Step 4 — Write `src/dynamic-memory/db.js`**
Port schema, init, insert, search, dedup. Translate sql.js API → better-sqlite3 API.

**Step 5 — Write `src/dynamic-memory/embeddings.js`**
Singleton pattern, local model path, Nomic prefixes.

**Step 6 — Write `src/dynamic-memory/chunker.js`**
Port extractChunks, shouldExclude, getContentValue verbatim.

**Step 7 — Write `src/dynamic-memory/search.js`**
Port hybridSearch, RRF, recency decay. Replace projectId with chatId.

**Step 8 — Write `src/dynamic-memory/prompt.js`**
Format search results as markdown block. Max 5 results, 300 chars each.

**Step 9 — Write `src/dynamic-memory/index.js`**
DynamicMemory facade class. Wire all modules.

**Step 10 — Wire into `main.js`**
Import, init in whenReady, add 3 hook points, 2 IPC handlers, close on quit.

**Step 11 — Wire IPC whitelist**
Add 2 channels to `preload.js`.

**Step 12 — Add Settings UI toggle**
New accordion section in SettingsView.jsx.

**Step 13 — Update packaging config**
extraResources, asarUnpack, rebuild scripts.

**Step 14 — Test end-to-end in dev**
Send messages, verify indexing, kill Claude, respawn, check injection.

**Step 15 — Test packaged build**
`npm run build:unsigned`, disconnect wifi, verify model loads.

---

## 8. Codex Review Summary

### Accepted

**Issue 1 — `spawnClaudeCode()` async conversion risks.**
Accepted. Wrap injection in async IIFE rather than making outer function async. Use `Promise.race` with 1500ms timeout.

**Issue 2 — Race condition on rapid message bursts.**
Accepted. UNIQUE constraint on `content_hash` is the correct backstop. Duplicate insert silently caught by SQL error.

**Issue 3 — Feature flag gating during in-flight embed.**
Accepted with refinement. Re-check `this._enabled` after each async step inside `indexMessage()`.

**Issue 4 — Broad query scope.**
Accepted current approach. Recency decay handles within-session dominance.

### Rejected / Deferred

- Worker process offloading — defer (ONNX runtime has its own threads)
- Per-channel memory scoping on pre-spawn query — defer
- Streaming status indicator during embed — defer

---

## 9. Explicit Non-Goals

1. **Worker process offloading.** All embedding runs in main process. ONNX runtime uses its own threads — main event loop is not blocked.
2. **Debounced/batched saves.** `saveDb()` per message. Batch later if perf shows.
3. **CortexEngine facade.** No compatibility layer. Standalone feature.
4. **Memory management UI.** No view/search/delete UI. DB accumulates until manually deleted.
5. **Per-channel query scoping.** Stored with chat_id, but queries global. Defer channel-scoped retrieval.
6. **Cross-session restoration.** Injection at spawn only. No interactive recall.
7. **Automatic model update.** Bundled at build time.
8. **Model download on first enable.** Model is bundled.
9. **Memory expiry / TTL.** No auto-pruning.
10. **LIKE fallback.** better-sqlite3 ships FTS5; fallback code ported for safety only.

---

## File Map

### Files to CREATE:
- `src/dynamic-memory/index.js`
- `src/dynamic-memory/db.js`
- `src/dynamic-memory/embeddings.js`
- `src/dynamic-memory/chunker.js`
- `src/dynamic-memory/search.js`
- `src/dynamic-memory/prompt.js`
- `scripts/download-model.js`

### Files to MODIFY:
- `main.js` — import, init, 3 hooks, 2 IPC handlers
- `preload.js` — 2 channels added to whitelist
- `src/renderer/components/SettingsView.jsx` — Dynamic Memory accordion section
- `package.json` — dependencies, extraResources, asarUnpack, rebuild scripts

### Files to ADD (outside repo, required for build):
- `models/nomic-embed-text-v1.5/` — created by `scripts/download-model.js`

---

## Key Architectural Decisions

1. **better-sqlite3 over sql.js.** Synchronous, faster, integrates with existing native rebuild pipeline.
2. **Main-process only, no worker thread.** ONNX runtime has native threads. Event loop not blocked.
3. **Fire-and-forget indexing.** `.catch()` in hot path. Memory is best-effort.
4. **System prompt file append, not rebuild.** Append to existing file. Keeps injection isolated.
5. **chatId scoped storage, global query.** Stored with chat_id for future scoping; v1 queries globally.
6. **DB lives in workspace, not userData.** `<workspace>/brain/memory.db` sits alongside MEMORY.md, channel-history.jsonl, and attachments — one mental model for memory artifacts. Tradeoff: survives "reset app state" but NOT "delete workspace" (that's by design; workspace wipe = identity reset).
7. **Backup rotation at session start.** `<workspace>/brain/backups/memory-YYYYMMDD-HHMMSS.db.bak`, keep last 3. Simple `fs.copyFileSync` before DB is opened — no writer contention, no overhead on hot path. Does NOT protect against mid-session corruption.

---

## Platform Support: Intel vs Apple Silicon

**Build targets:** electron-builder config ships both arm64 and x64 DMG/ZIP. Universal single-binary is NOT used (doubles app size vs shipping two separate installers).

**Native modules:**
- `better-sqlite3` — rebuilt per-arch by electron-rebuild during `electron-builder --mac` (arch-aware).
- `onnxruntime-node` — ships prebuilt N-API v3 binaries for both `darwin/arm64` and `darwin/x64`. NAPI ABI is stable across Node/Electron, so no rebuild needed; the correct `.node` is selected at load time via `process.arch`. Verified: `node_modules/onnxruntime-node/bin/napi-v3/darwin/{arm64,x64}/onnxruntime_binding.node`.

**Performance expectations:**
- **Apple Silicon (M-series):** embedding ~150-250ms per chunk (ONNX CPU backend, but fast SIMD + unified memory). No Neural Engine used — onnxruntime-node's CPU provider doesn't target ANE.
- **Intel (x64):** embedding ~400-700ms per chunk (~2-3x slower due to AVX-only SIMD, no unified memory, older cores on many Intel Macs still in the field). Still usable for the fire-and-forget indexing path; the 1.5s spawn-context budget holds.
- **Memory pressure on 8GB Intel Macs:** nomic-embed-text-v1.5 ONNX is ~130MB RAM resident after first load. Combined with Electron baseline (~400MB) this is fine on 8GB but tight if the user has many other apps. Not a blocker.

**No known Intel-specific blockers.** sqlite-vec is NOT used (we do brute-force cosine in JS), so no platform-specific vector extension to worry about.
