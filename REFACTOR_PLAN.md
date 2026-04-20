# Root Operator — Restore Scheduler + Remove Supervisor + Split main.js

**Branch:** `refactor/scheduler-strip`
**Target executor:** Codex (manual dispatch, phase-at-a-time)
**Reference archive (pre-refactor state + historical scheduler):** `~/.root-operator/workspace/memory/scheduled-jobs-archive/`

---

## 0. Reference archive — what's there and when Codex should read it

Before touching any code, Codex should read `~/.root-operator/workspace/memory/scheduled-jobs-archive/README.md` to orient. The directory contains:

| File | Purpose |
|------|---------|
| `README.md` | Index + diff summary between 5598ac1 scheduler and current (aa1b96a). Read first. |
| `scheduler_5598ac1.js` | **Canonical file to restore.** Full 394-line `src/scheduler.js` as it existed at commit `5598ac1` (2026-03-22), the version that ran nightly builds 019–021 reliably. This is the target for Phase 2 — either copy this file into place or run `git show 5598ac1:src/scheduler.js > src/scheduler.js` to get the same bytes. |
| `main_wiring_5598ac1.js` | Reference-only snippet of `main.js` lines ~1645–1725 at commit 5598ac1, showing how the scheduler was wired at that time (2-arg constructor, IPC request handler). Use this to guide the Phase 2 main.js edits. |
| `all-jobs-2026-04-20.json` | Raw electron-store dump of Tom's three scheduled jobs right before this refactor (Night Lab, Signal, Sleep Cycle). Preserved so the jobs can be re-added after the refactor lands. |
| `night-lab-nightly-build.md` | Night Lab job — name, id, cron `22 3 * * *`, chatId, full 5295-char prompt. |
| `signal-nightly-scan.md` | Signal scan — name, id, cron `0 4 * * *`, full 3430-char prompt. |
| `sleep-cycle.md` | Sleep cycle — name, id, cron `0 5 * * *`, full 2824-char prompt. |

None of these files need to be added to the repository. They are reference material under `~/.root-operator/workspace/memory/` (outside the repo) and stay there.

---

## 1. Context

Root Operator runs exactly ONE Claude CLI (April 4 2026 Anthropic enforcement forbids programmatic `claude -p` spawns). The current scheduler + supervisor were designed as if we could manage a fleet of processes: dispatch state machine (queued → sending → active → completed/failed/abandoned), silence/wedge detection with exponential backoff, kill-and-replay with cap, intensity ring for respawn budget, effect ledger.

All of that is machinery to control isolated workers we don't have. With a single-process model the correct primitive is: **cron fires → post a channel message → Claude drains the channel in order**. The channel queue IS the job queue. No state machine, no replay, no wedge detection.

The scheduler at commit **`5598ac1` (2026-03-22)** — "Harden scheduler to production grade" — ran nightly builds 019 (Mar 25), 020 (Mar 26), 021 (Mar 27) reliably. It predates the `claude-session-supervisor/` folder entirely. It takes `(store, channelManager)` and calls `channelManager.sendToChannel()` to fire jobs. 394 lines. That's the target. The file is already extracted to `~/.root-operator/workspace/memory/scheduled-jobs-archive/scheduler_5598ac1.js`.

Yesterday's hardening layer (exponential silence 30→60→120 min, replay_cap 2→4, stuck_run_ms 15.5 h, supervisor-aware liveness check) compounded the wrong abstraction. A single wedged Night Lab now starves the serial queue for 3+ hours and produces four orphan half-builds while Signal + Sleep Cycle wait behind it and get abandoned on shutdown. The fixes made the wrong abstraction harder to escape.

This refactor reverts the architectural mistake.

---

## 2. Goals

1. **Restore** `src/scheduler.js` to its state at commit `5598ac1` (394 lines, 2-arg constructor, no supervisor coupling). Canonical copy: `~/.root-operator/workspace/memory/scheduled-jobs-archive/scheduler_5598ac1.js`.
2. **Delete** `src/claude-session-supervisor/` in its entirety. Extract the one piece of genuine value — boot-time orphan Claude kill — into a small standalone utility.
3. **Split** `main.js` (6231 lines) into a small entry point + focused modules under `src/main/`.
4. Keep the app functionally equivalent for the user: scheduled jobs still fire as they did at 5598ac1, Claude still spawns, pairing/tunnel/notifications still work.

---

## 3. Non-goals

