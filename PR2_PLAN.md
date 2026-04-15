# PR2 — Self-Heal (Wedge Detection, Kill, Respawn, Replay)

**Status:** Revised after Codex design review (round 1)
**Branch:** `supervisor-pr2-self-heal`
**Base:** `supervisor-pr1-observe-only` (merged)
**Worktree:** `~/Documents/Dev/55-Root_Operator.wt/supervisor-pr2`
**Design doc:** `~/.root-operator/workspace/design/claude-session-supervisor-v4.md`

## Scope (one sentence, narrowed)

**Scheduler-first** self-heal: when a scheduler-source dispatch is active and Claude wedges or crashes, supervisor kills Claude (if still alive), the existing respawn path brings a fresh Claude back, supervisor replays the SAME dispatch (incrementing `replay_count`) exactly once, and if recovery itself fails a `[system notice]` lands on the originating chat_id.

Channel/user message recovery stays outside PR2 (PR1 already documented as a known gap in `orchestrator.js:14-22`; full coverage requires routing channel traffic through the supervisor, which is PR3 scope).

## Why narrower than first draft

The first draft implicitly promised channel-source replay. Codex flagged this as inconsistent with current code: `submitChannelUserMessage` still sends directly to `channelManager.sendToChannel`, bypassing the supervisor. PR2 can safely replay only the traffic the supervisor owns — which today is scheduler-only. Rebuilding channel routing is PR3.

## Design changes forced by Codex review

### Blocker 1 — Replay is "same dispatch," not "new dispatch"

**Problem:** Original plan said "re-enqueue." But `enqueue()` mints a new `dispatchId`, and the scheduler is still awaiting the original via `awaitOutcome(dispatchId)`. A new row would sit queued behind the wedged one and the scheduler's awaiter would never resolve.

**Fix:** Add `orchestrator._retryActiveDispatch(dispatchId, reason)`:
- Check `canReplayDispatch(row)` (DB row, not the activeDispatch struct)
- If blocked → `_completeDispatch(dispatchId, FAILED, reason)` → emit system notice
- If allowed:
  1. Increment `replay_count` in DB via new `store.incrementReplayCount(dispatchId)`
  2. Reset dispatch state back to `QUEUED` in DB (keeps same row, new attempt)
  3. Record `dispatch_replay_started` incident
  4. Set `activeDispatch = null`
  5. Call `_activateNext()` which now finds the same dispatch queued and re-sends its payload
- `awaitOutcome` promise is NOT resolved — it stays pending for the replay attempt's outcome

This means the scheduler sees one terminal outcome, not two. The dispatch's full lifecycle (including replays) is recorded in incidents and `replay_count`.

### Blocker 2 — Real bridge-ready handshake, not socket-connected

**Problem:** `channelManager.connected` flips to `true` the moment the Unix socket connects, which is BEFORE `channel-bridge.cjs` finishes `await mcp.connect()`. Replaying on `connected` races a half-ready bridge.

**Fix:** Wire an explicit "bridge ready" signal:

1. **In `channel-bridge.cjs`**, after line 344 (`await mcp.connect(transport)`), write a JSON message to the IPC socket:
   ```js
   socket.write(JSON.stringify({ type: 'bridge_ready', pid: process.pid, ts: Date.now() }) + '\n');
   ```
2. **In `src/channel-manager.js`**, parse that message type and emit `'bridge_ready'` event (separate from `'connected'`).
3. **In supervisor:** replay gate listens for `'bridge_ready'`, not `'connected'`.

Fallback for already-connected case (fast path when no wedge happens): if `bridge_ready` arrived before supervisor start, cache the timestamp on `channelManager._lastBridgeReadyTs` and let supervisor check that on startup.

### Blocker 3 — Fence old-session hooks + FSM consistency

**Problem:** After SIGKILL the tailer is still watching the shared hook log. `_onHookEvent` completes any `activeDispatch` on Stop/StopFailure — including late events from the dying old Claude.

**Fix:** Activate PR1's dormant epoch-scoped hook logs.

1. **In `main.js.spawnClaudeCode()`**: replace the static `claude-channel-hooks.jsonl` path with `runtime.resolveEpochPaths(runtime.incrementEpoch()).hookLog`. Bump epoch on every spawn.
2. **In `main.js.prepareClaudeWorkspaceRuntime()`**: same — use epoch-scoped path from `runtime`.
3. **In supervisor**: on `spawn_initiated` event from main.js, swap the tailer from the old epoch file to the new one. Drop any pending lineBuffer.
4. **In supervisor `_onHookEvent`**: ignore events when `activeDispatch` is null (dispatch was already killed/replayed), or when `this.state === SUSPECT | RESPAWNING` (pending kill/respawn).
5. **PR1's `maintainLatestSymlinks(epoch)` is already implemented** — keeps the stable-named `claude-channel-hooks.jsonl` symlink working for external tooling.

