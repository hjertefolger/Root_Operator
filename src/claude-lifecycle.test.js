const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { init } = require('./main/claude-lifecycle');

function noop() {}

function createMemoryStore() {
    const values = new Map();
    return {
        get(key, fallback) {
            return values.has(key) ? values.get(key) : fallback;
        },
        set(key, value) {
            values.set(key, value);
        },
    };
}

function createSubject({ rootDir, store }) {
    return init({
        app: {
            getPath(name) {
                if (name === 'home') {
                    return path.join(rootDir, 'home');
                }

                throw new Error(`Unexpected app.getPath(${name})`);
            },
        },
        fs,
        path,
        pty: {},
        appDir: rootDir,
        channelIpcPath: path.join(rootDir, 'channel.sock'),
        workspaceDir: path.join(rootDir, 'workspace'),
        ensureWorkspace: () => ({ missingTemplateFiles: [] }),
        ensureAttachmentsDir: noop,
        writeSystemPromptFile: noop,
        writeProjectMcpConfig: noop,
        getStore: () => store,
        getActivityAssistantName: () => 'Operator',
        getOperatingMode: () => 'channel',
        getIsAppQuitting: () => false,
        getChannelReplyPending: () => false,
        getChannelManager: () => null,
        getClaudeProcess: () => null,
        setClaudeProcess: noop,
        getChannelStartupTimer: () => null,
        setChannelStartupTimer: noop,
        getChannelRestartTimer: () => null,
        setChannelRestartTimer: noop,
        getChannelConfirmTimers: () => [],
        setChannelConfirmTimers: noop,
        getChannelStartupAttempt: () => 0,
        setChannelStartupAttempt: noop,
        setChannelRuntime: noop,
        setChannelActivity: noop,
        resetChannelActivity: noop,
        startClaudeDebugWatcher: noop,
        stopClaudeDebugWatcher: noop,
        startClaudeHookWatcher: noop,
        stopClaudeHookWatcher: noop,
        logDebug: noop,
    });
}

test('prepareStartupEnvironment removes legacy supervisor DBs only once', async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-claude-lifecycle-'));
    const store = createMemoryStore();
    const workspaceBrainDir = path.join(rootDir, 'workspace', 'brain');
    const runtimeDir = path.join(rootDir, 'home', '.root-operator', 'runtime', 'epoch-1');
    fs.mkdirSync(workspaceBrainDir, { recursive: true });
    fs.mkdirSync(runtimeDir, { recursive: true });

    const workspaceDb = path.join(workspaceBrainDir, 'supervisor.db');
    const runtimeDb = path.join(runtimeDir, 'claude-supervisor.db');
    fs.writeFileSync(workspaceDb, 'old-workspace-db');
    fs.writeFileSync(runtimeDb, 'old-runtime-db');

    const subject = createSubject({ rootDir, store });

    try {
        await subject.prepareStartupEnvironment(async () => {});

        assert.equal(fs.existsSync(workspaceDb), false);
        assert.equal(fs.existsSync(runtimeDb), false);
        assert.equal(store.get('legacy-supervisor-cleanup-complete', false), true);

        fs.writeFileSync(workspaceDb, 'should-stay');
        await subject.prepareStartupEnvironment(async () => {});

        assert.equal(fs.existsSync(workspaceDb), true);
    } finally {
        fs.rmSync(rootDir, { recursive: true, force: true });
    }
});