- No new features.
- No UI changes to scheduled-jobs CRUD. IPC surface (`ro_schedule`, `ro_list_schedules`, `ro_delete_schedule`, `ro_toggle_schedule`, `ro_run_now`) stays identical.
- No change to pairing / tunnel / notifications / crypto logic (moved, not rewritten).
- No new storage backend. electron-store stays; SQLite DB for supervisor goes away with the supervisor.
- No resumable / checkpointed jobs. Non-idempotent jobs (Night Lab, creative builds) become the caller's problem: one shot per scheduled fire, auto-disable after 10 consecutive errors (5598ac1's existing safety).

---

## 4. Target architecture

### Before (master `aa1b96a`)

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

### After (restored 5598ac1 form)

```
cron → Scheduler._fireJob (5598ac1 form)
         ├── runningAt lock check (wall-clock 2h cutoff only)
         ├── consecutive-errors backoff gate (unchanged)
         ├── channelManager.sendToChannel(payload)
         └── mark lastRun/lastResult  (boolean return)
```

Supervisor folder is gone. A new `src/orphan-kill.js` (~80 lines) is called once on boot by `main.js` to kill any zombie Claude process from a prior session.

If Claude is busy / hung when a cron fires:
- `channelManager.sendToChannel` buffers up to 100 messages on disconnect and flushes on reconnect. Cron firings queue naturally in the channel layer.
- If Claude is alive but mid-tool-call, the message sits in the channel and Claude picks it up when its current turn finishes.
- If Claude is hard-wedged, the message sits in the channel until user restarts. No automatic recovery. No kill-and-replay.

---

## 5. What gets DELETED

### Files (full deletion)

Entire directory `src/claude-session-supervisor/`:
- `orchestrator.js` + `orchestrator.test.js`
- `policy.js` + `policy.test.js`
- `runtime.js` + `runtime.test.js` (but see §6 — orphan-kill extracted to new file first)
- `incidents.js` + `incidents.test.js`
- `dispatch-store.js` + `dispatch-store.test.js`
- `index.js`
- `pr3-effect-ledger.test.js`
- `schema-migration.test.js`
- `channel-manager-integration.test.js`
- `scheduler-integration.test.js`

### SQLite database

- The supervisor's SQLite file (`~/.root-operator/runtime/<epoch>/supervisor.db` or similar — verify path at runtime). Delete on first boot of the new version. No migration needed.
- `~/.root-operator/runtime/supervisor-incidents.jsonl` — stop writing to it. Leave existing file on disk as historical artifact. User can delete manually.

### electron-store keys / persisted fields

No keys removed from the top level. Within each `scheduler-jobs` record:
- Keep all fields present in 5598ac1 form: `id, name, cron, prompt, chatId, enabled, lastRun, lastResult, lastError, consecutiveErrors, runningAt, lastDurationMs`.
- Today's job records already have exactly these fields. No migration needed — 5598ac1 scheduler reads today's records without modification.

### main.js code removed

- Supervisor imports (lines ~45–50)
- Supervisor initialization block in `initChannelMode` (lines ~3640–3760: `supervisorStore = new ...`, `supervisorRuntime = ...`, `supervisor = createSupervisor(...)`, `supervisor.start().then(...)`)
- Supervisor teardown in `teardownChannelMode` (lines ~3979–4025)
- Any supervisor-status polling / IPC exposure
- Any UI code that displays supervisor state or dispatch state (verify in renderer and strip if present)

---

## 6. What REPLACES the supervisor's orphan-kill

The only genuinely useful piece in the supervisor today is boot-time orphan Claude cleanup: on app launch, if a stale Claude process from a prior crashed session is still running, kill it before spawning a new one. Without this, you can end up with two Claudes fighting over the same hook log.

**New file: `src/orphan-kill.js` (~80 lines, target)**

Responsibilities:
- On boot, before spawning Claude:
  - Read `~/.root-operator/runtime/supervisor.pidfile` (keep same filename for continuity with existing installs).
  - `ps -p <pid>`; if the process exists AND its command line matches a Claude signature, SIGTERM it; after 2s SIGKILL if still alive.
  - Delete the pidfile.
- Expose `recordPid(pid)` to write the new Claude's PID after spawn.
- Expose `clearPid()` to wipe on clean exit.

Public API:
```js
module.exports = {
  killOrphanClaudeIfAny,   // async, called once on boot
  recordPid,               // sync, called right after claudeProcess spawn
  clearPid,                // sync, called on clean exit
};
```

