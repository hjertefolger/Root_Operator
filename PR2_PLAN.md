# PR2 — Self-Heal (Wedge Detection, Kill, Respawn, Replay)

**Status:** Draft (pre-Codex review)
**Branch:** `supervisor-pr2-self-heal`
**Base:** `supervisor-pr1-observe-only` (already merged into branch)
**Worktree:** `~/Documents/Dev/55-Root_Operator.wt/supervisor-pr2`
**Design doc:** `~/.root-operator/workspace/design/claude-session-supervisor-v4.md`

## Scope (one sentence)

Make Claude wedging overnight a recoverable event: supervisor detects silence → kills wedged Claude → existing respawn path brings a fresh Claude back → supervisor replays the in-flight prompt → user wakes up to a reply, not silence. If recovery itself fails, user sees a visible `[system notice]` instead of silence.

## Why this is cheap vs. PR1

PR1 landed the observation half: dispatch-store, FSM vocabulary, epoch handling, `replayCapForSource`, `canReplayDispatch`, safety-net timer (`silenceMs * 10`). PR2 wires the action half — but **main.js already has `spawnClaudeCode()`, `killClaudeCode()`, and auto-restart on `claudeProcess.on('exit')` via `scheduleClaudeRestart()`**. We are NOT building spawn/kill. We are building:

1. A stricter silence-timer (at `silenceMs`, not `silenceMs * 10`)
2. A wire from supervisor → `killClaudeCode()` so the existing exit→respawn path fires
3. A hook to detect the new bridge is up and replay the in-flight dispatch
4. Intensity budget so respawn storms can't loop forever
5. A user-facing failure notice when (4) trips or replay cap is hit

## Scope boundary

**In scope (PR2):**
- Wedge detection (silence timeout distinct from safety-net)
- Kill wedged Claude (trigger existing `killClaudeCode()`)
- Respawn is **already handled by the existing exit-handler** — PR2 just verifies the handoff works cleanly (new epoch, new bridge, new hook log)
- Replay in-flight dispatch through `enqueue` with `replay_count++`
- Intensity budget (e.g., 3 respawns per 10 min → `hardFailed`)
- User-visible system notice on `hardFailed` or `replay_cap_exceeded`
- End-to-end smoke test (wedge simulation)
- FSM extensions (`DISPATCHING → SUSPECT → RESPAWNING → STARTING`) — vocabulary exists in `policy.js`, just wire

**Not in scope (deferred):**
- `_ping` tool for active liveness probes → PR3
- Effect ledger / duplicate-reply protection → PR3-4 (column `external_ref` already reserved)
- ChannelManager pending-buffer removal → PR3
- Bridge-offline UI pill on the device → cosmetic, separate work
- App-level / Electron-outside watchdog (cloudflared, tunnel restart) → explicit out-of-scope, separate product layer
- `--resume <sessionId>` resume-vs-fresh: **default to fresh session**, add resume later if needed. Reasoning: fresh + memory-context rehydration already works (Cortex is live); `--resume` adds edge-case failure modes we don't need for v1.

## Task breakdown

### 1. Policy: extend FSM transitions for PR2

File: `src/claude-session-supervisor/policy.js`

- [ ] In `transitionSupervisor`: add `case DISPATCHING: if (event === 'silence_timeout') return { ok: true, next: SUSPECT }`
- [ ] Add `case SUSPECT: if (event === 'kill_ordered') return { ok: true, next: RESPAWNING }`
- [ ] Add `case RESPAWNING: respawn_ok → STARTING` (already exists)
- [ ] Add tracker: `intensityBudget(respawnTimestamps, windowMs=600000, max=3)` → boolean. Pure function.
- [ ] Unit tests for all new transitions + intensity budget

### 2. Wedge detection timer

File: `src/claude-session-supervisor/orchestrator.js`

