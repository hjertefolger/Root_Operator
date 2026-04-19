/**
 * Unit tests for runtime.js.
 * Runner: node --test src/claude-session-supervisor/runtime.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DispatchStore } = require('./dispatch-store');
const { Runtime } = require('./runtime');

function freshFixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-runtime-test-'));
    const dbPath = path.join(dir, 'claude-supervisor.db');
    const runtimeDir = path.join(dir, 'runtime');
    const socketPath = path.join(dir, 'fake.sock');
    const store = new DispatchStore(dbPath);
    const runtime = new Runtime({ store, runtimeDir, socketPath });
    return { dir, dbPath, runtimeDir, socketPath, store, runtime };
}

test('incrementEpoch starts at 1 and increments', () => {
    const { runtime, store } = freshFixture();
    assert.equal(runtime.incrementEpoch(), 1);
    assert.equal(runtime.incrementEpoch(), 2);
    assert.equal(runtime.incrementEpoch(), 3);
    assert.equal(store.getStateValue('epoch'), '3');
    store.close();
});

test('resolveEpochPaths produces expected file names', () => {
    const { runtime, runtimeDir } = freshFixture();
    const { hookLog, debugLog } = runtime.resolveEpochPaths(7);
    assert.equal(hookLog, path.join(runtimeDir, 'claude-channel-hooks.e7.jsonl'));
    assert.equal(debugLog, path.join(runtimeDir, 'claude-channel-debug.e7.log'));
    runtime.store.close();
});

test('ensureEpochFiles creates and is idempotent', () => {
    const { runtime } = freshFixture();
    const { hookLog, debugLog } = runtime.ensureEpochFiles(1);
    assert.equal(fs.existsSync(hookLog), true);
    assert.equal(fs.existsSync(debugLog), true);
    // Idempotent: put content, rerun, content survives
    fs.writeFileSync(hookLog, 'preserved');
    runtime.ensureEpochFiles(1);
    assert.equal(fs.readFileSync(hookLog, 'utf8'), 'preserved');
    runtime.store.close();
});

test('maintainLatestSymlinks creates stable-name symlinks', () => {
    const { runtime, runtimeDir } = freshFixture();
    runtime.ensureEpochFiles(4);
    runtime.maintainLatestSymlinks(4);
    const stableHook = path.join(runtimeDir, 'claude-channel-hooks.jsonl');
    const stableDebug = path.join(runtimeDir, 'claude-channel-debug.log');
    assert.equal(fs.lstatSync(stableHook).isSymbolicLink(), true);
    assert.equal(fs.lstatSync(stableDebug).isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(stableHook), 'claude-channel-hooks.e4.jsonl');
    // Re-pointing works (replaces existing symlink)
    runtime.ensureEpochFiles(5);
    runtime.maintainLatestSymlinks(5);
    assert.equal(fs.readlinkSync(stableHook), 'claude-channel-hooks.e5.jsonl');
    runtime.store.close();
});

test('cleanupOldEpochs keeps last N', () => {
    const { runtime, runtimeDir } = freshFixture();
    for (let e = 1; e <= 6; e++) runtime.ensureEpochFiles(e);
    const report = runtime.cleanupOldEpochs({ keep: 3 });
    // Kept: e4, e5, e6 (3 newest). Removed: e1, e2, e3 × 2 file kinds = 6 files
    assert.equal(report.removed.length, 6);
    for (const e of [1, 2, 3]) {
        assert.equal(fs.existsSync(path.join(runtimeDir, `claude-channel-hooks.e${e}.jsonl`)), false);
    }
    for (const e of [4, 5, 6]) {
        assert.equal(fs.existsSync(path.join(runtimeDir, `claude-channel-hooks.e${e}.jsonl`)), true);
    }
    runtime.store.close();
});

test('detectOrphanPid returns pid if live, null if absent or dead', () => {
    const { runtime } = freshFixture();
    // No pidfile -> null
    assert.equal(runtime.detectOrphanPid(), null);

    // Pidfile with our own live PID -> returns it
    fs.writeFileSync(runtime.pidfilePath(), String(process.pid));
    assert.equal(runtime.detectOrphanPid(), process.pid);

    // Pidfile with a very unlikely-to-exist PID -> null
    fs.writeFileSync(runtime.pidfilePath(), '999999');
    assert.equal(runtime.detectOrphanPid(), null);
    runtime.store.close();
});

test('killOrphanPid handles non-existent pid gracefully', () => {
    const { runtime } = freshFixture();
    const r = runtime.killOrphanPid(999999);
    assert.equal(r.killed, false);
    runtime.store.close();
});

test('cleanupStaleSocket removes existing file', () => {
    const { runtime, socketPath } = freshFixture();
    fs.writeFileSync(socketPath, '');
    assert.equal(fs.existsSync(socketPath), true);
    const r = runtime.cleanupStaleSocket();
    assert.equal(r.removed, true);
    assert.equal(fs.existsSync(socketPath), false);
    // Second call returns absent
    assert.deepEqual(runtime.cleanupStaleSocket(), { removed: false, reason: 'absent' });
    runtime.store.close();
});

test('recordPid writes pidfile (pid + optional command signature), clearPidfile removes it', () => {
    const { runtime } = freshFixture();
    // recordPid now snapshots `ps -p <pid> -o command=` for the current
    // process (the test runner itself) so the pidfile has two lines:
    //   line 1: pid
    //   line 2: command signature (non-empty for the live node process)
    runtime.recordPid(process.pid);
    const raw = fs.readFileSync(runtime.pidfilePath(), 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    assert.equal(parseInt(lines[0], 10), process.pid);
    assert.ok(lines.length >= 1, 'pidfile must at least record the pid');
    // Signature is best-effort; on any platform where ps output is empty
    // we fall back to a single-line pidfile. Both shapes are accepted.

    runtime.clearPidfile();
    assert.equal(fs.existsSync(runtime.pidfilePath()), false);
    // Idempotent: clearing when absent is fine
    runtime.clearPidfile();
    runtime.store.close();
});

test('bootCleanup reports what happened', () => {
    const { runtime, socketPath } = freshFixture();
    fs.writeFileSync(runtime.pidfilePath(), '999999'); // dead pid
    fs.writeFileSync(socketPath, '');
    const report = runtime.bootCleanup();
    assert.equal(report.orphan_pid, null); // 999999 wasn't detected as alive
    assert.equal(report.stale_socket_removed, true);
    assert.ok(Array.isArray(report.old_epochs_removed));
    runtime.store.close();
});

test('detectOrphanPid: PID-reuse defense — mismatched signature returns null', () => {
    const { runtime } = freshFixture();
    // Record the test-runner process (a live pid) but with a bogus command
    // signature that cannot possibly match `ps -p <pid> -o command=`.
    fs.writeFileSync(runtime.pidfilePath(), `${process.pid}\n/definitely-not-a-real-binary-xyz\n`);
    assert.equal(runtime.detectOrphanPid(), null,
        'live PID with mismatched signature must NOT be returned (PID reuse defense)');
    runtime.store.close();
});

test('detectOrphanPid: legacy single-line pidfile (no signature) still works', () => {
    const { runtime } = freshFixture();
    // Old-format pidfile without the signature line. This can exist on the
    // first boot after the signature upgrade lands. detectOrphanPid must
    // still return the pid (skip signature check) rather than reject.
    fs.writeFileSync(runtime.pidfilePath(), `${process.pid}`);
    assert.equal(runtime.detectOrphanPid(), process.pid,
        'legacy pidfile without signature must still surface the pid');
    runtime.store.close();
});