Wire into `main.js`:
- Top of `initChannelMode`, before `spawnClaudeCode`: `await killOrphanClaudeIfAny();`
- Inside `spawnClaudeCode` after PTY spawn: `recordPid(claudeProcess.pid);`
- Inside `teardownChannelMode` after Claude exit: `clearPid();`
- Inside `app.on('will-quit')` handler: `clearPid();` (best-effort)

Source to crib from: `src/claude-session-supervisor/runtime.js` — functions `recordPid`, `probeOrphanStatus`, `findAndKillOrphans`. Strip out epoch logic, pidfile-signature verification, and the `_orphanStatusUnsafe` latch. Keep only basic ps-match-and-kill.

---

## 7. What REPLACES the scheduler

**Action: restore `src/scheduler.js` to its state at commit `5598ac1`.**

Canonical file already archived — use either of:

```bash
# Option A: copy from archive
cp ~/.root-operator/workspace/memory/scheduled-jobs-archive/scheduler_5598ac1.js src/scheduler.js

# Option B: check out from git history
git show 5598ac1:src/scheduler.js > src/scheduler.js
```

Both produce the same 394 bytes-for-bytes file.

**Characteristics of the restored file:**
- Constructor: `new Scheduler(store, channelManager)` — 2 args, no supervisor.
- Exports: `{ Scheduler }` only (no `jobSilenceFor` — that was added for supervisor coupling).
- `_fireJob`: calls `channelManager.sendToChannel('__scheduler__', payload, '__scheduler__')`; success on boolean `true`, error on `false` or throw.
- Stuck-run: wall-clock 2h cutoff on boot (no supervisor consultation).
- Backoff: `BACKOFF_SCHEDULE_MS` 30s → 60s → 5m → 15m → 60m on consecutive errors.
- Auto-disable after 10 consecutive errors.
- `MAX_JOBS=50`, `MAX_PROMPT_SIZE=50_000`, refire gap 5s.

**No modifications to the restored file** beyond what's required for it to run on the current codebase. Verify that `channelManager.sendToChannel` signature is unchanged since 5598ac1 (it should be — that method has been stable). If any modernization is needed (e.g. a renamed export, an `await` missing on a newly-async method), keep the diff surgical and note it in the commit message.

**main.js wiring changes in `initChannelMode`:**
Replace `scheduler = new Scheduler(store, channelManager, supervisor);` with `scheduler = new Scheduler(store, channelManager);`. Reference snippet for how this was wired at 5598ac1: `~/.root-operator/workspace/memory/scheduled-jobs-archive/main_wiring_5598ac1.js`.

---

## 8. main.js split

Target: `main.js` from 6231 lines → ~500 lines of entry-point wiring.

Create `src/main/` directory with modules below. Each exports an `init(deps)` function; `main.js` wires them together in `app.whenReady()`.

| Module | Source lines (approx) | Role |
|--------|-----------------------|------|
| `src/main/crypto-pairing.js` | 100–810 | E2E handshake, JWK, worker keys, RSA/ECDH |
| `src/main/tunnel.js` | 853–1044 | Cloudflare tunnel setup, subdomain mgmt |
| `src/main/window-manager.js` | 1045–1325 | BrowserWindow lifecycle, viewer windows, dock icon |
| `src/main/notifications.js` | 1370–1818 | VAPID keys, web-push, desktop notifications |
| `src/main/tray.js` | 1826–2000 | Tray icon + menu |
| `src/main/activity-tracker.js` | 2022–2200 | Hook/debug watchers, activity formatting |
| `src/main/local-chat.js` | 2242–2500 | Local chat window + attachments |
| `src/main/claude-lifecycle.js` | 3153–3500 | PTY spawn/kill, exit handler, hook/debug polling |
| `src/main/channel-mode.js` | 3500–4025 | Wires scheduler + channelManager + orphan-kill |
| `src/main/ipc-handlers.js` | 4220–4600 | All `ipcMain.handle` registrations |
| `src/main/websocket-server.js` | 5000–5700+ | Pairing handshake, device auth, notification endpoints |
| `src/main/logging.js` | 4585–4700 | Debug log rotation, file size limits |

