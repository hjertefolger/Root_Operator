const cryptoModule = require('crypto');
const fsModule = require('fs');
const { ChannelManager: DefaultChannelManager } = require('../channel-manager');
const { Scheduler: DefaultScheduler } = require('../scheduler');

const DEFAULT_CHANNEL_IPC_PATH = '/tmp/root-operator-channel.sock';
const DEFAULT_ACTIVITY_ASSISTANT_NAME = 'Operator';
const DEFAULT_OPEN_WEBSOCKET_STATE = 1;

function requireFunction(name, value) {
    if (typeof value !== 'function') {
        throw new TypeError(`channel-mode.init expected function dependency: ${name}`);
    }
    return value;
}

function requireDependency(name, value) {
    if (value === undefined || value === null) {
        throw new TypeError(`channel-mode.init missing dependency: ${name}`);
    }
    return value;
}

function createStateAccessors(name, initialValue, getter, setter) {
    const hasGetter = typeof getter === 'function';
    const hasSetter = typeof setter === 'function';

    if (hasGetter !== hasSetter) {
        throw new TypeError(`channel-mode.init requires both getter and setter for state dependency: ${name}`);
    }

    if (hasGetter && hasSetter) {
        return {
            get: getter,
            set: setter,
        };
    }

    let currentValue = initialValue;
    return {
        get: () => currentValue,
        set: (nextValue) => {
            currentValue = nextValue;
            return currentValue;
        },
    };
}

function createInitialChannelRuntime(assistantName = DEFAULT_ACTIVITY_ASSISTANT_NAME) {
    return {
        phase: 'stopped',
        level: 'red',
        label: 'Chat offline',
        detail: `${assistantName} is not running.`,
        attempt: 0,
        claudeRunning: false,
        bridgeConnected: false,
        lastError: '',
    };
}

function isUsableWindow(window) {
    return Boolean(window && typeof window.isDestroyed === 'function' && !window.isDestroyed());
}

function toIterable(value) {
    if (!value || typeof value[Symbol.iterator] !== 'function') {
        return [];
    }
    return value;
}

