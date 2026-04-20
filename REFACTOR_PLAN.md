# Root Operator — Scheduler + Supervisor Strip + main.js Split

**Branch:** `refactor/scheduler-strip`
**Worktree:** `~/Documents/Dev/55-Root_Operator.wt/scheduler-strip`
**Target executor:** Codex

---

## 1. Context

Root Operator runs exactly ONE Claude CLI (April 4 2026 Anthropic enforcement forbids programmatic `claude -p` spawns). The current scheduler + supervisor were designed as if we could manage a fleet of processes: dispatch state machine (queued → sending → active → completed/failed/abandoned), silence/wedge detection with exponential backoff, kill-and-replay with cap, intensity ring for respawn budget, effect ledger.

All of that is machinery to CONTROL isolated workers we don't have. With a single-process model the correct primitive is: **cron fires → post a channel message → Claude drains the channel in order**. The channel queue IS the job queue. No state machine, no replay, no wedge detection.

Yesterday's hardening (exponential silence 30→60→120 min, replay_cap 2→4, stuck_run_ms bumped to 15.5 h, scheduler supervisor-aware liveness) compounded the wrong abstraction: a single wedged Night Lab now starves the entire serial queue for 3+ hours, producing four orphan half-builds while Signal + Sleep Cycle wait behind it and get abandoned on shutdown. The fixes made the wrong abstraction harder to escape.

This refactor removes the wrong abstraction.

---

## 2. Goals

1. **Delete** `src/scheduler.js` (665 lines) and replace with a minimal cron→channel-message injector (~120 lines).
2. **Shrink** `src/claude-session-supervisor/` to a thin "is Claude alive?" probe + boot orphan cleanup + epoch mgmt. Remove all dispatch-state machinery.
3. **Split** `main.js` (6231 lines) into a small entry point + focused modules under `src/main/`.
4. Keep the app functionally equivalent for the user: scheduled jobs still fire, Claude still spawns, pairing/tunnel/notifications still work.

---

## 3. Non-goals

- No new features.
- No UI changes to scheduled-jobs CRUD (IPC surface stays the same).
- No change to pairing / tunnel / notifications / crypto logic (moved, not rewritten).
- No new storage backend. electron-store + existing SQLite schema stay; SQLite tables can be pruned but not replaced.
- No resumable / checkpointed jobs. Non-idempotent jobs (Night Lab, creative builds) become the caller's problem: one shot per scheduled fire, no retry.

---

## 4. Target architecture

### Before (what we have today)

```
cron → Scheduler._fireJob
         ├── runningAt lock check (wall-clock + supervisor.listOpenDispatches)
         ├── consecutive-errors backoff gate
         ├── Supervisor.enqueue  ─→  queue ─→ dispatching state
         │                                      ├── silence timer + wedge detection
         │                                      ├── hook-log progress tailing
         │                                      ├── kill on silence → respawn → replay-with-fresh-prompt
         │                                      └── replay_cap (4) → hard_fail
         └── await outcome ─→ mark lastRun/lastResult/consecutiveErrors
```

### After (what we're building)

```
cron → ScheduledJobs._fire(job)
         └── channelManager.sendToChannel(chatId, `[Scheduled: ${job.name}]\n\n${job.prompt}`, userId)
              └── record { jobId, firedAt, bridgeReady: bool } in observability log
```

Supervisor shrinks to:
- `start()` / `shutdown()` / `getStatus()` → `{ isAlive, epoch, orphanUnsafe }`
- Boot orphan-kill + pidfile tracking (unchanged)
- Epoch-scoped log path resolution (unchanged)
- **Removed:** enqueue, awaitOutcome, dispatching/suspect/respawning states, wedge/silence timers, hook-log progress tailing for dispatch state, replay logic, intensity ring, effect ledger.

If Claude is busy / hung when a cron fires:
- `channelManager.sendToChannel` buffers up to 100 messages on disconnect and flushes on reconnect. Cron firings queue naturally.
- If Claude is alive but mid-tool-call, the message sits in the channel and Claude picks it up when its current turn finishes.
- If Claude is hard-wedged, the message sits in the channel until user restarts. No attempt to recover automatically.

