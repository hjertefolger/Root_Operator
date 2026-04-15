# PR2 Smoke Test — Self-Heal Verification

This tests the real end-to-end recovery loop on your live dev app. Takes ~3-5 minutes once the app is running.

## Prerequisites

1. Your live app (stable branch, `npm run dev:app`) is **stopped**.
2. No other Claude subprocess is running from the same workspace (`pgrep -f "claude .*root-operator" | xargs -I{} ps -p {} -o pid,etime,command` — expect empty).

## Setup

```bash
cd ~/Documents/Dev/55-Root_Operator
git stash -u                                # in case there's any unstaged cruft
git checkout supervisor-pr2-self-heal
npm run dev:app
```

Wait for:
- `[SUPERVISOR] observe-only mode active (PR1)` in the debug log (yes, the message still says PR1 — harmless; the PR2 code paths are active regardless)
- `[channel-bridge] MCP channel server running` from the bridge
- `[ChannelManager] Bridge ready (pid=XXXX)` — this is the **new PR2 handshake**. If you don't see it, the handshake is broken.

## Check 1 — Baseline: a normal scheduled job still works

Quick sanity check that nothing regressed.

Schedule a 60s job from your device:
```
/schedule "dev_smoke_ok" "*/1 * * * *" "Reply with one word: OK"
```

Wait for one firing (~1 min). You should receive "OK" on your device. Delete the job:
```
/schedule_delete dev_smoke_ok
```

If this fails → abort, PR2 regressed something. Open an issue.

## Check 2 — The actual self-heal test: wedged Claude

This is the one that matters. Schedule a job whose prompt deliberately wedges Claude:

```
/schedule "dev_smoke_wedge" "*/2 * * * *" "Call the Bash tool with command 'sleep 900'. Do not reply until sleep finishes. Do not use any other tool."
```

Wait for it to fire. What you should see in the debug log (`~/.root-operator/runtime/claude-channel-debug.log`):
1. Claude receives the prompt
2. PreToolUse:Bash hook fires (sleep starts)
3. **~5 minutes of silence** (the default `silenceMs` for scheduler jobs)
4. `[SUPERVISOR]` records `wedge_detected` in `claude-supervisor.db`
5. `[CLAUDE] Exited (code: ...)` — runtime killed it
6. `[CLAUDE] Spawning Claude Code via PTY...` — respawn
7. `[channel-bridge] MCP channel server running` — new bridge
8. `[ChannelManager] Bridge ready (pid=YYYY)` — pid changes, confirms respawn
9. `[SUPERVISOR]` records `dispatch_replay_started` — same dispatchId, replay_count=1
10. New Claude receives the replayed prompt and (because it's the same wedging prompt) wedges AGAIN
11. Second wedge_detected, second kill, second respawn
12. After the 3rd attempt fails within 30s (burst budget): `intensity_exhausted` → `HARD_FAILED`
13. `[system notice] Scheduled task could not be delivered. Reason: intensity_exhausted.` lands on your device

**If every one of those 13 markers shows up in order, PR2 works end-to-end.**

Stop the test:
```
/schedule_delete dev_smoke_wedge
```

## Check 3 — Inspect the DB

Open the SQLite dispatch store and verify the incident trail:

```bash
sqlite3 ~/.root-operator/workspace/brain/claude-supervisor.db \
  "SELECT kind, state_from, state_to, dispatch_id, occurred_at FROM incidents ORDER BY incident_id DESC LIMIT 20;"
```

Look for (reading top-to-bottom = most recent first):
- `system_notice_emitted` (or `_failed` if the bridge was down)
- `intensity_exhausted`
- multiple `dispatch_replay_started` (one per retry up to `replay_cap`)
- multiple `wedge_detected` / `kill_ordered` / `process_already_dead` pairs
- original `dispatch_enqueued` / `dispatch_activated`

Cross-check the dispatch row:
```bash
sqlite3 ~/.root-operator/workspace/brain/claude-supervisor.db \
  "SELECT dispatch_id, state, replay_count, last_error, visible_effect_count FROM dispatches ORDER BY enqueued_at DESC LIMIT 3;"
```

The wedge test dispatch should show `state=failed`, `replay_count=2` (the cap for scheduler), `last_error=intensity_exhausted`.

## Check 4 — Clean restart works

After the smoke test, the supervisor should be stuck in HARD_FAILED. Restart the dev app:

```bash
# cmd+q the Electron window, then:
npm run dev:app
```

Watch for a clean boot: supervisor goes STOPPED → STARTING → IDLE, no HARD_FAILED residue. (HARD_FAILED is an in-memory state; the DB is a fresh dispatch store per boot so intensity ring is reset from whatever was persisted, and a normal boot should NOT trip intensity since there are no recent kill timestamps from this session.)

## Rollback

If anything feels wrong:
```bash
cd ~/Documents/Dev/55-Root_Operator
# stop dev:app (cmd+q)
git checkout master
git stash pop   # if you stashed earlier
npm run dev:app
```

The PR2 branch and worktree stay available for another run.

## What "success" means for PR2

**Minimum** (the bar for merging): Checks 1 + 2 pass. Claude wedges overnight → self-heal loop runs → you see system notices instead of silence.

**Full** (the bar for "we're done"): All 4 checks pass, and you can run overnight on a real scheduler job (Night Lab / Signal) without waking up to silent failures.

## Known PR2 limitations (deferred to PR3+)

- Channel/user messages (not scheduler jobs) are still NOT replayed on wedge. If you send a message from your device and Claude wedges on it, you'll still get "Waiting for One" until timeout. Fixed in PR3 when all traffic routes through supervisor.
- Kill-during-external-side-effect can leave partial state (HTTP call half-committed). Acceptable risk per the plan — full fix via effect ledger is PR3-4.
- Bridge-offline UI pill on device not yet added (cosmetic).
