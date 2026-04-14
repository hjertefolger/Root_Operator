# Dynamic Memory — Injection Point Rewire

**Date:** 2026-04-14
**Branch:** `feat/dynamic-memory` (continuing, not new branch)
**Supersedes:** the injection piece of `dynamic-memory-plan.md` (2026-04-14 morning). All other pieces of that plan stand.

## Why this exists

The v1 implementation on `feat/dynamic-memory` injects the memory block via `--append-system-prompt-file` at spawn time. Research on 2026-04-14 (empirical MEMORY.md marker test + claude-code-guide agent) established this is a cache-once trap: the prompt prefix is written into the cache at session start and reused for the whole session. The memory block reaches the first turn only — every subsequent message sees no updated memory.

Tom's correct framing (2026-04-14 10:21): "per session is not Dynamic memory but Cortex. so in that case incorrectly implemented."

This doc specifies the minimum change to restore the per-turn semantics the feature was meant to have.

## What stays (do NOT touch)

All existing work on `feat/dynamic-memory` is correct and stays in place:

- `src/dynamic-memory/` module — db, embeddings, chunker, search, prompt, index facade
- DB at `~/.root-operator/workspace/brain/memory.db`, schema + FTS5 + vector index + triggers
- Embedder (nomic-embed-text-v1.5) — lazy-loaded, packaged via extraResources
- Indexing hook on inbound user messages (main.js:2138) — stores `source_role='user'`
- Indexing hook on Claude replies (main.js:3131–3133) — stores `source_role='assistant'`
- Feature flag in electron-store + Settings UI toggle (main.js:3476–3649 area, preload.js, SettingsView.jsx)
- Backup rotation (3 snapshots, before init)
- Symlink rejection on brain/ and memory.db

## What changes

Move the injection point from spawn-time prompt-file append → per-turn bridge-prefix enrichment, fully inside the Electron main process.

### Remove

main.js:2932–2946 — the spawn-time block that calls `buildContextForSpawn(recentContent, undefined)` and appends to `systemPromptFile`. Delete the block cleanly; keep the rest of the spawn setup intact.

### Add

main.js, immediately before line 2135 (`channelManager.sendToChannel(...)`), insert the enrichment step:

1. If `dynamicMemory?.isEnabled()`:
   - Call `dynamicMemory.buildContextForSpawn(content, chatId)` (already returns a markdown block or null).
   - If non-null, wrap as `<memory-context>\n{block}\n</memory-context>\n\n{original content}`.
2. Forward the enriched content via `channelManager.sendToChannel(chatId, enrichedContent, userId)`.
3. Index the **original** content (unchanged call at line 2138). Do NOT index the enriched version — the DB must not store memory-hint wrappers.

Optional wrapper for the `buildContextForSpawn` call: `Promise.race` with a 500 ms timeout, fall through to original content on timeout. Reason: keep the message-delivery critical path resilient to a stuck embedder.

### Unchanged

- `channel-bridge.cjs` — zero edits. The bridge stays dumb; it wraps whatever content it receives in the `<channel source="..." chat_id="...">…</channel>` envelope and forwards via MCP notification.
- `src/dynamic-memory/*` — zero edits. `buildContextForSpawn`'s signature happens to already be what the bridge-prefix needs. Name is now slightly misleading ("ForSpawn" → could rename to `buildMemoryContext`), but rename is cosmetic and deferred.

## Why this is correct

- **Per-turn:** the memory block is part of the NEW user turn, not the cached prefix. No cache-once trap.
- **Single-writer DB:** DynamicMemory lives in Electron only. Bridge never touches SQLite. No cross-process contention.
- **Bridge untouched:** no risk to startup, no risk to the stable `claude/channel` notification path. Today's bridge lockout incident (2026-04-14 11:15) makes this risk posture important.
- **Failure-isolated:** `buildContextForSpawn` already returns null on error. If it returns null, original content passes through unchanged. Enrichment failure never blocks message delivery.
- **Toggle works:** flipping the Settings flag OFF skips the `buildContextForSpawn` call entirely. Instant-apply.

## Tagging

Wrap enriched memory as:

```
<memory-context>
{output of prompt.js buildMemoryBlock}
</memory-context>

{original message content}
```

