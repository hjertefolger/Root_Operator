const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { autoUpdater } = require('electron-updater');
const EventEmitter = require('events');

const STARTUP_CHECK_DELAY_MS = 15_000;
const PERIODIC_CHECK_MS = 6 * 60 * 60 * 1000;

function defaultState({ packaged }) {
    return {
        supported: packaged,
        status: packaged ? 'idle' : 'disabled',
        label: packaged ? 'Updates idle' : 'Updates unavailable',
        detail: packaged
            ? 'Root Operator has not checked for updates yet.'
            : 'Automatic updates are only available in the installed app.',
        currentVersion: app.getVersion(),
        availableVersion: '',
        downloadedVersion: '',
        progressPercent: 0,
        checkedAt: '',
        readyToInstall: false,
        canInstallNow: false,
        installBlockedReason: '',
        error: '',
    };
}

function usesPrereleaseFeed() {
    if (!app.isPackaged) {
        return false;
    }

    const updateConfigPath = path.join(process.resourcesPath, 'app-update.yml');

    try {
        const rawConfig = fs.readFileSync(updateConfigPath, 'utf8');
        return /^releaseType:\s*prerelease\s*$/m.test(rawConfig);
    } catch {
        return false;
    }
}

class AppUpdater extends EventEmitter {
    constructor({ packaged, logger, canInstallNow }) {
        super();
        this.packaged = packaged;
        this.logger = logger || console;
        this.canInstallNow = typeof canInstallNow === 'function'
            ? canInstallNow
            : () => ({ ok: true, reason: '' });
        this.state = defaultState({ packaged });
        this.started = false;
        this.startupTimer = null;
        this.interval = null;
    }

    start() {
        if (this.started) return;
        this.started = true;

        if (!this.packaged) {
            this.emitState();
            return;
        }

        const allowPrerelease = usesPrereleaseFeed();

        autoUpdater.autoDownload = true;
        autoUpdater.autoInstallOnAppQuit = false;
        autoUpdater.allowPrerelease = allowPrerelease;

        autoUpdater.logger = {
            info: (msg) => this.logger.info?.(`[UPDATER] ${msg}`),
            warn: (msg) => this.logger.warn?.(`[UPDATER] ${msg}`),
            error: (msg) => this.logger.error?.(`[UPDATER] ${msg}`),
            debug: (msg) => this.logger.info?.(`[UPDATER] ${msg}`),
        };

        this.logger.info?.(`[UPDATER] Feed mode: ${allowPrerelease ? 'prerelease' : 'stable'}`);

        autoUpdater.on('checking-for-update', () => {
            this.updateState({
                status: 'checking',
                label: 'Checking for updates',
                detail: 'Looking for a newer version of Root Operator.',
                error: '',
            });
        });

        autoUpdater.on('update-available', (info) => {
            this.updateState({
                status: 'available',
                availableVersion: info?.version || '',
                downloadedVersion: '',
                progressPercent: 0,
                readyToInstall: false,
                label: `Update ${info?.version || ''} available`.trim(),
                detail: 'Downloading update in the background.',
                error: '',
            });
        });

        autoUpdater.on('download-progress', (progress) => {
            const percent = Math.max(0, Math.min(100, Math.round(progress?.percent || 0)));
            this.updateState({
                status: 'downloading',
                progressPercent: percent,
                label: this.state.availableVersion
                    ? `Downloading ${this.state.availableVersion}`
                    : 'Downloading update',
                detail: `Downloading update in the background (${percent}%).`,
                error: '',
            });
        });

        autoUpdater.on('update-downloaded', (info) => {
            const gate = this.canInstallNow();
            this.updateState({
                status: 'downloaded',
                availableVersion: info?.version || this.state.availableVersion,
                downloadedVersion: info?.version || this.state.availableVersion,
                progressPercent: 100,
                readyToInstall: true,
                canInstallNow: gate.ok,
                installBlockedReason: gate.ok ? '' : gate.reason,
                label: info?.version
                    ? `Update ${info.version} ready`
                    : 'Update ready',
                detail: gate.ok
                    ? 'Restart Root Operator to install the update.'
                    : `Update is ready, but install is deferred: ${gate.reason}`,
                error: '',
            });
        });

        autoUpdater.on('update-not-available', () => {
            this.updateState({
                status: 'idle',
                availableVersion: '',
                downloadedVersion: '',
                progressPercent: 0,
                readyToInstall: false,
                canInstallNow: false,
                installBlockedReason: '',
                label: 'Up to date',
                detail: `Root Operator ${app.getVersion()} is current.`,
                checkedAt: new Date().toISOString(),
                error: '',
            });
        });

        autoUpdater.on('error', (error) => {
            const message = error?.message || String(error || 'Unknown updater error');
            this.updateState({
                status: 'error',
                label: 'Update error',
                detail: message,
                error: message,
            });
        });

        this.startupTimer = setTimeout(() => {
            this.checkForUpdates('startup');
        }, STARTUP_CHECK_DELAY_MS);

        this.interval = setInterval(() => {
            this.checkForUpdates('interval');
        }, PERIODIC_CHECK_MS);

        this.emitState();
    }

    stop() {
        if (this.startupTimer) {
            clearTimeout(this.startupTimer);
            this.startupTimer = null;
        }
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
    }

    getState() {
        return { ...this.state };
    }

    emitState() {
        this.emit('state', this.getState());
    }

    updateState(next) {
        this.state = {
            ...this.state,
            ...next,
            currentVersion: app.getVersion(),
        };
        this.emitState();
    }

    refreshInstallReadiness() {
        if (this.state.status !== 'downloaded') {
            return this.getState();
        }

        const gate = this.canInstallNow();
        this.updateState({
            canInstallNow: gate.ok,
            installBlockedReason: gate.ok ? '' : gate.reason,
            detail: gate.ok
                ? 'Restart Root Operator to install the update.'
                : `Update is ready, but install is deferred: ${gate.reason}`,
        });
        return this.getState();
    }

    async checkForUpdates(reason = 'manual') {
        if (!this.packaged) {
            return { started: false, reason: 'disabled' };
        }

        if (this.state.status === 'checking') {
            return { started: false, reason: 'already-checking' };
        }

        this.logger.info?.(`[UPDATER] Checking for updates (${reason})`);
        try {
            await autoUpdater.checkForUpdates();
            return { started: true };
        } catch (error) {
            const message = error?.message || String(error);
            this.updateState({
                status: 'error',
                label: 'Update error',
                detail: message,
                error: message,
            });
            return { started: false, reason: message };
        }
    }

    async installDownloadedUpdate() {
        if (!this.packaged) {
            return { success: false, error: 'Automatic updates are only available in the installed app.' };
        }

        if (this.state.status !== 'downloaded') {
            return { success: false, error: 'No downloaded update is ready to install.' };
        }

        const gate = this.canInstallNow();
        if (!gate.ok) {
            this.refreshInstallReadiness();
            return { success: false, blocked: true, error: gate.reason };
        }

        this.updateState({
            status: 'installing',
            label: 'Installing update',
            detail: 'Root Operator is restarting to install the update.',
            canInstallNow: true,
            installBlockedReason: '',
        });

        setImmediate(() => {
            autoUpdater.quitAndInstall();
        });

        return { success: true };
    }
}

module.exports = { AppUpdater, defaultUpdateState: defaultState };
