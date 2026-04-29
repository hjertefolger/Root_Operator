const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function defaultLog() {}

function resolveHelperPath(app, explicitPath) {
    if (explicitPath) return explicitPath;
    if (process.env.RO_CURSOR_POINTER_TAP) return process.env.RO_CURSOR_POINTER_TAP;

    if (process.defaultApp || !app || !app.isPackaged) {
        const root = app && typeof app.getAppPath === 'function'
            ? app.getAppPath()
            : path.join(__dirname, '..', '..');
        return path.join(root, 'build', 'native', 'cursor-pointer-tap');
    }

    return path.join(process.resourcesPath, 'cursor-pointer-tap');
}

function parseLines(buffer, chunk, onLine) {
    let next = buffer + chunk.toString('utf8');
    let index = next.indexOf('\n');
    while (index !== -1) {
        const line = next.slice(0, index).trim();
        next = next.slice(index + 1);
        if (line) onLine(line);
        index = next.indexOf('\n');
    }
    return next;
}

function createPointerGestureTap({
    app,
    helperPath,
    logDebug = defaultLog,
    onRightMouseDown = defaultLog,
    onWheel = defaultLog,
} = {}) {
    let child = null;
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let capture = { right: false, wheel: false };

    function writeCapture() {
        if (!child || !child.stdin || child.stdin.destroyed) return;
        child.stdin.write(`right=${capture.right ? 1 : 0} wheel=${capture.wheel ? 1 : 0}\n`);
    }

    function handleLine(line) {
        let event;
        try {
            event = JSON.parse(line);
        } catch (err) {
            logDebug(`[CURSOR] pointer tap emitted invalid JSON: ${line}`);
            return;
        }

        if (event.type === 'ready') {
            writeCapture();
            return;
        }
        if (event.type === 'rightMouseDown') {
            onRightMouseDown(event);
            return;
        }
        if (event.type === 'wheel') {
            onWheel(event);
            return;
        }
        if (event.type === 'error') {
            logDebug(`[CURSOR] pointer tap error: ${event.message || 'unknown'}`);
        }
    }

    function start() {
        if (process.platform !== 'darwin') return false;
        if (child) return true;

        const bin = resolveHelperPath(app, helperPath);
        if (!fs.existsSync(bin)) {
            logDebug(`[CURSOR] pointer tap helper missing at ${bin}`);
            return false;
        }

        child = spawn(bin, [], {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });

        child.stdout.on('data', (chunk) => {
            stdoutBuffer = parseLines(stdoutBuffer, chunk, handleLine);
        });
        child.stderr.on('data', (chunk) => {
            stderrBuffer = parseLines(stderrBuffer, chunk, (line) => {
                logDebug(`[CURSOR] pointer tap stderr: ${line}`);
            });
        });
        child.on('error', (err) => {
            logDebug(`[CURSOR] pointer tap spawn failed: ${err.message}`);
        });
        child.on('exit', (code, signal) => {
            if (code !== 0 && code !== null) {
                logDebug(`[CURSOR] pointer tap exited with code ${code}`);
            } else if (signal) {
                logDebug(`[CURSOR] pointer tap exited with signal ${signal}`);
            }
            child = null;
            stdoutBuffer = '';
            stderrBuffer = '';
        });

        writeCapture();
        return true;
    }

    function setCapture(next = {}) {
        capture = {
            right: Boolean(next.right),
            wheel: Boolean(next.wheel),
        };
        if (!child) start();
        writeCapture();
    }

    function stop() {
        if (!child) return;
        const current = child;
        child = null;
        try {
            if (current.stdin && !current.stdin.destroyed) {
                current.stdin.write('quit\n');
                current.stdin.end();
            }
        } catch (_) {}
        setTimeout(() => {
            if (!current.killed) {
                try { current.kill('SIGTERM'); } catch (_) {}
            }
        }, 200).unref?.();
    }

    return {
        start,
        setCapture,
        stop,
        isRunning: () => Boolean(child),
        getCapture: () => ({ ...capture }),
    };
}

module.exports = {
    createPointerGestureTap,
};