The `<memory-context>` tag is a clearly demarcated non-conversational block, modeled on Claude Code's own `<system-reminder>` convention. The assistant (Claude) can distinguish it from user text and treat it as hint material rather than instruction.

## Risk & rollback

- **Feature flag** gates the enrichment. If anything misbehaves, user toggles OFF in Settings, next message bypasses memory entirely. No restart required.
- **Rollback**: git revert the single commit introducing this change. Old behavior (cache-once spawn-time injection) returns.
- **Bridge safety**: zero bridge edits means zero risk to the connection Tom uses daily. This is the main reason for choosing bridge-prefix over any other approach.
- **Token cost**: memory block ~100–500 tokens/turn prepended to user message = full-price input tokens each turn. Measurable over a month but not prohibitive; acceptable for the expected value of per-turn recall.
- **Latency**: sync SQLite + async embed query. Budget ~200–500 ms warm, longer on first call after toggle-on (embedder lazy load). Optional Promise.race timeout at 500–1000 ms safeguards the critical path.

## Dev-mode instrumentation

Tom called this out: we need to see real numbers, not trust the budget. In dev mode only, emit timing logs at every hot path so we can validate that we're comfortably under the 500 ms timeout before enabling this in a real build.

**Gate:** `process.env.NODE_ENV === 'development'` or a dedicated `DYNAMIC_MEMORY_PERF=1` env var. Off by default in packaged builds — zero overhead for normal users.

**Where to add timings:**

1. `indexMessage(role, content, chatId)` in `src/dynamic-memory/index.js`
   - total ms
   - chunk count
   - embedder cold-load ms (first call only, after toggle-on)
   - mean embed-per-chunk ms
   - insert ms (SQLite write)

2. `buildContextForSpawn(query, chatId, limit)` in `src/dynamic-memory/index.js`
   - total ms
   - query-embed ms
   - hybridSearch ms (with vector/keyword split if cheap to measure)
   - result count
   - whether timeout was hit (from the outer Promise.race)

3. Bridge-prefix enrichment path in main.js (the new block before line 2135)
   - wall-clock between inbound message receipt and `sendToChannel` call
   - whether enrichment produced a non-null memory block
   - enriched content length vs original content length

**Format:** single-line tagged log, grep-friendly:
```
[MEMORY-PERF] buildContextForSpawn embed=120ms search=45ms total=165ms results=3 query_len=42
[MEMORY-PERF] indexMessage role=user chunks=2 embed_mean=88ms insert=3ms total=182ms
[MEMORY-PERF] enrichment wall=210ms hit=true original_len=87 enriched_len=612
```

**Destination:** `console.error` (so it appears in the `npm run dev:app` terminal) AND through the existing `logDebug` sink (so it lands in the debug file). Not sent across IPC to the renderer — keep it terminal/file only to avoid polluting user-facing events.

**Deletion-free release path:** this is a small amount of code. We keep it in the module behind the env gate permanently. That way we can re-enable it any time future latency regressions are suspected, without re-patching.

## Test plan

1. Branch checkout + rebuild (`npm run build:all`).
2. Flag OFF (default): inbound message arrives, no `buildContextForSpawn` call in debug log, bridge forwards content identical to pre-change behavior.
3. Flag ON: send a message whose content maps to known stored chunks; confirm Claude's context shows a `<memory-context>` block containing expected fragments; confirm the rest of the user turn is intact.
4. Flag ON, then toggle OFF mid-session: next inbound message bypasses enrichment.
5. DB hygiene: after 3–4 enriched sends, query the `memories` table and confirm no row's `content` contains the substring `<memory-context>` (stored chunks should be original content only).
6. Resilience: temporarily break the embedder path (rename model dir), send message with flag ON, confirm message still reaches Claude (enrichment null, forwarded as-is), no bridge disruption.

## Implementation delta estimate

- Delete: ~15 lines (main.js:2932–2946)
- Add: ~25 lines (main.js, before line 2135, enrichment + optional timeout wrapper)
- Net: ~10 new lines of code, one commit.

## Not in scope

- Renaming `buildContextForSpawn` → `buildMemoryContext`.
- Moving DB to a worker process.
- Per-channel query scoping (we still query globally per v1 plan).
- Memory management UI (view/delete/search).
- Adjusting chunker / embedding model / search weights.