---

## 5. What gets DELETED

### Files (full deletion)

- `src/scheduler.js`
- `src/claude-session-supervisor/orchestrator.js`
- `src/claude-session-supervisor/orchestrator.test.js`
- `src/claude-session-supervisor/pr3-effect-ledger.test.js`
- `src/claude-session-supervisor/channel-manager-integration.test.js`
- `src/claude-session-supervisor/scheduler-integration.test.js`

### Code removed from within retained files

**`src/claude-session-supervisor/policy.js`** — remove:
- `DISPATCH_STATES`, `TERMINAL_DISPATCH_STATES`, `transitionDispatch`
- `replayCapForSource`, `canReplayDispatch`, `effectiveSilenceMs`
- `intensityExhausted`
- `SAFETY_NET_MULTIPLIER`, `DEFAULT_SILENCE_MS`
- From `STATES`: keep only `STOPPED, STARTING, VERIFYING, IDLE, HARD_FAILED`. Remove `DISPATCHING, SUSPECT, PROBING, RESPAWNING`.
- `transitionSupervisor` table reduced accordingly.

**`src/claude-session-supervisor/runtime.js`** — retain core (epoch, paths, pidfile, orphan probe), but:
- Remove `onKillRequest` concept — supervisor no longer kills the active Claude mid-flight. On boot, if an orphan is found, we kill it (that's fine). During normal operation, no kills.
- `bootCleanup` stays.
- `findAndKillOrphans` becomes boot-only, not runtime-callable.

**`src/claude-session-supervisor/incidents.js`** — retain, but prune event kinds:
- KEEP: `supervisor_started`, `boot_cleanup`, `boot_cleanup_kill_failed`, `supervisor_hard_failed_orphan_unsafe`, `orphan_unsafe_latch_carried_forward`, `orphan_unsafe_latch_cleared`, `process_exit`
- DELETE: `dispatch_enqueued`, `dispatch_activated`, `dispatch_completed`, `dispatch_abandoned`, `wedge_detected`, `silence_timeout`, `kill_ordered`, `dispatch_replay_started`, `verify_ok`, `verify_probe_failed`, `supervisor_await_*`, any dispatch-lifecycle kind.

**`src/claude-session-supervisor/dispatch-store.js`** — simplify schema:
- KEEP table: `incidents` (id, epoch, kind, details_json, occurred_at) — minus `state_from/state_to/dispatch_id` columns since they're no longer used
- KEEP table: `supervisor_state` (key, value)
- DELETE tables: `dispatches`, `effects`
- Write a schema migration that drops them (or marks unused). File itself rename to something like `supervisor-store.js` since "dispatch" is now gone, or leave the filename and note the vestigial name.

**`src/claude-session-supervisor/index.js`** — public API reduced to:
```js
module.exports = {
  SupervisorStore,     // renamed from DispatchStore
  Runtime,
  IncidentLogger,
  ClaudeSessionSupervisor,
  createSupervisor,
  STATES,              // only 5 values
  transitionSupervisor,
  HOOK_BASENAME, DEBUG_BASENAME, MAX_EPOCHS_KEPT,
}
```

### electron-store keys / persisted fields removed

From each scheduled job record, remove runtime fields:
- `runningAt`, `consecutiveErrors`, `lastError`, `lastDurationMs`

Keep: `id, name, cron, prompt, chatId, enabled, lastFiredAt` (renamed from `lastRun`).

Write one migration step on first boot after this refactor: for each job, strip removed fields. Don't delete user-authored fields (name, cron, prompt).

---

## 6. What REPLACES the scheduler

**New file: `src/scheduled-jobs.js` (~120 lines)**

```js
const cron = require('node-cron');
const crypto = require('crypto');
const EventEmitter = require('events');

const MAX_JOBS = 50;
const MAX_PROMPT_SIZE = 50_000;
const MIN_REFIRE_GAP_MS = 5_000;

class ScheduledJobs extends EventEmitter {
  constructor(store, channelManager) {
    super();
    this.store = store;
    this.channelManager = channelManager;
    this.timers = new Map();     // jobId → cron task
    this._lastFire = new Map();  // jobId → ts (refire gap)
  }

  start() { /* load jobs, register timers */ }
  stopAll() { /* cancel all cron tasks */ }

  addJob({ name, cronExpr, prompt, chatId }) { /* validate + persist + register timer */ }
  removeJob(id) { /* unregister + delete */ }
  toggleJob(id, enabled) { /* (un)register timer, persist */ }
  listJobs() { /* return sanitized list */ }

  async runNow(id) {
    const job = this._getJobs().find(j => j.id === id);
    if (!job) throw new Error('job not found');
    this._fire(job);
  }

  _fire(job) {
    const now = Date.now();
    const last = this._lastFire.get(job.id) || 0;
    if (now - last < MIN_REFIRE_GAP_MS) return;
    this._lastFire.set(job.id, now);

    const payload = `[Scheduled: ${job.name}]\n\n${job.prompt}`;
    const chatId = job.chatId || '__scheduler__';
    const userId = '__scheduler__';

    const ok = this.channelManager.sendToChannel(chatId, payload, userId);
    this._updateJobField(job.id, { lastFiredAt: new Date().toISOString() });
    this.emit('job', { action: 'fired', jobId: job.id, name: job.name, bridgeReady: ok, ts: new Date().toISOString() });
  }

  // ... _getJobs / _saveJobs / _updateJobField / _startTimer / _stopTimer helpers
}

module.exports = { ScheduledJobs };
```

**What's gone vs. `Scheduler`:**
- No `supervisor` param.
- No `runningAt` / stuck-run detection — `sendToChannel` is synchronous (writes to socket or buffers).
- No `consecutiveErrors` / backoff — if a job fires into a dead Claude, the message queues. Next scheduled fire does the same. If Claude never recovers, user notices.
- No `awaitOutcome` — we don't observe Claude's reply; the reply goes through the normal channel read path and the user sees it like any other Claude message.
- No `_completeJob` with error classification.

`channelManager.sendToChannel` returns `false` only if the pending-messages buffer (max 100) overflows. That's the only "dropped" case, and it's the channel layer's concern, not ours.

**Observability:** each fire emits a `job` event + writes `lastFiredAt`. The main process can log to `runtime/scheduled-jobs.jsonl` if Tom wants a history trail. Not required for v1.

---

## 7. main.js split

Target: `main.js` from 6231 lines → ~500 lines of entry-point wiring.

Create `src/main/` directory with modules below. Each exports an `init(deps)` function; `main.js` wires them together in `app.whenReady()`.

| Module | Source lines | Role |
|--------|--------------|------|
| `src/main/crypto-pairing.js` | 100–810 | E2E handshake, JWK, worker keys, RSA/ECDH |
| `src/main/tunnel.js` | 853–1044 | Cloudflare tunnel setup, subdomain mgmt |
| `src/main/window-manager.js` | 1045–1325 | BrowserWindow lifecycle, viewer windows, dock icon |
| `src/main/notifications.js` | 1370–1818 | VAPID keys, web-push, desktop notifications |
| `src/main/tray.js` | 1826–2000 | Tray icon + menu |
| `src/main/activity-tracker.js` | 2022–2200 | Hook/debug watchers, activity formatting |
| `src/main/local-chat.js` | 2242–2500 | Local chat window + attachments |
| `src/main/claude-lifecycle.js` | 3153–3500 | PTY spawn/kill, exit handler, hook/debug polling |
| `src/main/channel-mode.js` | 3500–4025 | Wires supervisor + ScheduledJobs + channelManager, teardown |
| `src/main/ipc-handlers.js` | 4220–4600 | All `ipcMain.handle` registrations |
| `src/main/websocket-server.js` | 5000–5700+ | Pairing handshake, device auth, notification endpoints |
| `src/main/logging.js` | 4585–4700 | Debug log rotation, file size limits |

After extraction, `main.js` holds only:
- `require` statements (for the new modules)
- Global singletons (store, dynamicMemory, channelManager, supervisor, scheduledJobs)
- `app.whenReady()` wiring: call `init(deps)` on each module in the right order
- `app.on('before-quit')` / `will-quit` teardown coordination
- Platform-specific glue (single-instance lock, `app.setName`, default protocol)

---

## 8. Execution sequence

**Phase 0 — baseline.** Confirm current test suite passes on `refactor/scheduler-strip` branch at HEAD (aa1b96a + this plan). Note any pre-existing failures so we can tell what's new.

**Phase 1 — supervisor shrink.**
1. Rename `DispatchStore` → `SupervisorStore`, drop `dispatches` + `effects` tables, prune `incidents` columns. Migration on open.
2. Delete `orchestrator.js`. Delete `orchestrator.test.js`, `pr3-effect-ledger.test.js`, `channel-manager-integration.test.js`.
3. Prune `policy.js`: remove dispatch FSM, replay helpers, intensity helpers, shrink STATES.
4. Prune `runtime.js`: drop `onKillRequest`, make `findAndKillOrphans` boot-only.
5. Prune `incidents.js` event-kind set.
6. New orchestrator.js-free `ClaudeSessionSupervisor` class (thin wrapper): `start/shutdown/getStatus` only. No `enqueue/awaitOutcome`.
7. Update `index.js` exports.
8. Commit: `Supervisor: strip dispatch state machine; reduce to alive-probe + orphan cleanup`

**Phase 2 — scheduler replacement.**
1. Add `src/scheduled-jobs.js` per spec in §6.
2. Update `main.js` `initChannelMode()` (lines ~3500–3890): replace `new Scheduler(store, channelManager, supervisor)` with `new ScheduledJobs(store, channelManager)`. Remove supervisor injection.
3. Update scheduler IPC handlers (lines ~3885–3975): `ro_add_schedule`, `ro_list_schedules`, `ro_delete_schedule`, `ro_toggle_schedule`, `ro_run_now` — point at `scheduledJobs` instead of `scheduler`. MCP-tool-visible names stay identical.
4. One-shot migration on first boot: iterate `store.get('scheduler-jobs', [])`, strip `runningAt, consecutiveErrors, lastError, lastDurationMs`; rename `lastRun`→`lastFiredAt`.
5. Delete `src/scheduler.js` and `scheduler-integration.test.js`.
6. Commit: `Scheduler: replace Scheduler with ScheduledJobs (cron→channel, no state machine)`

**Phase 3 — tests.**
1. Reduce `policy.test.js` to supervisor FSM tests only.
2. Reduce `incidents.test.js` to retained event kinds.
3. Reduce or delete `runtime.test.js` (keep epoch/pidfile tests, drop kill tests).
4. Adjust `dispatch-store.test.js` to match simplified schema (rename file to `supervisor-store.test.js`).
5. Add `scheduled-jobs.test.js` covering: CRUD, cron parsing, runNow fires `sendToChannel`, refire-gap protection, `lastFiredAt` updates.
6. Run full suite. Fix regressions.
7. Commit: `Tests: prune dispatch FSM tests; add ScheduledJobs tests`

**Phase 4 — main.js split.** One module per commit. For each of the 12 modules in §7:
1. Create `src/main/<module>.js` with the extracted code.
2. Define `init(deps)` signature.
3. Replace in-place code in `main.js` with `require` + `init(deps)` call.
4. Smoke: launch app, exercise the feature belonging to that module (e.g. for tunnel — enter channel mode and verify tunnel comes up; for notifications — send a test notification).
5. Commit: `main.js: extract <module>`

Order (low-risk → high-risk, so if we have to stop midway, the critical paths are last):
1. `logging` (easy, isolated)
2. `tray`
3. `window-manager`
4. `crypto-pairing` (large, mostly pure)
5. `tunnel`
6. `notifications`
7. `websocket-server`
8. `activity-tracker`
9. `local-chat`
10. `ipc-handlers`
11. `claude-lifecycle`
12. `channel-mode` (touches supervisor + scheduledJobs — do last)

**Phase 5 — verification (acceptance criteria in §10).**

---

## 9. Tests — deletion / reduction summary

| Test file | Fate |
|-----------|------|
| `orchestrator.test.js` | DELETE |
| `pr3-effect-ledger.test.js` | DELETE |
| `channel-manager-integration.test.js` | DELETE |
| `scheduler-integration.test.js` | DELETE |
| `policy.test.js` | REDUCE — keep supervisor FSM only |
| `incidents.test.js` | REDUCE — retained event kinds only |
| `runtime.test.js` | REDUCE — epoch + pidfile only |
| `dispatch-store.test.js` | RENAME → `supervisor-store.test.js`; simplify schema tests |
| `schema-migration.test.js` | UPDATE — new migration drops dispatch/effect tables |
| `scheduled-jobs.test.js` | NEW |

---

## 10. Acceptance criteria

1. Full test suite passes on `refactor/scheduler-strip` (minus explicitly deleted tests).
2. App launches clean in channel mode. Claude spawns. Bridge connects. Tunnel comes up.
3. Scheduled-job `runNow` via MCP tool delivers the prompt into Claude's channel immediately; Claude responds; `lastFiredAt` updates.
4. `supervisor.getStatus()` returns exactly `{ state, epoch, orphanUnsafe }` — no dispatch/queue/activeDispatch fields.
5. `runtime/supervisor-incidents.jsonl` shows zero dispatch-lifecycle events during a run (no `dispatch_enqueued`, `_activated`, `_completed`, `wedge_detected`, `silence_timeout`, `kill_ordered`, `dispatch_replay_started`).
6. **Overnight smoke:** schedule three jobs 30 min apart, one intentionally heavy (research + multi-step). Expected: all three messages appear in the channel as scheduled; Claude processes them in order when free; if one wedges, the others queue behind it in the channel (NOT in a supervisor queue), and whenever Claude recovers the queued ones drain. No orphan half-builds. No "shutdown_while_queued" abandonment.
7. `main.js` ≤ 700 lines. `src/main/` has ≤ 12 module files, each < 800 lines.
8. `grep -r "dispatch_" src/` returns nothing in production code (tests may still mention for migration reasons).

---

## 11. Rollback

Branch is fully isolated at `refactor/scheduler-strip` in worktree `~/Documents/Dev/55-Root_Operator.wt/scheduler-strip`. To abort:

```bash
git worktree remove ~/Documents/Dev/55-Root_Operator.wt/scheduler-strip
git branch -D refactor/scheduler-strip
```

Master is never touched until we explicitly merge.

Intermediate rollback: each phase is its own commit. `git reset --hard HEAD~N` to back out N phases.

---

## 12. Open questions — decide before Codex starts

1. **Scheduled-jobs feature: keep or delete entirely?** Plan assumes keep-with-thin-replacement. If Tom wants to delete the feature outright (forcing users to external cron or a2n), skip Phase 2's new file and delete IPC tool handlers instead.

2. **Backward compat for scheduler-jobs persisted records:** plan proposes in-place migration on first boot (strip runtime fields). Alternative: wipe all jobs on first boot and have Tom re-create them (3 jobs — Night Lab, Signal, Sleep Cycle). Clean-slate is simpler. Migrate is user-friendly. Pick one.

3. **DispatchStore → SupervisorStore rename + table drop:** could also just delete the SQLite DB entirely and let supervisor re-create a smaller schema on first boot. Easier than writing a migration. Acceptable if we don't need historical incident data. Codex should delete DB on first boot unless Tom wants the history preserved.

4. **Codex should NOT push this branch.** Plan stays local until Tom reviews each phase's commit.

5. **Does Codex get all 5 phases in one dispatch, or one phase at a time?** Recommend phase-at-a-time: feed Phase 1 first, let Codex complete, Tom reviews, then Phase 2, etc. Prevents "Codex completed Phase 4 but broke Phase 2" kind of cascade.

---

_End of plan._
