# PR1 — Observe-Only Foundations

**Status:** Draft
**Branch:** `supervisor-pr1-observe-only`
**Worktree:** `~/Documents/Dev/55-Root_Operator.wt/supervisor-pr1`
**Design doc:** `~/.root-operator/workspace/design/claude-session-supervisor-v4.md`

## Scope

Observe-only foundations for the ClaudeSessionSupervisor primitive. Land all the infrastructure needed for later PRs to enable wedge detection and recovery, without any auto-kill or respawn behavior in this PR. Core shipping value: **the scheduler stops lying in `config.json`** — `lastRun` becomes a real completion signal, not a socket-write signal.

## Explicitly NOT in PR1

- `_ping` tool + bridge request/response conversion → PR3
- Effect ledger commit machinery for reply/memory/attachment → PR3-4
- Wedge detection, auto-kill, respawn, `--resume` logic → PR4
- `ChannelManager` pending-buffer removal → PR2
- Hard-failed escalation UX → PR4

## Task breakdown

### 1. Scaffolding

- [ ] Create `src/claude-session-supervisor/` directory
- [ ] Add 5 empty modules with their public shape:
  - `orchestrator.js` — `createSupervisor(deps)` exports `enqueue`, `awaitOutcome`, `getStatus`, `shutdown`, event emitters
  - `dispatch-store.js` — SQLite wrapper for `dispatches` / `effects` / `incidents` tables
  - `runtime.js` — spawn/kill Claude, epoch-scoped runtime files, bridge connect, hook/debug watchers, orphan cleanup (PR1 implements the epoch + orphan parts; spawn/kill stays in main.js for PR1)
  - `policy.js` — pure FSM + restart intensity (PR1: only state transitions needed for observe-only)
  - `incidents.js` — structured incident recording to `incidents` table + `~/.root-operator/runtime/supervisor-incidents.jsonl`
- [ ] `index.js` re-exports the public API

### 2. Dispatch store + schema

- [ ] Create SQLite module that opens `~/.root-operator/workspace/brain/claude-supervisor.db`
- [ ] Schema migration v1:
  ```sql
  CREATE TABLE dispatches (
    dispatch_id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    source_id TEXT,
    chat_id TEXT,
    payload TEXT NOT NULL,
    silence_ms INTEGER NOT NULL,
    replay_cap INTEGER NOT NULL,
    replay_count INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL,
    epoch INTEGER,
    enqueued_at INTEGER NOT NULL,
    sending_at INTEGER,
    activated_at INTEGER,
    terminal_at INTEGER,
    last_progress_at INTEGER,
    visible_effect_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT
  );
  CREATE INDEX idx_dispatches_state ON dispatches(state, enqueued_at);

  CREATE TABLE effects (
    effect_id TEXT PRIMARY KEY,
    dispatch_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    kind TEXT NOT NULL,
    payload_hash TEXT,
    status TEXT NOT NULL,
    prepared_at INTEGER NOT NULL,
    committed_at INTEGER,
    external_ref TEXT,
    UNIQUE(dispatch_id, ordinal, kind)
  );
  CREATE INDEX idx_effects_dispatch ON effects(dispatch_id);

  CREATE TABLE incidents (
    incident_id INTEGER PRIMARY KEY AUTOINCREMENT,
    epoch INTEGER,
    kind TEXT NOT NULL,
    state_from TEXT,
    state_to TEXT,
    dispatch_id TEXT,
    details_json TEXT NOT NULL,
    occurred_at INTEGER NOT NULL
  );
  CREATE INDEX idx_incidents_occurred ON incidents(occurred_at);
  ```
- [ ] WAL mode enabled (`PRAGMA journal_mode=WAL`)
- [ ] Migration runner (idempotent — runs on open)
- [ ] Prepared-statement helpers: `insertDispatch`, `updateDispatchState`, `markDispatchTerminal`, `insertEffect`, `updateEffectCommitted`, `listPendingDispatches`, `listPreparedEffects`, `insertIncident`
- [ ] Unit tests (in-memory SQLite): insert + update + query; UNIQUE constraint on effects; WAL behavior; migration idempotency

