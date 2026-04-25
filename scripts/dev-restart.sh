#!/usr/bin/env bash
#
# Detached restart worker for the in-app "Restart" button when running
# Root Operator in dev mode (npm run dev:app). Spawned by main.js with
# detached: true / stdio: 'ignore', so it survives electron's death and
# brings the dev tree back up with the Cloudflare tunnel auto-started.
#
# Sequence:
#   1. Wait briefly for the parent electron to exit / get killed.
#   2. Locate the concurrently parent of `npm run dev:app` and kill its
#      process group (TERM, then KILL after 4s) so vite + electron go down.
#   3. Wait for ports 5174 / 5175 to release.
#   4. exec a fresh `npm run dev:app` from REPO_DIR with
#      RO_AUTO_START_TUNNEL=1 so the tunnel comes up without Cmd+Shift+J.
#
# Production restart never reaches this script — main.js branches on
# isDev and uses app.relaunch() for packaged builds.

set -uo pipefail

LOG="${RO_DEV_LOG:-/tmp/ro-dev.log}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_DIR="${RO_DEV_REPO_DIR:-$(cd "${SCRIPT_DIR}/.." && pwd -P)}"

ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { printf '[%s] %s\n' "$(ts)" "$*" >> "$LOG"; }

# True detachment: Node's `detached: true` only setsid()s the child — its
# ppid stays as electron until electron exits. concurrently -k uses
# tree-kill which walks ppid recursively and reaps the worker before it
# can exec the new dev:app. Re-exec ourselves as a grandchild via Python
# double-fork on first entry so we reparent to init (PID 1) immediately,
# out of any kill-tree rooted at electron.
if [ -z "${RO_DEV_RESTART_DETACHED:-}" ]; then
    PY="$(command -v python3 || command -v python || true)"
    if [ -z "$PY" ]; then
        log "FATAL no python available for double-fork detachment"
        exit 1
    fi
    RO_DEV_RESTART_DETACHED=1 "$PY" - "$0" <<'PYEOF' &
import os, sys
# Resolve before chdir('/') so relative invocation paths still work.
script = os.path.abspath(sys.argv[1])
# First fork
if os.fork() > 0: os._exit(0)
os.setsid()
# Second fork — grandchild becomes orphan, reparented to init
if os.fork() > 0: os._exit(0)
os.chdir('/')
devnull = os.open(os.devnull, os.O_RDWR)
os.dup2(devnull, 0); os.dup2(devnull, 1); os.dup2(devnull, 2)
if devnull > 2:
    os.close(devnull)
os.execvp('/bin/bash', ['/bin/bash', script])
PYEOF
    exit 0
fi

log "dev-restart worker pid=$$ ppid=$PPID repo=${REPO_DIR}"

# Give the parent a moment to exit so we don't race its teardown.
sleep 2

kill_pgid() {
    local pid="$1"
    local pgid
    pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
    if [ -n "$pgid" ] && [ "$pgid" != "$$" ]; then
        log "TERM pgid $pgid (concurrently pid $pid)"
        kill -TERM "-$pgid" 2>/dev/null || true
    fi
}

# Resolve the cwd of a PID via lsof. Returns "" if unreadable.
pid_cwd() {
    local pid="$1"
    lsof -a -d cwd -p "$pid" -Fn 2>/dev/null | awk '/^n/ {print substr($0,2); exit}'
}

# True if the supplied cwd belongs to REPO_DIR (exact match or under
# REPO_DIR/). Avoids accidentally matching siblings whose path starts with
# the same prefix (e.g. .../55-Root_Operator-clone-2).
cwd_belongs_to_repo() {
    local cwd="$1"
    [ -n "$cwd" ] || return 1
    [ "$cwd" = "$REPO_DIR" ] && return 0
    case "$cwd" in
        "${REPO_DIR}/"*) return 0 ;;
    esac
    return 1
}

# Find the concurrently process for THIS repo's dev:app and kill its
# process group. Filtering by cwd avoids killing a parallel dev tree
# in a different clone.
PARENT_PID=""
while read -r pid; do
    [ -z "$pid" ] && continue
    cwd="$(pid_cwd "$pid")"
    if cwd_belongs_to_repo "$cwd"; then
        PARENT_PID="$pid"
        break
    fi
done < <(pgrep -f 'concurrently.*dev:renderer.*dev:client' || true)

if [ -n "${PARENT_PID:-}" ]; then
    kill_pgid "$PARENT_PID"
else
    log "no concurrently process matched for repo ${REPO_DIR}"
fi

# Wait up to 4s, then KILL anything still attached to the repo cwd.
sleep 4

for pattern in 'npm run dev:app' 'concurrently.*dev:renderer' 'vite.*config' 'electron .' 'claude --dangerously-skip-permissions'; do
    while read -r pid; do
        [ -z "$pid" ] && continue
        cwd="$(pid_cwd "$pid")"
        if cwd_belongs_to_repo "$cwd"; then
            log "KILL $pid ($pattern, cwd=$cwd)"
            kill -KILL "$pid" 2>/dev/null || true
        fi
    done < <(pgrep -f "$pattern" || true)
done

# Wait for vite ports to release; hard-kill any straggler bound to the
# port AND owned by this repo. We never KILL a process holding the port
# whose cwd is a different repo — protects parallel dev trees.
for port in 5174 5175; do
    for _ in 1 2 3 4 5 6 7 8 9 10; do
        if ! lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
            break
        fi
        sleep 1
    done
    while read -r leftover; do
        [ -z "$leftover" ] && continue
        cwd="$(pid_cwd "$leftover")"
        if cwd_belongs_to_repo "$cwd"; then
            log "port $port still bound by pid $leftover (cwd=$cwd) — KILL"
            kill -KILL "$leftover" 2>/dev/null || true
        else
            log "port $port bound by pid $leftover (cwd=${cwd:-?}) — not in this repo, skipping"
        fi
    done < <(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
    sleep 1
done

cd "$REPO_DIR" || { log "FATAL cannot cd to ${REPO_DIR}"; exit 1; }

# Prepend common installer paths but preserve the inherited PATH so NVM /
# asdf / volta-managed Node setups still resolve correctly.
export PATH="/opt/homebrew/bin:/usr/local/bin:${HOME}/.local/bin:${HOME}/bin:${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"

if ! command -v npm >/dev/null 2>&1; then
    log "FATAL npm not found on PATH"
    exit 1
fi

log "exec npm run dev:app"
# Strip RO_DEV_RESTART_DETACHED so the next button-induced restart re-runs
# the double-fork instead of skipping it (the whole dev tree inherits this
# env, including electron, which spawns the next worker).
exec env -u RO_DEV_RESTART_DETACHED RO_AUTO_START_TUNNEL=1 npm run dev:app >> "$LOG" 2>&1