FSM sequence (cleaned up):
```
IDLE -- enqueue --> DISPATCHING (old: idle-with-activeDispatch-null was ambiguous)
DISPATCHING -- silence_timeout | process_exit_during_active --> SUSPECT
SUSPECT -- kill_ordered --> RESPAWNING
RESPAWNING -- respawn_ok (bridge_ready) --> STARTING (or straight to dispatch_replay if replay allowed)
RESPAWNING -- intensity_exhausted --> HARD_FAILED
STARTING -- verify_skipped --> IDLE
```

### Important 1 — Process-exit during ACTIVE = immediate recovery

Silence timeout is one wedge signal; the other is Claude crashing outright. `main.js` already calls `scheduleClaudeRestart()` on process exit, but the supervisor isn't notified.

**Fix:** In `main.js.claudeProcess.on('exit')`, if supervisor is wired, call `supervisor.notifyClaudeExited(exitCode)` BEFORE the scheduled restart. Supervisor checks:
- If state is `DISPATCHING` and `activeDispatch != null` → transition `DISPATCHING → SUSPECT` immediately, then `SUSPECT → RESPAWNING` (kill already happened — process is dead), skip `kill_ordered` side effect
- If state is IDLE → no-op (normal restart after clean quit)

This means crashes trigger recovery without waiting for the 5-min silence timer.

### Important 2 — Burst + window intensity budget

**Fix:** Track two thresholds, both must be under:
- **Burst:** ≥3 kill_ordered + process_exit events in last 30 seconds → `intensity_exhausted` (fast fail — boot loops)
- **Window:** ≥3 in last 10 minutes → `intensity_exhausted` (rolling fail — distributed failures)

Both push into the same ring buffer (persisted in `supervisor_state`); check both windows on each event. Keep `scheduleClaudeRestart`'s existing logic unchanged — supervisor runs its own budget above it.

### Important 3 — Thread `chatId` through scheduler → supervisor

**Fix:** In `src/scheduler.js:333` change the enqueue call to:
```js
this.supervisor.enqueue({
    source: 'scheduler',
    sourceId: job.id,
    chatId: job.chatId || null,   // ← added
    payload,
    silenceMs: jobSilenceFor(job),
});
```

This makes hard-fail notices land on the originating chat when the scheduler job had one (many scheduler jobs are Tom-facing like Night Lab, Signal).

### Accepted risks (documented, not fixed in PR2)

1. **`canReplayDispatch` is heuristic, not atomic.** `visible_effect_count` comes from `PreToolUse(reply)` hook events. If the hook append is lost or delayed, duplicate replies are possible. Full fix requires the effect ledger (PR3-4). PR2 accepts this risk for scheduler-first because scheduler payloads are idempotent enough (Night Lab may double-build; Signal may double-scan). Worth it to ship tonight vs. delay for PR3.
2. **Fresh session replay is scheduler-scoped.** Channel/user turns rely on dynamic-memory rehydration in `submitChannelUserMessage()`; supervisor dispatches don't use that path. Fresh-session replay works for scheduler prompts (they're self-contained) but not general channel turns. Not a PR2 problem because channel replay isn't in scope.
3. **Kill during an external side effect.** If Claude is mid-HTTP-call when we SIGKILL, the remote side effect may have committed. No atomic rollback available. Same accepted-risk as PR1.

## Task breakdown (revised)

### 1. Policy FSM extensions
File: `src/claude-session-supervisor/policy.js`
- [ ] `DISPATCHING` adds transitions: `silence_timeout → SUSPECT`, `process_exit → SUSPECT`
- [ ] `SUSPECT` adds: `kill_ordered → RESPAWNING` (skip when process already dead)
- [ ] `RESPAWNING` already has `respawn_ok → STARTING`
- [ ] Pure helpers: `intensityBurst(timestamps, now)` (3-in-30s), `intensityWindow(timestamps, now)` (3-in-10min), both return boolean
- [ ] Unit tests

### 2. Dispatch store: replay + chat_id support
File: `src/claude-session-supervisor/dispatch-store.js`
- [ ] `incrementReplayCount(dispatchId)` — atomic UPDATE with returning
- [ ] `resetToQueued(dispatchId)` — clears sending_at, activated_at, terminal_at, last_error; sets state='queued'
- [ ] `persistIntensityRing(timestamps)` + `loadIntensityRing()` via supervisor_state table
- [ ] Unit tests

### 3. Epoch-scoped hook log activation
File: `main.js`
- [ ] `spawnClaudeCode()`: use `runtime.incrementEpoch()` + `runtime.ensureEpochFiles(epoch)` + `runtime.maintainLatestSymlinks(epoch)` to get a fresh hookLogPath per spawn
- [ ] `supervisor.notifyEpochBumped(newEpoch, newHookLogPath)` swaps the tailer
- [ ] Test: two consecutive spawns write to different epoch files; tailer follows