### 3. Epoch-scoped runtime files

- [ ] Track current `epoch` in `dispatch-store` (persisted in a small `supervisor_state` table with one row, or a separate file `~/.root-operator/runtime/supervisor-epoch`)
- [ ] Every supervisor start increments epoch
- [ ] Hook log path becomes `~/.root-operator/runtime/claude-channel-hooks.e<N>.jsonl`
- [ ] Debug log path becomes `~/.root-operator/runtime/claude-channel-debug.e<N>.log`
- [ ] Update symlinks `claude-channel-hooks.jsonl` → `claude-channel-hooks.e<N>.jsonl` and same for debug, so existing tooling still finds the current log
- [ ] Update `main.js` where it writes/watches these paths to use epoch-scoped variants
- [ ] Cleanup policy: keep last 3 epochs worth of files, delete older (to avoid runtime dir bloat)

### 4. Orphan PID/socket cleanup on boot

- [ ] On supervisor start, read `~/.root-operator/runtime/supervisor.pidfile` (new)
- [ ] If file exists and PID is live, kill it (SIGKILL) — this is an orphan Claude from a prior crashed Electron
- [ ] If stale socket file `/tmp/root-operator-channel.sock` exists, `unlinkSync` it
- [ ] Write fresh pidfile after new Claude PID is known (integration point with existing spawn in main.js)
- [ ] Unit test: simulate orphan PID existing, boot supervisor, verify orphan killed + pidfile replaced

### 5. Incident logging

- [ ] Module `incidents.js` exposes `record(kind, state_from, state_to, dispatch_id, details)` → writes row + appends JSONL line
- [ ] Wire up at all state transitions in policy.js
- [ ] PR1 incident kinds surfaced: `supervisor_start`, `orphan_killed`, `epoch_bumped`, `dispatch_enqueued`, `dispatch_activated`, `dispatch_completed`, `dispatch_failed`
- [ ] Unit test: every state transition produces exactly one incident row + one JSONL line

### 6. Active-dispatch register (observe-only)

