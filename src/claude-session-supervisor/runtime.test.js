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

test('detectOrphanPid returns pid if live+certain, null if absent/dead/uncertain', () => {
    const { runtime } = freshFixture();
    // No pidfile -> null
    assert.equal(runtime.detectOrphanPid(), null);

    // Pidfile with a live PID + valid signature → returns it.
    // Use recordPid so the current command's signature gets captured
    // correctly and probeOrphanStatus returns certain:true.
    runtime.recordPid(process.pid);
    assert.equal(runtime.detectOrphanPid(), process.pid);

    // Pidfile with a very unlikely-to-exist PID -> null
    fs.writeFileSync(runtime.pidfilePath(), '999999');
    assert.equal(runtime.detectOrphanPid(), null);

    // Legacy single-line pidfile (no signature) → UNCERTAIN → null
    // (post-pass-18: caller must use probeOrphanStatus to see the PID).
    fs.writeFileSync(runtime.pidfilePath(), String(process.pid));
    assert.equal(runtime.detectOrphanPid(), null,
        'unsigned legacy pidfile must not be trusted as confirmed orphan');
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

test('probeOrphanStatus: empty pidfile → certain:false (uncertain)', () => {
    const { runtime } = freshFixture();
    fs.writeFileSync(runtime.pidfilePath(), '');
    const probe = runtime.probeOrphanStatus();
    assert.equal(probe.pid, null);
    assert.equal(probe.certain, false);
    assert.equal(probe.reason, 'empty_pidfile');
    runtime.store.close();
});

test('probeOrphanStatus: unparseable pid → certain:false (uncertain)', () => {
    const { runtime } = freshFixture();
    fs.writeFileSync(runtime.pidfilePath(), 'garbage-not-a-number\n');
    const probe = runtime.probeOrphanStatus();
    assert.equal(probe.pid, null);
    assert.equal(probe.certain, false);
    assert.equal(probe.reason, 'unparseable_pid');
    runtime.store.close();
});

test('probeOrphanStatus: dead pid → certain:true (no orphan, confident)', () => {
    const { runtime } = freshFixture();
    fs.writeFileSync(runtime.pidfilePath(), '999999');
    const probe = runtime.probeOrphanStatus();
    assert.equal(probe.pid, null);
    assert.equal(probe.certain, true);
    runtime.store.close();
});

test('probeOrphanStatus: no pidfile → certain:true (no orphan, confident)', () => {
    const { runtime } = freshFixture();
    // no write; no pidfile exists
    const probe = runtime.probeOrphanStatus();
    assert.equal(probe.pid, null);
    assert.equal(probe.certain, true);
    runtime.store.close();
});

test('bootCleanup preserves pidfile on non-already_dead kill failure', () => {
    const { runtime } = freshFixture();
    // recordPid writes pid + signature so probe returns certain:true and
    // bootCleanup actually attempts the kill (the code path this test
    // covers). A raw single-line write would be treated as uncertain
    // under the new signature-required policy.
    runtime.recordPid(process.pid);
    const origKill = runtime.killOrphanPid.bind(runtime);
    runtime.killOrphanPid = () => ({ killed: false, reason: 'EPERM' });
    const report = runtime.bootCleanup();
    assert.equal(report.orphan_killed, false);
    assert.equal(report.orphan_kill_reason, 'EPERM');
    // Pidfile MUST still exist so the next boot can retry.
    assert.ok(fs.existsSync(runtime.pidfilePath()),
        'pidfile must survive a real kill failure');
    runtime.killOrphanPid = origKill;
    runtime.clearPidfile(); // cleanup
    runtime.store.close();
});

test('bootCleanup clears pidfile on already_dead (benign race)', () => {
    const { runtime } = freshFixture();
    runtime.recordPid(process.pid);
    const origKill = runtime.killOrphanPid.bind(runtime);
    runtime.killOrphanPid = () => ({ killed: false, reason: 'already_dead' });
    const report = runtime.bootCleanup();
    assert.equal(report.orphan_kill_reason, 'already_dead');
    // Pidfile should be cleared — orphan is gone, no reason to retry.
    assert.equal(fs.existsSync(runtime.pidfilePath()), false,
        'pidfile must be cleared when the orphan is benignly gone');
    runtime.killOrphanPid = origKill;
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

test('detectOrphanPid: legacy single-line pidfile (no signature) is treated as uncertain', () => {
    const { runtime } = freshFixture();
    // Old-format pidfile without the signature line can exist on the
    // first boot after the signature upgrade. Post-pass-18 policy:
    // treat as uncertain rather than trusting the bare PID, because we
    // can't confirm identity and SIGKILLing a reused PID would be worse
    // than a false-positive orphan_unsafe path. detectOrphanPid returns
    // null; the richer probeOrphanStatus surfaces the PID + certain:false.
    fs.writeFileSync(runtime.pidfilePath(), `${process.pid}`);
    assert.equal(runtime.detectOrphanPid(), null,
        'legacy pidfile without signature must NOT be trusted as confirmed orphan');
    const probe = runtime.probeOrphanStatus();
    assert.equal(probe.pid, process.pid);
    assert.equal(probe.certain, false);
    assert.equal(probe.reason, 'no_signature_recorded');
    runtime.store.close();
});