After extraction, `main.js` holds only:
- `require` statements for the new modules
- Global singletons (`store`, `dynamicMemory`, `channelManager`, `scheduler`, `claudeProcess`)
- `app.whenReady()` wiring: call `init(deps)` on each module in the right order
- `app.on('before-quit')` / `will-quit` teardown coordination
- Platform-specific glue (single-instance lock, `app.setName`, default protocol)

---

## 9. Execution sequence

**Phase 0 — baseline.** On `refactor/scheduler-strip` at HEAD `d5339b5` (the plan commit), confirm current test suite passes. Note any pre-existing failures so we can tell what's new from the refactor.

**Phase 1 — orphan-kill extraction.**
1. Create `src/orphan-kill.js` by cribbing `recordPid` + `probeOrphanStatus` + `findAndKillOrphans` from `src/claude-session-supervisor/runtime.js`. Strip epoch logic, signature verification, and the `_orphanStatusUnsafe` latch.
2. Add `src/orphan-kill.test.js` with a handful of unit tests: pidfile write/read/clear, ps-match detection, orphan kill happy path, pid-not-running cleanup.
3. **Do not wire into main.js yet.** Pure addition. Supervisor folder still present and wired as before — nothing should regress.
4. Commit: `Extract boot-time orphan Claude kill into src/orphan-kill.js`

**Phase 2 — scheduler restore + supervisor removal.**
1. Restore `src/scheduler.js` from `~/.root-operator/workspace/memory/scheduled-jobs-archive/scheduler_5598ac1.js` (see §7 for both copy methods).
2. Update `main.js`:
   - Delete supervisor imports.
   - Delete supervisor init block in `initChannelMode`.
   - Delete supervisor teardown in `teardownChannelMode`.
   - Change `new Scheduler(store, channelManager, supervisor)` → `new Scheduler(store, channelManager)`.
   - Add `await killOrphanClaudeIfAny();` before `spawnClaudeCode()` call in `initChannelMode`.
   - Inside `spawnClaudeCode`, call `recordPid(claudeProcess.pid)` after PTY spawn.
   - Inside `teardownChannelMode` and `will-quit` handler, call `clearPid()`.
3. Delete entire `src/claude-session-supervisor/` directory.
4. Check if any other module requires `better-sqlite3` — if not, remove from `package.json` dependencies and `npm uninstall`. If it's still used by dynamic-memory or elsewhere, keep it.
5. On first boot of the new build, delete any leftover supervisor SQLite database file (`rm -f ~/.root-operator/runtime/*/supervisor.db` style cleanup — Codex should pick the right path by inspecting runtime dir).
6. Boot the app, exercise channel mode, spawn Claude, trigger `ro_run_now` on a test job. Verify Claude receives `[Scheduled: ...]` message and responds.
7. Commit: `Restore scheduler to 5598ac1 form; remove claude-session-supervisor`

**Phase 3 — test cleanup.**
1. All supervisor-folder tests were deleted in Phase 2 (with the folder). Verify with `ls src/claude-session-supervisor/ 2>/dev/null` returning empty.
2. Check if a scheduler.test.js exists at root or under src/ on master today. If yes, verify it still passes against the restored 5598ac1 scheduler. If it references supervisor-aware paths (`listOpenDispatches`, `jobSilenceFor`, etc.), adjust or remove those test cases.
3. If no scheduler test existed on master today, check `git show 5598ac1 -- '*.test.js'` to see if one existed at 5598ac1. If so, restore that test file.
4. Run the full test suite. All passes.
5. Commit: `Tests: align with restored scheduler; remove supervisor tests`

**Phase 4 — main.js split.** One module per commit. For each of the 12 modules in §8:
1. Create `src/main/<module>.js` with the extracted code.
2. Define `init(deps)` signature.
3. Replace in-place code in `main.js` with `require` + `init(deps)` call.
4. Smoke: launch app, exercise the feature belonging to that module.
5. Commit: `main.js: extract <module>`

Order (low-risk → high-risk, so critical paths are last):
1. `logging`
2. `tray`
3. `window-manager`
4. `crypto-pairing`
5. `tunnel`
6. `notifications`
7. `websocket-server`
8. `activity-tracker`
9. `local-chat`
10. `ipc-handlers`
11. `claude-lifecycle`
12. `channel-mode` (touches scheduler + orphan-kill — do last)

**Phase 5 — verification (acceptance criteria in §11).**

---

## 10. Tests — deletion / reduction summary