- [ ] `orchestrator.js` maintains in-memory `activeDispatch = null | { dispatchId, epoch, startedAt, lastProgressAt }`
- [ ] On scheduler or channel enqueue: insert dispatch row, assign to `activeDispatch` if idle, otherwise queue
- [ ] Tail `claude-channel-hooks.e<N>.jsonl` (epoch-scoped)
- [ ] On any hook event belonging to current epoch: update `lastProgressAt`, increment `visible_effect_count` if hook is `PreToolUse` with tool name `reply`
- [ ] On `Stop` hook (current epoch): mark dispatch `completed`, clear `activeDispatch`, resolve the `awaitOutcome` promise
- [ ] On `StopFailure` hook (current epoch): mark dispatch `failed`, clear `activeDispatch`, reject the promise with the failure reason
- [ ] Timeout fallback: if no Stop/StopFailure within `silence_ms * 10` (a soft ceiling — prevents forever-hanging awaiters in PR1 since we don't have auto-kill yet), mark dispatch `abandoned` with `last_error = 'timeout_no_stop'`. Generous ceiling because PR1 has no wedge detection; this is just a safety net for the awaiter.

### 7. Scheduler integration

- [ ] `src/scheduler.js` — replace the `channelManager.sendToChannel(...)` path in `_fireJob` with `await supervisor.enqueue({ source: 'scheduler', source_id: job.id, payload: job.prompt, silence_ms: jobSilenceFor(job) })` + `await supervisor.awaitOutcome(dispatchId)`
- [ ] Result mapping: `completed` → `_completeJob(success)`, `failed`/`abandoned` → `_completeJob(error)` with the failure reason
- [ ] Remove the current boolean-short-circuit at `src/scheduler.js:301`
- [ ] `jobSilenceFor(job)` helper: maps job type to expected max silence (Night Lab: 30min, Signal: 10min, Sleep Cycle: 5min, default: 5min)
- [ ] Integration smoke test: spawn dev env, manually trigger a tiny scheduler job, verify lastRun stamped only after Stop hook fires

### 8. External_ref columns (schema migrations for downstream stores)

- [ ] `src/chat-store.js` — add `external_ref TEXT` column (nullable), migration runs on open
- [ ] `src/dynamic-memory/db.js` — add `external_ref TEXT` column (nullable), migration runs on open
- [ ] PR1 does NOT populate these columns (no effect-ledger writes yet). Just schema additions so PR3/4 can populate them without migration churn.
- [ ] Unit test: existing rows stay intact after migration; new inserts can write external_ref; null external_ref still works

### 9. Wiring in main.js

- [ ] In `main.js`, after `channelManager.connect()` and `spawnClaudeCode()`, instantiate supervisor: `const supervisor = createSupervisor({ channelManager, dispatchStore, hookLogPath: currentEpochHookPath, ... })`
- [ ] Expose supervisor to scheduler via existing DI pattern
- [ ] Shutdown handler: `app.on('before-quit')` → `supervisor.shutdown()` (closes DB, stops hook watcher)
- [ ] PR1 does NOT change Claude spawn logic itself — that stays in main.js. Supervisor just observes.

### 10. Testing

- [ ] Unit: dispatch-store.js (schema, prepared statements, WAL, UNIQUE constraints, migration idempotency)
- [ ] Unit: policy.js (pure state transitions)
- [ ] Unit: incidents.js (JSONL + table writes)
- [ ] Unit: orphan cleanup (mock pidfile + dead PID + live PID cases)
- [ ] Unit: epoch file path resolution + symlink management
- [ ] Integration: end-to-end scheduler job through supervisor (real dev Claude), verify completed state + lastRun stamp
- [ ] Integration: crash-recovery simulation (write queued row, restart, verify state transitions correctly)

### 11. Codex review checkpoint

After steps 1-10 are passing unit + smoke tests:
- [ ] Run Codex review with the PR1 diff + this plan as context
- [ ] Ask Codex to verify: design doc v4 implemented faithfully; no over-engineering beyond scope; no missing safety net for the `abandoned` timeout case; schema migrations won't break existing users' memory.db / chat-store state
- [ ] Fix any findings, re-test

### 12. Ready to merge

- [ ] Tom reviews the diff
- [ ] If approved, merge `supervisor-pr1-observe-only` → `master`
- [ ] Delete worktree

## Risk register (PR1 specific)

1. **SQLite migration on existing memory.db** — dynamic-memory db has production data. External_ref column addition must be idempotent + non-destructive. Back up before, test migration on a copy first.
2. **Epoch symlink on macOS** — symlinks can be finicky; if an old process has the file open, renaming may not work atomically. Mitigation: use stable filename `claude-channel-hooks.jsonl` as the primary path, and the `.e<N>.jsonl` files are archive copies. Revisit if tests fail.
3. **Integration smoke test needs dev env** — I have to run the dev build locally to actually fire a scheduler job. Will need `npm run dev` etc.
4. **Scheduler integration touches live code** — scheduler.js changes affect how jobs report success. Existing jobs that currently succeed would now wait for Stop hook. Risk: if Stop hook doesn't fire for some reason (e.g., Claude dies before emitting), the job goes to `abandoned` instead of `success`. That's the right behavior, but flag to Tom that scheduler.js semantics are materially different after this PR.
5. **Ordering of steps** — step 7 (scheduler integration) depends on steps 1-6. Should NOT be done in parallel. Safest order: 1→2→3→4→5→6→8→9→7→10.

## Success criteria for PR1

1. Scheduler fires a job, supervisor enqueues, dispatch advances through states, scheduler receives real `completed` signal only after Stop hook fires. No more 9-11ms socket-write-as-success lie.
2. Unit tests green.
3. Existing user workflow (channel messages, scheduler, memory enrichment) continues to work — no regressions.
4. Codex round finds no blockers.
5. Tom can read the diff and understand what's new.

## What PR1 does NOT accomplish

- No protection against wedges yet (no auto-kill, no respawn). If Claude wedges after PR1 ships, the scheduler will correctly say `abandoned` after the safety-net timeout, but Claude itself stays wedged until Tom restarts the app manually. That's PR4.
- No duplicate-reply protection yet (that's PR3).
- `ChannelManager` pending buffer still exists (removed in PR2).