- [ ] In `_activateNext()`: arm a **wedge timer** at `silenceMs` (configurable; default 5 min for scheduler, tighter for channel) IN ADDITION to the existing safety-net timer at `silenceMs * 10`
- [ ] In `_onHookEvent()`: reset the wedge timer on every hook event (progress signal)
- [ ] Wedge timer fires → call `_handleWedge(dispatchId, reason='silence_timeout')`
- [ ] `_handleWedge`:
  1. Record `wedge_detected` incident (kind: `wedge_detected`, state_from: `active`, dispatchId, details: reason + lastProgressAt)
  2. Transition supervisor FSM: `DISPATCHING → SUSPECT`
  3. Call `runtime.killClaudeAndRespawn(dispatchId)` (new method — see task 3)

### 3. Runtime: bridge from supervisor to main.js spawn/kill

File: `src/claude-session-supervisor/runtime.js`

- [ ] Add dependency injection slot: `onKillRequest: () => void` (injected from main.js, wraps `killClaudeCode()`)
- [ ] Add `runtime.requestKill()` → calls injected callback
- [ ] Main.js wires `onKillRequest: () => killClaudeCode()` when constructing the runtime

Rationale: runtime module stays DI-pure (no direct import of main.js). The callback is the integration seam.

### 4. Respawn detection + replay

File: `src/claude-session-supervisor/orchestrator.js`

The existing `claudeProcess.on('exit')` handler in main.js already calls `scheduleClaudeRestart` which eventually calls `spawnClaudeCode()` again. When the new Claude boots, it writes to a new epoch's hook log and reconnects the MCP bridge.

Supervisor needs to observe this and replay.

- [ ] Add `runtime.onBridgeReconnected(callback)` hook. Main.js calls this when `channelManager.connected` flips false→true after a kill.
- [ ] In `orchestrator`: listen for bridge reconnect. If there's an in-flight dispatch in `SUSPECT` state:
  1. Check `canReplayDispatch(row)` — if false, mark dispatch `failed` with `last_error='replay_not_allowed:<reason>'` and emit system notice
  2. If allowed: increment `replay_count` in DB, re-enqueue via `enqueue({ ...row, replay: true })`
  3. Record `dispatch_replayed` incident
- [ ] Bump epoch + swap tailer to new epoch hook log on reconnect

### 5. Intensity budget

File: `src/claude-session-supervisor/orchestrator.js`

- [ ] In-memory ring buffer of respawn timestamps (last 10 min)
- [ ] On every `kill_ordered` event: push timestamp, then check `intensityBudget(timestamps)` — if exhausted, transition `SUSPECT → HARD_FAILED` (skip respawn), record `intensity_exhausted` incident, emit system notice
- [ ] Persist ring buffer to `supervisor_state` table so it survives restart

### 6. System notice emission

File: `src/claude-session-supervisor/orchestrator.js`

- [ ] New helper `_emitSystemNotice(dispatchId, reason)`:
  - For scheduler-source dispatches: no-op (no chat to notify)
  - For channel-source dispatches: `channelManager.sendToChannel(chatId, '[system notice] Message could not be delivered. Reason: <reason>.', chatId)` — use unbuffered variant
- [ ] Triggered on: `hard_failed`, `replay_cap_exceeded`, `replay_not_allowed`
- [ ] Record `system_notice_emitted` incident

### 7. Main.js wiring

File: `main.js`

- [ ] Wire `onKillRequest: () => killClaudeCode()` into supervisor construction
- [ ] After `spawnClaudeCode()` completes + bridge reconnects: call `supervisor.notifyBridgeReconnected(newEpoch)`
- [ ] No changes to the spawn path itself — the existing flow is reused

### 8. End-to-end smoke test

File: new `test/integration-wedge-recovery.test.js` (or manual script if test harness too heavy)

- [ ] Deliberately-wedging prompt: fire a scheduled dispatch whose payload instructs Claude to call a tool that never returns (or sleep forever)
- [ ] Wait for silence timer to fire (short `silenceMs` in test config, e.g., 10s)
- [ ] Assert: `wedge_detected` incident logged
- [ ] Assert: Claude process was killed (check PID no longer alive)
- [ ] Assert: new epoch created
- [ ] Assert: dispatch row shows `replay_count=1`
- [ ] Assert: new dispatch activated under new epoch
- [ ] (If replay dispatch completes successfully) assert reply received
- [ ] (If intensity budget blown in loop) assert `hard_failed` + system notice