### 4. Bridge-ready handshake
Files: `channel-bridge.cjs`, `src/channel-manager.js`
- [ ] Bridge writes `{type:'bridge_ready', pid, ts}` to IPC after `mcp.connect()` resolves
- [ ] ChannelManager parses, emits `'bridge_ready'` event + caches `_lastBridgeReadyTs`
- [ ] Unit test on ChannelManager parse path

### 5. Wedge detector (silence timer)
File: `src/claude-session-supervisor/orchestrator.js`
- [ ] In `_activateNext`: arm wedgeTimer at `silenceMs` (DEFAULT_SILENCE_MS=5min) in addition to safety-net at `silenceMs*10`
- [ ] In `_onHookEvent`: reset wedgeTimer on progress
- [ ] On fire → `_handleWedge(dispatchId, 'silence_timeout')`
- [ ] `_handleWedge`: record `wedge_detected`, transition `DISPATCHING → SUSPECT`, call `runtime.requestKill()` if process alive

### 6. Runtime: kill + exit hooks
File: `src/claude-session-supervisor/runtime.js`
- [ ] Constructor adds DI slots: `onKillRequest`, `onEpochSwap`
- [ ] `runtime.requestKill()` calls `onKillRequest()`
- [ ] Main.js wires `onKillRequest: () => killClaudeCode()`

### 7. Process-exit notification path
File: `main.js` + orchestrator
- [ ] `claudeProcess.on('exit')` calls `supervisor.notifyClaudeExited(exitCode)` if supervisor exists
- [ ] Orchestrator handles: if ACTIVE dispatch + state=DISPATCHING → SUSPECT → RESPAWNING (process already dead, skip kill)

### 8. Respawn + replay coordination
File: `src/claude-session-supervisor/orchestrator.js`
- [ ] Subscribe to `channelManager.on('bridge_ready')`
- [ ] On `bridge_ready` when state=RESPAWNING: check intensity budget (burst + window both under)
- [ ] If budget ok: `_retryActiveDispatch(dispatchId, 'respawn_replay')` (see blocker 1 fix)
- [ ] If budget blown: transition → HARD_FAILED, `_completeDispatch(dispatchId, FAILED, 'intensity_exhausted')`, emit system notice

### 9. System notice emission
File: `src/claude-session-supervisor/orchestrator.js`
- [ ] `_emitSystemNotice(dispatchId, reason)`:
  - If `row.chat_id`: `channelManager.sendToChannelUnbuffered(row.chat_id, '[system notice] Scheduler job failed: ' + reason, row.chat_id)`
  - If no chat_id (scheduler jobs without one): log-only, no channel emit
- [ ] Triggered on: `hard_failed`, `replay_cap_exceeded`, `replay_not_allowed`
- [ ] Record `system_notice_emitted` incident

### 10. End-to-end smoke test
File: new test script (can be a CLI helper, not unit-test, since it needs real dev-app)
- [ ] Schedule a job whose prompt is `Sleep 600 seconds then reply "done"` (or: tool call that hangs)
- [ ] Set wedge threshold to 15s for the test
- [ ] Fire via `ro_run_now`
- [ ] Assert: within 20s → `wedge_detected`, `kill_ordered`, Claude exits, new Claude spawns, `bridge_ready`, `dispatch_replay_started` for same dispatchId
- [ ] Overnight smoke: leave running on a real scheduler job; Tom reports if anything recovers or fails visibly

### 11. Codex code review (max 1 round, round 2 reserved)
- [ ] Send diff for review
- [ ] Fix blockers
- [ ] Ship unless round 2 surfaces a data-loss-class finding

### 12. Hand off
- [ ] Commit, push branch
- [ ] Tom checks out + restarts dev app
- [ ] Overnight run

## Time box (unchanged)

12h hard cap. The revisions add real work (bridge-ready handshake, epoch activation, same-dispatch replay semantics, process-exit path) but keep scope narrower (no channel replay). Net: similar budget, different distribution.

## Success criteria (revised)

1. A scheduler-source dispatch whose Claude wedges is killed within `silenceMs` of last progress
2. A scheduler-source dispatch whose Claude crashes triggers immediate recovery (not silence-timeout)
3. The same dispatchId goes through one replay; scheduler sees one terminal outcome
4. Replay gate waits for real `bridge_ready` (post-MCP-connect), not just socket-connected
5. Old-session Stop hooks after kill do NOT spuriously complete the replay
6. Intensity budget trips at either burst (3-in-30s) OR window (3-in-10min)
7. On hard-fail, a `[system notice]` lands on the originating chat_id if present
8. Overnight: scheduler jobs either complete normally, self-heal once, or visibly report failure — no silent loss

## What PR2 does NOT accomplish

- No channel/user message replay (requires routing change, PR3)
- No `_ping` liveness probe (PR3)
- No effect ledger for atomic duplicate protection (PR3-4)
- No bridge-offline UI pill on device
- No Electron/tunnel-level watchdog
