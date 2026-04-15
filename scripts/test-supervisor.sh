#!/usr/bin/env bash
# Runs supervisor node:test suites against system Node by swapping
# better-sqlite3's native binding between Electron-built and Node-built
# copies. The Electron build is always restored on exit.
#
# First run: builds the Node copy (~60s) and caches both. Subsequent runs:
# instant swap.
#
# Cache lives OUTSIDE node_modules/ (under scripts/.supervisor-test-cache/)
# so `npm rebuild` cannot wipe it.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
BIND_DIR="$REPO/node_modules/better-sqlite3/build/Release"
CURRENT="$BIND_DIR/better_sqlite3.node"
CACHE_DIR="$REPO/scripts/.supervisor-test-cache"
ELECTRON_CACHE="$CACHE_DIR/better_sqlite3.electron.node"
NODE_CACHE="$CACHE_DIR/better_sqlite3.node-abi.node"

mkdir -p "$CACHE_DIR"

if [ ! -f "$CURRENT" ]; then
    echo "error: $CURRENT missing — run npm install first" >&2
    exit 1
fi

# Verify CURRENT is the Electron binding before caching it. We detect this
# by attempting to require it under system Node — if it loads, it's node-abi;
# if it throws ERR_DLOPEN_FAILED, it's electron.
is_electron_binding() {
    node -e "try { require('$CURRENT'); process.exit(1); } catch (e) { process.exit(e.code === 'ERR_DLOPEN_FAILED' ? 0 : 2); }"
    return $?
}

if [ ! -f "$ELECTRON_CACHE" ]; then
    if is_electron_binding; then
        echo "[test-supervisor] caching electron binding"
        cp "$CURRENT" "$ELECTRON_CACHE"
    else
        echo "error: current binding is not electron-built; run 'npm run rebuild' first" >&2
        exit 1
    fi
fi

if [ ! -f "$NODE_CACHE" ]; then
    echo "[test-supervisor] building node-abi binding (first run, ~60s)"
    ( cd "$REPO" && npm rebuild better-sqlite3 --build-from-source --no-save >/dev/null 2>&1 )
    cp "$CURRENT" "$NODE_CACHE"
    # Restore electron immediately. A concurrent Electron process that
    # reloads its binding must see the right ABI.
    cp "$ELECTRON_CACHE" "$CURRENT"
fi

restore_electron() {
    cp "$ELECTRON_CACHE" "$CURRENT"
}
trap restore_electron EXIT

echo "[test-supervisor] swapping to node-abi binding"
cp "$NODE_CACHE" "$CURRENT"

ARGS=("$@")
if [ ${#ARGS[@]} -eq 0 ]; then
    ARGS=(
        src/claude-session-supervisor/policy.test.js
        src/claude-session-supervisor/runtime.test.js
        src/claude-session-supervisor/incidents.test.js
        src/claude-session-supervisor/dispatch-store.test.js
        src/claude-session-supervisor/schema-migration.test.js
        src/claude-session-supervisor/orchestrator.test.js
        src/claude-session-supervisor/scheduler-integration.test.js
        src/claude-session-supervisor/channel-manager-integration.test.js
    )
fi

cd "$REPO"
node --test --test-force-exit --test-timeout=30000 --test-reporter=spec "${ARGS[@]}"
