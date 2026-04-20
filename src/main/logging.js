const fs = require('fs');

// The log file path is set after app startup because userData is resolved at runtime.
function init(deps = {}) {
    const {
        fs: fsImpl = fs,
        getStore = () => null,
        maxSizeBytes = 1024 * 1024,
        maxFiles = 3,
        now = () => new Date(),
    } = deps;

    let logFile = null;

    function setLogFile(nextLogFile) {
        logFile = nextLogFile || null;
        return logFile;
    }

    function getLogFile() {
        return logFile;
    }

    function isDebugLoggingEnabled() {
        const store = typeof getStore === 'function' ? getStore() : null;
        if (!store) {
            return false;
        }

        const settings = store.get('cfSettings', {});
        return settings.debugLogging === true;
    }

    function rotateLogIfNeeded() {
        try {
            if (!logFile || !fsImpl.existsSync(logFile)) {
                return;
            }

            const stats = fsImpl.statSync(logFile);
            if (stats.size < maxSizeBytes) {
                return;
            }

            for (let i = maxFiles - 1; i >= 1; i -= 1) {
                const oldFile = `${logFile}.${i}`;
                const newFile = `${logFile}.${i + 1}`;
                if (!fsImpl.existsSync(oldFile)) {
                    continue;
                }

                if (i === maxFiles - 1) {
                    fsImpl.unlinkSync(oldFile);
                } else {
                    fsImpl.renameSync(oldFile, newFile);
                }
            }

            fsImpl.renameSync(logFile, `${logFile}.1`);
        } catch {
            // Ignore rotation errors to keep debug logging best-effort.
        }
    }

    function logDebug(message, metadata) {
        if (!isDebugLoggingEnabled() || !logFile) {
            return;
        }

        rotateLogIfNeeded();

        const time = now().toISOString();
        let metadataSuffix = '';
        if (metadata !== undefined) {
            try {
                metadataSuffix = ` ${JSON.stringify(metadata)}`;
            } catch {
                metadataSuffix = ' {"logMetadata":"unserializable"}';
            }
        }

        const line = `[${time}] ${message}${metadataSuffix}\n`;
        try {
            fsImpl.appendFileSync(logFile, line);
        } catch {
            // Ignore write errors to keep debug logging best-effort.
        }
    }

    return {
        getLogFile,
        setLogFile,
        isDebugLoggingEnabled,
        rotateLogIfNeeded,
        logDebug,
    };
}

module.exports = {
    init,
};