function init(deps = {}) {
    const crypto = deps.crypto || cryptoModule;
    const fs = deps.fs || fsModule;
    const ChannelManager = deps.ChannelManager || DefaultChannelManager;
    const Scheduler = deps.Scheduler || DefaultScheduler;
    const channelIpcPath = deps.channelIpcPath || DEFAULT_CHANNEL_IPC_PATH;
    const defaultActivityAssistantName = deps.defaultActivityAssistantName || DEFAULT_ACTIVITY_ASSISTANT_NAME;
    const openWebSocketState = typeof deps.openWebSocketState === 'number'
        ? deps.openWebSocketState
        : (deps.WebSocket && typeof deps.WebSocket.OPEN === 'number'
            ? deps.WebSocket.OPEN
            : DEFAULT_OPEN_WEBSOCKET_STATE);

    requireDependency('crypto', crypto);
    requireDependency('fs', fs);
    requireDependency('ChannelManager', ChannelManager);
    requireDependency('Scheduler', Scheduler);

    const getStore = requireFunction('getStore', deps.getStore);
    const getClaudeProcess = requireFunction('getClaudeProcess', deps.getClaudeProcess);
    const getIsAppQuitting = requireFunction('getIsAppQuitting', deps.getIsAppQuitting);
    const getChannelReplyPending = requireFunction('getChannelReplyPending', deps.getChannelReplyPending);
    const getLatestChannelActivity = requireFunction('getLatestChannelActivity', deps.getLatestChannelActivity);
    const getDynamicMemory = requireFunction('getDynamicMemory', deps.getDynamicMemory);
    const getChatStore = requireFunction('getChatStore', deps.getChatStore);
    const getActiveClients = requireFunction('getActiveClients', deps.getActiveClients);
    const getPtyProcess = requireFunction('getPtyProcess', deps.getPtyProcess);
    const setPtyProcess = requireFunction('setPtyProcess', deps.setPtyProcess);
    const setOutputBuffer = requireFunction('setOutputBuffer', deps.setOutputBuffer);
    const getMainWindow = requireFunction('getMainWindow', deps.getMainWindow);
    const getTunnelState = requireFunction('getTunnelState', deps.getTunnelState);
    const logDebug = requireFunction('logDebug', deps.logDebug);
    const getActivityAssistantName = requireFunction('getActivityAssistantName', deps.getActivityAssistantName);
    const syncStateWithRenderer = requireFunction('syncStateWithRenderer', deps.syncStateWithRenderer);
    const setChannelActivity = requireFunction('setChannelActivity', deps.setChannelActivity);
    const resetChannelActivity = requireFunction('resetChannelActivity', deps.resetChannelActivity);
    const scheduleChannelIdle = requireFunction('scheduleChannelIdle', deps.scheduleChannelIdle);
    const clearChannelRestartTimer = requireFunction('clearChannelRestartTimer', deps.clearChannelRestartTimer);
    const clearChannelStartupTimer = requireFunction('clearChannelStartupTimer', deps.clearChannelStartupTimer);
    const clearChannelConfirmTimers = requireFunction('clearChannelConfirmTimers', deps.clearChannelConfirmTimers);
    const clearChannelIdleTimer = requireFunction('clearChannelIdleTimer', deps.clearChannelIdleTimer);
    const removeChannelSocket = typeof deps.removeChannelSocket === 'function'
        ? deps.removeChannelSocket
        : () => {
            try {
                if (fs.existsSync(channelIpcPath)) {
                    fs.unlinkSync(channelIpcPath);
                }
            } catch (error) {
                logDebug(`[CHANNEL] Failed to remove socket: ${error.message}`);
            }
        };
    const stopClaudeDebugWatcher = requireFunction('stopClaudeDebugWatcher', deps.stopClaudeDebugWatcher);
    const stopClaudeHookWatcher = requireFunction('stopClaudeHookWatcher', deps.stopClaudeHookWatcher);
    const clearPid = requireFunction('clearPid', deps.clearPid);
    const spawnClaudeCode = requireFunction('spawnClaudeCode', deps.spawnClaudeCode);
    const killClaudeCode = requireFunction('killClaudeCode', deps.killClaudeCode);
    const killOrphanClaudeIfAny = requireFunction('killOrphanClaudeIfAny', deps.killOrphanClaudeIfAny);
    const startPty = requireFunction('startPty', deps.startPty);
    const stageOutboundAttachments = requireFunction('stageOutboundAttachments', deps.stageOutboundAttachments);
    const stripAttachmentBytes = requireFunction('stripAttachmentBytes', deps.stripAttachmentBytes);
    const markOutboundAttachmentsForGc = requireFunction('markOutboundAttachmentsForGc', deps.markOutboundAttachmentsForGc);
    const buildTransportChannelMessage = requireFunction('buildTransportChannelMessage', deps.buildTransportChannelMessage);
    const sendEncryptedOutput = requireFunction('sendEncryptedOutput', deps.sendEncryptedOutput);
    const sendLocalChatEvent = requireFunction('sendLocalChatEvent', deps.sendLocalChatEvent);
    const notifyAssistantReply = requireFunction('notifyAssistantReply', deps.notifyAssistantReply);
    // Cursor companion routing — optional. If provided, replies whose
    // chat_id matches the companion's pending turn get forwarded to the
    // bubble window. Optional so existing tests + non-cursor builds keep
    // working without rewiring.
    const forwardToCursorCompanion = typeof deps.forwardToCursorCompanion === 'function'
        ? deps.forwardToCursorCompanion
        : null;

    // Agent action handler — optional. If provided, agent_* MCP tools
    // (motion + AX read/write) are dispatched here. Optional so tests
    // and Linux/Win builds keep working without it.
    const agentActionsHandler = (deps.agentActions && typeof deps.agentActions.handle === 'function')
        ? deps.agentActions
        : null;

    const outboundAttachmentsDir = requireDependency('outboundAttachmentsDir', deps.outboundAttachmentsDir);

    const operatingModeState = createStateAccessors(
        'operatingMode',
        deps.initialOperatingMode || 'channel',
        deps.getOperatingMode,
        deps.setOperatingModeState,
    );
    const channelManagerState = createStateAccessors(
        'channelManager',
        deps.initialChannelManager || null,
        deps.getChannelManager,
        deps.setChannelManager,
    );
    const schedulerState = createStateAccessors(
        'scheduler',
        deps.initialScheduler || null,
        deps.getScheduler,
        deps.setScheduler,
    );
    const channelRuntimeState = createStateAccessors(
        'channelRuntime',
        deps.initialChannelRuntime || createInitialChannelRuntime(defaultActivityAssistantName),
        deps.getChannelRuntime,
        deps.setChannelRuntimeState,
    );
    const channelStartupAttemptState = createStateAccessors(
        'channelStartupAttempt',
        Number.isInteger(deps.initialChannelStartupAttempt) ? deps.initialChannelStartupAttempt : 0,
        deps.getChannelStartupAttempt,
        deps.setChannelStartupAttempt,
    );

    function getOperatingMode() {
        return operatingModeState.get();
    }

    function setOperatingModeValue(mode) {
        return operatingModeState.set(mode);
    }

    function getChannelManager() {
        return channelManagerState.get();
    }

    function setChannelManager(manager) {
        return channelManagerState.set(manager);
    }

    function getScheduler() {
        return schedulerState.get();
    }

    function setScheduler(scheduler) {
        return schedulerState.set(scheduler);
    }

    function getChannelRuntime() {
        return channelRuntimeState.get();
    }

    function setChannelRuntimeState(runtime) {
        return channelRuntimeState.set(runtime);
    }

    function getChannelStartupAttempt() {
        return channelStartupAttemptState.get();
    }

    function setChannelStartupAttempt(value) {
        return channelStartupAttemptState.set(value);
    }

    function resolveAssistantName() {
        const assistantName = getActivityAssistantName();
        return typeof assistantName === 'string' && assistantName.trim()
            ? assistantName.trim()
            : defaultActivityAssistantName;
    }

    function getOpenClients() {
        const clients = [];
        for (const client of toIterable(getActiveClients())) {
            if (client && client.readyState === openWebSocketState) {
                clients.push(client);
            }
        }
        return clients;
    }

    function setChannelRuntime(phase, detail, extra = {}) {
        const assistantName = resolveAssistantName();
        const phaseConfig = {
            stopped: { level: 'red', label: 'Chat offline' },
            starting: { level: 'orange', label: `Starting ${assistantName}` },
            waiting_confirm: { level: 'orange', label: 'Waiting for confirmation' },
            waiting_bridge: { level: 'orange', label: 'Waiting for chat bridge' },
            retrying: { level: 'orange', label: 'Retrying chat startup' },
            ready: { level: 'green', label: 'Chat ready' },
            error: { level: 'red', label: 'Chat unavailable' },
        };

        const nextRuntime = {
            ...(getChannelRuntime() || createInitialChannelRuntime(defaultActivityAssistantName)),
            ...(phaseConfig[phase] || {}),
            ...extra,
            phase,
            detail,
            claudeRunning: !!getClaudeProcess(),
            bridgeConnected: !!(getChannelManager() && getChannelManager().connected),
        };

        setChannelRuntimeState(nextRuntime);
        syncStateWithRenderer();
        return nextRuntime;
    }

    function getChannelStatus() {
        return {
            ...(getChannelRuntime() || createInitialChannelRuntime(defaultActivityAssistantName)),
            assistantName: resolveAssistantName(),
            claudeRunning: !!getClaudeProcess(),
            bridgeConnected: !!(getChannelManager() && getChannelManager().connected),
            socketExists: fs.existsSync(channelIpcPath),
            activity: getLatestChannelActivity(),
        };
    }

    function handleClaudeReply(reply = {}) {
        const replyTs = reply.ts || new Date().toISOString();
        const replyChatId = reply.chat_id || reply.chatId || null;
        const attachmentRef = Array.isArray(reply.attachments) && reply.attachments.length > 0
            ? `reply-${crypto.randomUUID()}`
            : null;
        let stagedAttachments = [];

        try {
            if (attachmentRef) {
                stagedAttachments = stageOutboundAttachments({
                    outboundDir: outboundAttachmentsDir,
                    effectId: attachmentRef,
                    attachments: reply.attachments,
                });
            }

            const message = {
                type: 'channel_message',
                role: 'assistant',
                content: reply.text,
                ts: replyTs,
            };

            if (attachmentRef) {
                message.external_ref = attachmentRef;
                message.attachments = stripAttachmentBytes(stagedAttachments);
            }

            const chatStore = getChatStore();
            const assistantWrite = chatStore.addMessage(
                {
                    role: message.role,
                    content: message.content,
                    ts: message.ts,
                    attachments: message.attachments,
                },
                attachmentRef ? { externalRef: attachmentRef } : undefined,
            );
            markOutboundAttachmentsForGc(assistantWrite && assistantWrite.evicted);

            const dynamicMemory = getDynamicMemory();
            if (dynamicMemory && dynamicMemory.isReady()) {
                dynamicMemory.indexMessage(
                    'assistant',
                    message.content,
                    replyChatId,
                    attachmentRef ? { externalRef: attachmentRef } : undefined,
                ).catch((error) => {
                    logDebug(`[MEMORY] Index (assistant) error: ${error.message}`);
                });
            }

            for (const client of getOpenClients()) {
                sendEncryptedOutput(client, JSON.stringify(buildTransportChannelMessage(message, {
                    supportsAttachments: client.supportsAttachments === true,
                })));
            }

            sendLocalChatEvent(buildTransportChannelMessage(message));
            notifyAssistantReply(message);
            // Forward every reply to cursor companion. Presence is a
            // fan-out surface; the companion decides internally whether
            // a reply also belongs to its local pending-turn state.
            // Order: AFTER persistence and notifications so the cursor
            // bubble can't receive a reply before the chat history records it.
            if (forwardToCursorCompanion) {
                try {
                    forwardToCursorCompanion({
                        content: message.content,
                        ts: message.ts,
                        role: message.role,
                        chatId: replyChatId,
                    });
                } catch (error) {
                    logDebug(`[CHANNEL] forwardToCursorCompanion failed: ${error.message}`);
                }
            }
            scheduleChannelIdle();
        } catch (error) {
            for (const attachment of stagedAttachments) {
                if (attachment.created && attachment.stagedPath && fs.existsSync(attachment.stagedPath)) {
                    try {
                        fs.unlinkSync(attachment.stagedPath);
                    } catch {
                        // Ignore cleanup errors after the original failure.
                    }
                }
            }

            logDebug(`[CHANNEL] Failed to process Claude reply: ${error.message}`);
        }
    }

    function handleChannelConnected() {
        const assistantName = resolveAssistantName();
        logDebug('[CHANNEL] Bridge connected');
        clearChannelStartupTimer();
        clearChannelConfirmTimers();
        setChannelRuntime('ready', `${assistantName} is connected and ready to send replies.`, {
            attempt: getChannelStartupAttempt(),
            lastError: '',
        });
    }

    function handleChannelDisconnected() {
        if (getOperatingMode() !== 'channel' || getIsAppQuitting()) {
            return;
        }

        const assistantName = resolveAssistantName();
        const detail = getClaudeProcess()
            ? `The chat bridge dropped. Waiting for ${assistantName} to bring it back.`
            : `The chat bridge dropped because ${assistantName} is no longer running.`;

        setChannelRuntime('waiting_bridge', detail, {
            attempt: getChannelStartupAttempt(),
        });

        if (getChannelReplyPending()) {
            setChannelActivity({
                phase: 'waiting_bridge',
                label: 'Waiting for bridge',
                detail,
            }, { force: true });
        }
    }

    function handleChannelReconnecting() {
        if (getOperatingMode() !== 'channel' || getIsAppQuitting()) {
            return;
        }

        setChannelRuntime('retrying', 'Trying to reconnect the chat bridge.', {
            attempt: getChannelStartupAttempt(),
        });

        if (getChannelReplyPending()) {
            setChannelActivity({
                phase: 'retrying',
                label: 'Reconnecting bridge',
                detail: `Trying to reconnect the ${resolveAssistantName()} chat bridge.`,
            }, { force: true });
        }
    }

    function handleChannelSocketError(error) {
        if (getOperatingMode() !== 'channel' || getIsAppQuitting()) {
            return;
        }

        logDebug(`[CHANNEL] Socket error: ${error && error.message ? error.message : String(error)}`);
    }

    function handleChannelActivity(activity) {
        if (getOperatingMode() !== 'channel' || !activity) {
            return;
        }

        if (activity.phase === 'forwarded') {
            const assistantName = resolveAssistantName();
            setChannelActivity({
                phase: 'forwarded',
                label: `Delivered to ${assistantName}`,
                detail: `The chat bridge handed your message to ${assistantName}.`,
                ts: activity.ts,
            }, { force: true });
            return;
        }

        if (activity.phase === 'replying') {
            const assistantName = resolveAssistantName();
            setChannelActivity({
                phase: 'replying',
                label: `${assistantName} is sending the reply`,
                detail: `${assistantName} is sending the final answer back to chat.`,
                ts: activity.ts,
                toolName: activity.toolName,
            }, { force: true });
            return;
        }

        setChannelActivity(activity);
    }

    function createChannelManager() {
        const manager = new ChannelManager(channelIpcPath);
        manager.on('claude_reply', handleClaudeReply);
        manager.on('connected', handleChannelConnected);
        manager.on('disconnected', handleChannelDisconnected);
        manager.on('reconnecting', handleChannelReconnecting);
        manager.on('socket_error', handleChannelSocketError);
        manager.on('claude_activity', handleChannelActivity);
        manager.on('scheduler_request', (req) => {
            handleSchedulerRequest(req);
        });
        manager.on('memory_request', (req) => {
            handleMemoryRequest(req);
        });
        manager.on('agent_request', (req) => {
            handleAgentRequest(req);
        });
        return manager;
    }

    async function handleAgentRequest(req) {
        const channelManager = getChannelManager();
        if (!agentActionsHandler) {
            channelManager?.sendAgentResponse(req.callId, 'Agent actions are not available on this build.', true);
            return;
        }
        try {
            const { result, isError } = await agentActionsHandler.handle(req);
            channelManager?.sendAgentResponse(req.callId, result || '(no result)', !!isError);
        } catch (error) {
            channelManager?.sendAgentResponse(req.callId, `Agent action error: ${error.message}`, true);
        }
    }

    function initChannelMode() {
        clearChannelRestartTimer();

        const existingManager = getChannelManager();
        if (existingManager) {
            existingManager.disconnect();
            setChannelManager(null);
        }

        const manager = createChannelManager();
        setChannelManager(manager);
        manager.connect();

        const store = getStore();
        if (store) {
            const nextScheduler = new Scheduler(store, manager);
            setScheduler(nextScheduler);
            nextScheduler.start();
        }

        Promise.resolve()
            .then(() => killOrphanClaudeIfAny())
            .then((result) => {
                if (!result) {
                    return;
                }

                if (result.found && result.killed) {
                    logDebug(`[CLAUDE] Killed orphan Claude pid=${result.pid} with ${result.signal}`);
                } else if (result.found) {
                    logDebug(`[CLAUDE] Found orphan Claude pid=${result.pid} but cleanup ended with ${result.reason || 'unknown'}`);
                }
            })
            .catch((error) => {
                logDebug(`[CLAUDE] Orphan cleanup failed: ${error.message}`);
            })
            .finally(() => {
                spawnClaudeCode();
            });

        return manager;
    }

    async function handleSchedulerRequest(req) {
        const scheduler = getScheduler();
        const channelManager = getChannelManager();

        if (!scheduler) {
            channelManager?.sendSchedulerResponse(req.callId, 'Scheduler not initialized', true);
            return;
        }

        try {
            let result;
            switch (req.tool) {
                case 'ro_schedule': {
                    const created = await scheduler.addJob({
                        name: req.args.name,
                        cronExpr: req.args.cron,
                        prompt: req.args.prompt,
                        chatId: req.args.chat_id,
                    });
                    result = `Job created: "${created.name}" (${created.id})\nSchedule: ${created.cron}\nNext fire at the scheduled time.`;
                    break;
                }

                case 'ro_list_schedules': {
                    const jobs = scheduler.listJobs();
                    if (jobs.length === 0) {
                        result = 'No scheduled jobs.';
                    } else {
                        result = jobs.map((job) => {
                            let status = job.enabled ? '●' : '○';
                            if (job.running) {
                                status = '▶';
                            }

                            let line = `${status} ${job.name} (${job.id})`;
                            line += `\n  Schedule: ${job.cron}`;
                            line += `\n  Last run: ${job.lastRun || 'never'}`;
                            if (job.lastResult) {
                                line += ` (${job.lastResult})`;
                            }
                            if (job.lastError) {
                                line += `\n  Last error: ${job.lastError}`;
                            }
                            if (job.consecutiveErrors > 0) {
                                line += `\n  Consecutive errors: ${job.consecutiveErrors}`;
                            }
                            line += `\n  Prompt: ${job.prompt}`;
                            return line;
                        }).join('\n\n');
                    }
                    break;
                }

                case 'ro_delete_schedule':
                    await scheduler.removeJob(req.args.id);
                    result = `Job ${req.args.id} deleted.`;
                    break;

                case 'ro_toggle_schedule': {
                    const toggled = await scheduler.toggleJob(req.args.id, req.args.enabled);
                    result = `Job "${toggled.name}" is now ${toggled.enabled ? 'enabled' : 'disabled'}.`;
                    break;
                }

                case 'ro_run_now':
                    await scheduler.runNow(req.args.id);
                    result = `Job ${req.args.id} triggered manually.`;
                    break;

                default:
                    result = `Unknown scheduler tool: ${req.tool}`;
                    break;
            }

            channelManager?.sendSchedulerResponse(req.callId, result, false);
        } catch (error) {
            channelManager?.sendSchedulerResponse(req.callId, `Error: ${error.message}`, true);
        }
    }

    async function handleMemoryRequest(req) {
        const channelManager = getChannelManager();
        const dynamicMemory = getDynamicMemory();

        if (!dynamicMemory || !dynamicMemory.isReady()) {
            channelManager?.sendMemoryResponse(
                req.callId,
                'Dynamic memory is not ready. Try again once the app has finished initializing.',
                true
            );
            return;
        }

        try {
            let result;
            switch (req.tool) {
                case 'ro_memory_search': {
                    const query = String(req.args?.query || '').trim();
                    if (!query) {
                        channelManager?.sendMemoryResponse(req.callId, 'Query is required.', true);
                        return;
                    }
                    const limit = Math.max(1, Math.min(25, Number(req.args?.limit) || 5));
                    const chatId = req.args?.chat_id !== undefined ? req.args.chat_id : undefined;
                    // Scope retrieval to memories older than the channel-history
                    // tail already injected into the system prompt, so recall
                    // surfaces context the agent does not already have.
                    let beforeTimestamp = null;
                    try {
                        const chatStore = getChatStore();
                        beforeTimestamp = chatStore?.getOldestTimestamp?.() || null;
                    } catch (_) {
                        beforeTimestamp = null;
                    }
                    const results = await dynamicMemory.searchMemory(query, { chatId, limit, beforeTimestamp });

                    if (!results.length) {
                        result = `No matches for "${query}".`;
                    } else {
                        result = results.map((r) => {
                            const ts = r.timestamp instanceof Date
                                ? r.timestamp.toISOString()
                                : String(r.timestamp);
                            const score = typeof r.score === 'number' ? r.score.toFixed(3) : '?';
                            return `[id=${r.id} score=${score} ts=${ts} role=${r.sourceRole || '?'}]\n${r.content}`;
                        }).join('\n\n---\n\n');
                    }
                    break;
                }

                case 'ro_memory_save': {
                    const content = String(req.args?.content || '').trim();
                    if (!content) {
                        channelManager?.sendMemoryResponse(req.callId, 'Content is required.', true);
                        return;
                    }
                    const chatId = req.args?.chat_id !== undefined ? req.args.chat_id : null;
                    const { id, isDuplicate, existingChatId } = await dynamicMemory.saveMemory(content, { chatId });
                    if (isDuplicate) {
                        const chatNote = (chatId && existingChatId && existingChatId !== chatId)
                            ? ` (existing row belongs to chat=${existingChatId}, not chat=${chatId})`
                            : '';
                        result = `Memory already existed as id=${id} (content-hash match, not re-saved)${chatNote}.`;
                    } else {
                        result = `Saved as id=${id}.`;
                    }
                    break;
                }

                case 'ro_memory_update': {
                    const id = Number(req.args?.id);
                    const content = String(req.args?.content || '').trim();
                    if (!Number.isFinite(id) || id <= 0) {
                        channelManager?.sendMemoryResponse(req.callId, 'A positive numeric id is required.', true);
                        return;
                    }
                    if (!content) {
                        channelManager?.sendMemoryResponse(req.callId, 'Content is required.', true);
                        return;
                    }
                    const updateResult = await dynamicMemory.updateMemoryById(id, content);
                    if (updateResult && updateResult.conflictId) {
                        result = `Cannot update id=${id}: content conflicts with existing memory id=${updateResult.conflictId} (same content-hash).`;
                    } else if (updateResult && updateResult.ok) {
                        result = `Memory id=${id} updated.`;
                    } else {
                        result = `No memory with id=${id} — nothing updated.`;
                    }
                    break;
                }

                case 'ro_memory_delete': {
                    const id = Number(req.args?.id);
                    if (!Number.isFinite(id) || id <= 0) {
                        channelManager?.sendMemoryResponse(req.callId, 'A positive numeric id is required.', true);
                        return;
                    }
                    const deleted = dynamicMemory.deleteMemoryById(id);
                    result = deleted
                        ? `Memory id=${id} deleted.`
                        : `No memory with id=${id} — nothing deleted.`;
                    break;
                }

                default:
                    result = `Unknown memory tool: ${req.tool}`;
                    break;
            }

            channelManager?.sendMemoryResponse(req.callId, result, false);
        } catch (error) {
            channelManager?.sendMemoryResponse(req.callId, `Error: ${error.message}`, true);
        }
    }

    function teardownChannelMode() {
        clearChannelRestartTimer();
        clearChannelStartupTimer();
        clearChannelConfirmTimers();
        clearChannelIdleTimer();

        const scheduler = getScheduler();
        if (scheduler) {
            scheduler.stopAll();
            setScheduler(null);
        }

        if (getClaudeProcess()) {
            killClaudeCode();
        }

        clearPid();

        const channelManager = getChannelManager();
        if (channelManager) {
            channelManager.disconnect();
            setChannelManager(null);
        }

        removeChannelSocket();
        stopClaudeDebugWatcher();
        stopClaudeHookWatcher();
        setChannelStartupAttempt(0);
        resetChannelActivity();
        setChannelRuntime('stopped', 'Chat mode is not active.');
    }

    function setOperatingMode(mode) {
        if (mode === getOperatingMode()) {
            return getOperatingMode();
        }

        setOperatingModeValue(mode);
        logDebug(`[MODE] Switching to ${mode} mode`);

        if (mode === 'channel') {
            const ptyProcess = getPtyProcess();
            if (ptyProcess) {
                ptyProcess.kill();
                setPtyProcess(null);
                setOutputBuffer('');
            }
            initChannelMode();
        } else {
            teardownChannelMode();

            const activeClients = Array.from(toIterable(getActiveClients()));
            if (activeClients.length > 0 && !getPtyProcess()) {
                startPty(activeClients[0]);
            }
        }

        for (const client of getOpenClients()) {
            client.send(JSON.stringify({
                type: 'operating_mode',
                mode: getOperatingMode(),
            }));
        }

        const mainWindow = getMainWindow();
        if (isUsableWindow(mainWindow)) {
            mainWindow.webContents.send('SYNC_STATE', getTunnelState());
        }

        return getOperatingMode();
    }

    return {
        getOperatingMode,
        getChannelManager,
        getScheduler,
        getChannelRuntime,
        setChannelRuntime,
        getChannelStatus,
        handleClaudeReply,
        initChannelMode,
        handleSchedulerRequest,
        teardownChannelMode,
        setOperatingMode,
    };
}

module.exports = {
    DEFAULT_ACTIVITY_ASSISTANT_NAME,
    DEFAULT_CHANNEL_IPC_PATH,
    createInitialChannelRuntime,
    init,
};
