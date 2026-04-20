const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PIDFILE_NAME = 'supervisor.pidfile';
const DEFAULT_WAIT_MS = 2000;

function resolvePidfilePath(homeDir = process.env.HOME || os.homedir()) {
    return path.join(homeDir, '.root-operator', 'runtime', PIDFILE_NAME);
}

function readPidFromFile(pidfilePath, fsImpl = fs) {
    if (!fsImpl.existsSync(pidfilePath)) {
        return null;
    }

    const raw = fsImpl.readFileSync(pidfilePath, 'utf8').trim();
    if (!raw) {
        return null;
    }

    const pid = parseInt(raw.split('\n')[0].trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function readCommandForPid(pid, execFileSyncImpl = execFileSync) {
    return execFileSyncImpl('ps', ['-p', String(pid), '-o', 'command='], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
}

function isClaudeCommand(command) {
    const value = String(command || '').trim();
    if (!value) {
        return false;
    }

    return /(^|[\/\s])claude($|[\s"])/i.test(value);
}

function processExists(pid, processKill = process.kill.bind(process)) {
    try {
        processKill(pid, 0);
        return true;
    } catch (error) {
        if (error && error.code === 'ESRCH') {
            return false;
        }
        throw error;
    }
}

async function terminateClaudePid(pid, {
    processKill = process.kill.bind(process),
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    waitMs = DEFAULT_WAIT_MS,
} = {}) {
    try {
        processKill(pid, 'SIGTERM');
    } catch (error) {
        if (error && error.code === 'ESRCH') {
            return { killed: false, reason: 'already_dead' };
        }
        return { killed: false, reason: error.code || error.message };
    }

    await wait(waitMs);

    try {
        if (!processExists(pid, processKill)) {
            return { killed: true, signal: 'SIGTERM' };
        }
    } catch (error) {
        return { killed: false, reason: error.code || error.message };
    }

    try {
        processKill(pid, 'SIGKILL');
    } catch (error) {
        if (error && error.code === 'ESRCH') {
            return { killed: true, signal: 'SIGTERM' };
        }
        return { killed: false, reason: error.code || error.message };
    }

    try {
        if (!processExists(pid, processKill)) {
            return { killed: true, signal: 'SIGKILL' };
        }
    } catch (error) {
        return { killed: false, reason: error.code || error.message };
    }

    return { killed: false, reason: 'still_running' };
}

function recordPid(pid, { pidfilePath = resolvePidfilePath(), fsImpl = fs } = {}) {
    if (!Number.isInteger(pid) || pid <= 0) {
        return null;
    }

    fsImpl.mkdirSync(path.dirname(pidfilePath), { recursive: true });
    fsImpl.writeFileSync(pidfilePath, `${pid}\n`, 'utf8');
    return pidfilePath;
}

function clearPid({ pidfilePath = resolvePidfilePath(), fsImpl = fs } = {}) {
    try {
        fsImpl.unlinkSync(pidfilePath);
    } catch (error) {
        if (!error || error.code !== 'ENOENT') {
            throw error;
        }
    }
}

async function killOrphanClaudeIfAny({
    pidfilePath = resolvePidfilePath(),
    fsImpl = fs,
    execFileSyncImpl = execFileSync,
    processKill = process.kill.bind(process),
    wait,
    waitMs = DEFAULT_WAIT_MS,
} = {}) {
    const pid = readPidFromFile(pidfilePath, fsImpl);
    if (!pid) {
        clearPid({ pidfilePath, fsImpl });
        return { found: false, pid: null, killed: false, reason: 'no_pid' };
    }

    let command = '';
    try {
        command = readCommandForPid(pid, execFileSyncImpl);
    } catch (error) {
        const reason = error && error.code === 'ESRCH'
            ? 'not_running'
            : (error.code || error.message || 'ps_failed');
        clearPid({ pidfilePath, fsImpl });
        return { found: false, pid, killed: false, reason };
    }

    if (!command) {
        clearPid({ pidfilePath, fsImpl });
        return { found: false, pid, killed: false, reason: 'empty_command' };
    }

    if (!isClaudeCommand(command)) {
        clearPid({ pidfilePath, fsImpl });
        return { found: false, pid, killed: false, reason: 'not_claude', command };
    }

    const result = await terminateClaudePid(pid, {
        processKill,
        wait,
        waitMs,
    });
    clearPid({ pidfilePath, fsImpl });
    return {
        found: true,
        pid,
        command,
        ...result,
    };
}

module.exports = {
    killOrphanClaudeIfAny,
    recordPid,
    clearPid,
};
