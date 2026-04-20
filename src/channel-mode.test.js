const { test } = require('node:test');
const assert = require('node:assert/strict');

const { init } = require('./main/channel-mode');

function noop() {}

function createSubject({ scheduler = null, channelManager = null } = {}) {
    return init({
        crypto: {},
        fs: {},
        ChannelManager: function ChannelManager() {},
        Scheduler: function Scheduler() {},
        channelIpcPath: '/tmp/test-channel.sock',
        defaultActivityAssistantName: 'Operator',
        getStore: () => ({ get: () => [], set: noop }),
        getClaudeProcess: () => null,
        getIsAppQuitting: () => false,
        getChannelReplyPending: () => false,
        getLatestChannelActivity: () => null,
        getDynamicMemory: () => null,
        getChatStore: () => ({ addMessage: noop, loadMessages: () => [] }),
        getActiveClients: () => [],
        getPtyProcess: () => null,
        setPtyProcess: noop,
        setOutputBuffer: noop,
        getMainWindow: () => null,
        getTunnelState: () => ({}),
        logDebug: noop,
        getActivityAssistantName: () => 'Operator',
        syncStateWithRenderer: noop,
        setChannelActivity: noop,
        resetChannelActivity: noop,
        scheduleChannelIdle: noop,
        clearChannelRestartTimer: noop,
        clearChannelStartupTimer: noop,
        clearChannelConfirmTimers: noop,
        clearChannelIdleTimer: noop,
        stopClaudeDebugWatcher: noop,
        stopClaudeHookWatcher: noop,
        clearPid: noop,
        spawnClaudeCode: noop,
        killClaudeCode: noop,
        killOrphanClaudeIfAny: async () => ({ found: false }),
        startPty: noop,
        stageOutboundAttachments: () => [],
        stripAttachmentBytes: (value) => value,
        markOutboundAttachmentsForGc: noop,
        buildTransportChannelMessage: (message) => message,
        sendEncryptedOutput: noop,
        sendLocalChatEvent: noop,
        notifyAssistantReply: noop,
        outboundAttachmentsDir: '/tmp/outbound',
        initialChannelManager: channelManager,
        initialScheduler: scheduler,
    });
}

test('handleSchedulerRequest reports missing scheduler initialization', async () => {
    const responses = [];
    const subject = createSubject({
        channelManager: {
            sendSchedulerResponse: (...args) => responses.push(args),
        },
    });

    await subject.handleSchedulerRequest({
        callId: 'call-1',
        tool: 'ro_run_now',
        args: { id: 'job-1' },
    });

    assert.deepEqual(responses, [[
        'call-1',
        'Scheduler not initialized',
        true,
    ]]);
});

test('handleSchedulerRequest forwards ro_run_now to the scheduler and returns success', async () => {
    const responses = [];
    const runNowCalls = [];
    const subject = createSubject({
        scheduler: {
            runNow: async (id) => {
                runNowCalls.push(id);
                return true;
            },
        },
        channelManager: {
            sendSchedulerResponse: (...args) => responses.push(args),
        },
    });

    await subject.handleSchedulerRequest({
        callId: 'call-2',
        tool: 'ro_run_now',
        args: { id: 'job-42' },
    });

    assert.deepEqual(runNowCalls, ['job-42']);
    assert.deepEqual(responses, [[
        'call-2',
        'Job job-42 triggered manually.',
        false,
    ]]);
});

test('handleSchedulerRequest formats scheduler errors for the channel response', async () => {
    const responses = [];
    const subject = createSubject({
        scheduler: {
            runNow: async () => {
                throw new Error('boom');
            },
        },
        channelManager: {
            sendSchedulerResponse: (...args) => responses.push(args),
        },
    });

    await subject.handleSchedulerRequest({
        callId: 'call-3',
        tool: 'ro_run_now',
        args: { id: 'job-7' },
    });

    assert.deepEqual(responses, [[
        'call-3',
        'Error: boom',
        true,
    ]]);
});
