const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { killOrphanClaudeIfAny, recordPid, clearPid } = require('./orphan-kill');

function freshFixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-kill-test-'));
    const pidfilePath = path.join(dir, 'supervisor.pidfile');
    return { dir, pidfilePath };
}

test('recordPid writes the pidfile and clearPid removes it', () => {
    const { pidfilePath } = freshFixture();

    recordPid(4321, { pidfilePath, fsImpl: fs });
    assert.equal(fs.readFileSync(pidfilePath, 'utf8'), '4321\n');

    clearPid({ pidfilePath, fsImpl: fs });
    assert.equal(fs.existsSync(pidfilePath), false);
});

test('killOrphanClaudeIfAny ignores non-Claude processes and clears the pidfile', async () => {
    const { pidfilePath } = freshFixture();
    recordPid(111, { pidfilePath, fsImpl: fs });

    const result = await killOrphanClaudeIfAny({
        pidfilePath,
        fsImpl: fs,
        execFileSyncImpl: () => '/usr/bin/node some-script.js\n',
    });

    assert.deepEqual(result, {
        found: false,
        pid: 111,
        killed: false,
        reason: 'not_claude',
        command: '/usr/bin/node some-script.js',
    });
    assert.equal(fs.existsSync(pidfilePath), false);
});

test('killOrphanClaudeIfAny terminates a matching Claude pid and falls back to SIGKILL', async () => {
    const { pidfilePath } = freshFixture();
    recordPid(222, { pidfilePath, fsImpl: fs });

    const signals = [];
    let alive = true;
    const processKill = (pid, signal) => {
        assert.equal(pid, 222);
        signals.push(signal);
        if (signal === 0) {
            if (!alive) {
                const error = new Error('not running');
                error.code = 'ESRCH';
                throw error;
            }
            return;
        }
        if (signal === 'SIGKILL') {
            alive = false;
        }
    };

    const result = await killOrphanClaudeIfAny({
        pidfilePath,
        fsImpl: fs,
        execFileSyncImpl: () => '/usr/local/bin/claude --dangerously-skip-permissions\n',
        processKill,
        wait: async () => {},
    });

    assert.deepEqual(result, {
        found: true,
        pid: 222,
        command: '/usr/local/bin/claude --dangerously-skip-permissions',
        killed: true,
        signal: 'SIGKILL',
    });
    assert.deepEqual(signals, ['SIGTERM', 0, 'SIGKILL', 0]);
    assert.equal(fs.existsSync(pidfilePath), false);
});

test('killOrphanClaudeIfAny clears stale pidfiles when the pid is already gone', async () => {
    const { pidfilePath } = freshFixture();
    recordPid(333, { pidfilePath, fsImpl: fs });

    const result = await killOrphanClaudeIfAny({
        pidfilePath,
        fsImpl: fs,
        execFileSyncImpl: () => {
            const error = new Error('missing process');
            error.code = 'ESRCH';
            throw error;
        },
    });

    assert.deepEqual(result, {
        found: false,
        pid: 333,
        killed: false,
        reason: 'not_running',
    });
    assert.equal(fs.existsSync(pidfilePath), false);
});