### 9. Codex code review

- [ ] Send diff + this plan to Codex. Max 2 rounds.
- [ ] Round 1: correctness, race conditions (kill vs. concurrent hook event, reconnect-before-ready), replay correctness, resource leaks (timer cleanup)
- [ ] Round 2: one production scenario I missed (budget for this explicitly — prior PR1 pattern was round 5 found backup edge case)
- [ ] After round 2: ship. No round 3 regardless of findings unless findings are data-loss class.

### 10. Hand off

- [ ] Commit + push branch
- [ ] Ping Tom: branch ready, summary of what's in + what's deferred
- [ ] Tom runs `git checkout supervisor-pr2-self-heal` in his live tree and restarts the dev app
- [ ] Overnight smoke: Tom leaves it running; if Claude wedges naturally, system should self-heal

## Risk register (PR2 specific)

1. **MCP bridge reconnect race** — new Claude spawns but MCP bridge takes a few seconds to reconnect. Replay before reconnect = message lost. **Mitigation:** wait for `channelManager.connected === true` before replaying.

2. **Double-reply on wedge-but-not-actually-wedged** — Claude is slow but would eventually reply. We kill, respawn, replay, and now BOTH instances emit reply → duplicate. **Mitigation:** (a) wedge threshold is generous (5min default), (b) `canReplayDispatch` already blocks replay when `visible_effect_count > 0`. Only scheduler jobs (no visible effects yet) get replayed in practice.

3. **Kill signal during a tool call** — SIGKILL mid-tool means the tool's external side effect may or may not have committed. Cannot atomic-rollback. **Mitigation:** for v1, accept the edge case. `external_ref` column (PR1) is prep for the effect-ledger fix in PR3 — not PR2's problem.

4. **Intensity storm** — if Claude wedges instantly on every respawn, we'd burn the budget in seconds and go hard-failed, blocking all scheduler jobs. **Mitigation:** budget 3 per 10 min (configurable). `hard_failed` requires `manual_reset` event, which main.js can expose as a "restart supervisor" button later (out of scope for PR2 — hard failure in v1 means Tom restarts the app).

5. **Supervisor state divergence from Claude reality** — what if main.js calls `killClaudeCode()` but Claude ignores SIGKILL (stuck in kernel call)? **Mitigation:** main.js `claudeProcess.on('exit')` must fire for the respawn path to trigger. If it doesn't fire within N seconds, escalate to SIGKILL again, then give up → hard-failed. (Add a `kill_timeout` timer.)

## Time box

**Hard cap: 12 hours.** If hour 10 shows a deep surprise (bridge reconnect races, SIGKILL behaviour weirdness), ship a minimum-viable version:
- Wedge detection + kill: yes
- Respawn + replay: yes (fresh session only, no `--resume`)
- Intensity budget: yes
- System notice: yes
- Duplicate-reply protection: defer to PR3 (document risk in PR description)

If it looks like PR2 won't ship in 12h, stop and tell Tom. Don't burn another day.

## Codex round cap

**Max 2 rounds.** PR1 chewed 3 extra rounds optimizing the least-impactful layer (DB hardening). PR2 is user-visible recovery — ship after round 2 unless a data-loss bug surfaces.

## Success criteria

1. A deliberately-wedged Claude is killed and respawned within ~5 minutes of last progress
2. The in-flight scheduler dispatch is replayed once on the new Claude and completes normally
3. If the replay itself wedges, replay cap stops further retries and a system notice is visible on Tom's device
4. Overnight: Claude never silently leaves a scheduled job hanging without either (a) completing, (b) retrying once, or (c) visibly reporting failure

## What PR2 does NOT accomplish

- No live `_ping` liveness probe (PR3)
- No duplicate-reply protection via effect ledger (PR3-4) — relies on `visible_effect_count` guard which covers scheduler but not channel replays
- No bridge-offline UI pill on the device
- No Electron/tunnel-level watchdog
- No protection against Claude Code (CLI tool itself) crashing during startup — that's main.js's existing retry loop's problem