| Test file | Fate |
|-----------|------|
| `src/claude-session-supervisor/orchestrator.test.js` | DELETE (with folder) |
| `src/claude-session-supervisor/policy.test.js` | DELETE (with folder) |
| `src/claude-session-supervisor/runtime.test.js` | DELETE (with folder) |
| `src/claude-session-supervisor/incidents.test.js` | DELETE (with folder) |
| `src/claude-session-supervisor/dispatch-store.test.js` | DELETE (with folder) |
| `src/claude-session-supervisor/pr3-effect-ledger.test.js` | DELETE (with folder) |
| `src/claude-session-supervisor/schema-migration.test.js` | DELETE (with folder) |
| `src/claude-session-supervisor/channel-manager-integration.test.js` | DELETE (with folder) |
| `src/claude-session-supervisor/scheduler-integration.test.js` | DELETE (with folder) |
| `src/orphan-kill.test.js` | NEW in Phase 1 |
| Root-level `scheduler.test.js` (if exists on master) | Update to match restored scheduler; strip supervisor-aware tests |

---

## 11. Acceptance criteria

1. Test suite passes on `refactor/scheduler-strip` at HEAD of Phase 5. No supervisor tests remain. `src/orphan-kill.test.js` passes.
2. App launches clean in channel mode. Claude spawns. Bridge connects. Tunnel comes up.
3. No file under `src/claude-session-supervisor/` exists on disk.
4. No import of `claude-session-supervisor` anywhere in the codebase: `grep -rn "claude-session-supervisor" src/ main.js` returns nothing.
5. Scheduled-job `runNow` via MCP tool delivers the prompt into Claude's channel immediately; Claude responds; `lastRun` updates with `lastResult: 'success'`.
6. **Overnight smoke:** re-add the three archived jobs from `~/.root-operator/workspace/memory/scheduled-jobs-archive/` (Night Lab 03:22, Signal 04:00, Sleep Cycle 05:00 CET). Expected behavior: all three messages appear in the channel as scheduled; Claude processes them in order. If Claude hangs on one, the other two queue behind it in channelManager's 100-message buffer; when Claude recovers, queued ones drain. No `supervisor-incidents.jsonl` updates during the run (file frozen). No orphan half-builds (each job fires exactly once per scheduled tick).
7. `main.js` ≤ 700 lines. `src/main/` has ≤ 12 module files, each < 800 lines.
8. `grep -rn "dispatch" src/ main.js` returns nothing in production code.

---

## 12. Rollback

Branch `refactor/scheduler-strip` is isolated from master. To abort at any phase:

```bash
cd ~/Documents/Dev/55-Root_Operator
git checkout master
git branch -D refactor/scheduler-strip
```

Intermediate rollback: each phase is its own commit. `git reset --hard HEAD~N` to back out N phases.

---

## 13. Decisions already made (so Codex doesn't re-ask)

- **Restore scheduler to 5598ac1 form** — full 394-line file with `consecutiveErrors` tracking + auto-disable-after-10. Tom: "Keep it as it was and we will go from there."
- **Delete the whole `claude-session-supervisor/` folder** — only genuine value (boot orphan-kill) extracted into `src/orphan-kill.js`. Dispatch state machine, replay logic, effect ledger, incidents SQLite, dispatch tables — all gone.
- **Scheduler job-record migration**: no migration needed. The 5598ac1 scheduler reads today's job records without modification (today's fields are a superset of what 5598ac1 used; runtime-state fields get overwritten on next tick).
- **Existing supervisor SQLite database**: delete on first boot. No historical forensic data needs to migrate.
- **`supervisor-incidents.jsonl`**: leave existing file on disk as historical artifact; stop writing to it. User can manually delete.
- **Codex dispatch cadence**: phase-at-a-time. Tom submits each phase to Codex manually after reviewing the previous phase's commit.
- **Archived state** for re-adding scheduled jobs and for the canonical scheduler file: `~/.root-operator/workspace/memory/scheduled-jobs-archive/` (see §0 table).

---

## 14. Still-open questions for Codex to surface

- **`better-sqlite3` dependency:** Phase 2 says remove from `package.json` if no other module uses it. Codex should verify with `grep -rn "better-sqlite3" src/ main.js` after supervisor deletion. If any other module uses it (e.g. dynamic-memory embeddings), keep the dependency.
- **Root-level `scheduler.test.js`:** verify whether this file exists on master today. If yes, it may have been updated for supervisor-aware paths and will need adjustment. If no, check if one existed at 5598ac1 that should be restored.

---

_End of plan._
