const DEFAULT_ACTIVITY_ASSISTANT_NAME = 'Operator';

function requireDependency(name, value) {
    if (value === undefined || value === null) {
        throw new TypeError(`local-chat.init missing dependency: ${name}`);
    }

    return value;
}

function requireFunction(name, value) {
    if (typeof value !== 'function') {
        throw new TypeError(`local-chat.init expected function dependency: ${name}`);
    }

    return value;
}

function requireNumber(name, value) {
    if (!Number.isFinite(value)) {
        throw new TypeError(`local-chat.init expected numeric dependency: ${name}`);
    }

    return value;
}

function isUsableWindow(targetWindow) {
    return Boolean(
        targetWindow
        && typeof targetWindow.isDestroyed === 'function'
        && !targetWindow.isDestroyed()
    );
}

function init(deps = {}) {
    const fs = requireDependency('fs', deps.fs);
    const path = requireDependency('path', deps.path);
    const pty = requireDependency('pty', deps.pty);
    const ChatStore = requireFunction('ChatStore', deps.ChatStore);
    const ensureOutboundAttachmentsDir = requireFunction('ensureOutboundAttachmentsDir', deps.ensureOutboundAttachmentsDir);
    const getStagedAttachmentPath = requireFunction('getStagedAttachmentPath', deps.getStagedAttachmentPath);
    const loadStagedAttachmentBytes = requireFunction('loadStagedAttachmentBytes', deps.loadStagedAttachmentBytes);
    const stripAttachmentBytes = requireFunction('stripAttachmentBytes', deps.stripAttachmentBytes);
    const touchAttachmentForGc = requireFunction('touchAttachmentForGc', deps.touchAttachmentForGc);
    const OUTBOUND_ATTACHMENTS_DIR = requireDependency('OUTBOUND_ATTACHMENTS_DIR', deps.OUTBOUND_ATTACHMENTS_DIR);
    const OUTBOUND_ATTACHMENT_GC_GRACE_MS = requireNumber(
        'OUTBOUND_ATTACHMENT_GC_GRACE_MS',
        deps.OUTBOUND_ATTACHMENT_GC_GRACE_MS,
    );
    const OUTBOUND_ATTACHMENT_SWEEP_INTERVAL_MS = requireNumber(
        'OUTBOUND_ATTACHMENT_SWEEP_INTERVAL_MS',
        deps.OUTBOUND_ATTACHMENT_SWEEP_INTERVAL_MS,
    );

    const logDebug = typeof deps.logDebug === 'function' ? deps.logDebug : () => {};
    const getMainWindow = typeof deps.getMainWindow === 'function' ? deps.getMainWindow : () => null;
    const getTunnelState = typeof deps.getTunnelState === 'function' ? deps.getTunnelState : () => ({});
    const getLocalChatWindow = typeof deps.getLocalChatWindow === 'function' ? deps.getLocalChatWindow : () => null;
    const getLatestChannelActivity = typeof deps.getLatestChannelActivity === 'function' ? deps.getLatestChannelActivity : () => null;
    const getChannelReplyPending = typeof deps.getChannelReplyPending === 'function' ? deps.getChannelReplyPending : () => false;
    const getActivityAssistantName = typeof deps.getActivityAssistantName === 'function'
        ? deps.getActivityAssistantName
        : () => DEFAULT_ACTIVITY_ASSISTANT_NAME;
    const getOperatingMode = typeof deps.getOperatingMode === 'function' ? deps.getOperatingMode : () => 'channel';
    const getChannelManager = typeof deps.getChannelManager === 'function' ? deps.getChannelManager : () => null;
    const getDynamicMemory = typeof deps.getDynamicMemory === 'function' ? deps.getDynamicMemory : () => null;
    const setChannelReplyPending = typeof deps.setChannelReplyPending === 'function' ? deps.setChannelReplyPending : () => {};
    const setChannelActivity = typeof deps.setChannelActivity === 'function' ? deps.setChannelActivity : () => {};
    const getActiveClients = typeof deps.getActiveClients === 'function' ? deps.getActiveClients : () => [];
    const getPtyProcess = typeof deps.getPtyProcess === 'function' ? deps.getPtyProcess : () => null;
    const setPtyProcess = typeof deps.setPtyProcess === 'function' ? deps.setPtyProcess : () => null;
    const getOutputBuffer = typeof deps.getOutputBuffer === 'function' ? deps.getOutputBuffer : () => '';
    const setOutputBuffer = typeof deps.setOutputBuffer === 'function' ? deps.setOutputBuffer : () => '';
    const sendEncryptedOutput = typeof deps.sendEncryptedOutput === 'function' ? deps.sendEncryptedOutput : () => {};
    const now = typeof deps.now === 'function' ? deps.now : () => new Date();
    const WebSocket = deps.WebSocket || { OPEN: 1 };
    const consoleObject = deps.console || console;
    const env = deps.env || process.env;
    const outputBufferMaxBytes = deps.outputBufferMaxBytes ?? 1024 * 1024;

    let chatStore = null;
    let outboundAttachmentSweepTimer = null;

    function getNowDate() {
        const value = now();
        return value instanceof Date ? value : new Date(value);
    }

    function getChatStore() {
        return chatStore;
    }

    function setChatStore(nextChatStore) {
        chatStore = nextChatStore || null;
        return chatStore;
    }

    function initializeChatStore(chatHistoryPath) {
        if (typeof chatHistoryPath !== 'string' || !chatHistoryPath.trim()) {
            throw new Error('Chat history path is required');
        }

        chatStore = new ChatStore(path.dirname(chatHistoryPath), path.basename(chatHistoryPath));

        try {
            const historyCount = chatStore.loadMessages().length;
            logDebug(`[CHAT] History store ready: ${chatStore.filePath} (${historyCount} messages)`);
        } catch (error) {
            logDebug(`[CHAT] Failed to read history store: ${error.message}`);
        }

        return chatStore;
    }

    function sendLocalChatEventToWindow(targetWindow, payload) {
        if (isUsableWindow(targetWindow) && targetWindow.webContents && typeof targetWindow.webContents.send === 'function') {
            targetWindow.webContents.send('LOCAL_CHAT_EVENT', payload);
            return true;
        }

        return false;
    }

    function sendLocalChatEvent(payload) {
        sendLocalChatEventToWindow(getLocalChatWindow(), payload);
    }

    function hasStructuredAttachments(message) {
        return Array.isArray(message?.attachments) && message.attachments.length > 0;
    }

    function buildAttachmentFallbackText(content, attachments) {
        if (!Array.isArray(attachments) || attachments.length === 0) {
            return content || '';
        }

        const fallbackLines = attachments.map((attachment) => `[Attachment: ${attachment.name} \u2014 open in a newer client]`);
        return content ? `${content}\n\n${fallbackLines.join('\n')}` : fallbackLines.join('\n');
    }

    function collectReferencedOutboundAttachmentPaths(messages) {
        const referenced = new Set();
        const items = Array.isArray(messages) ? messages : [];

        for (const message of items) {
            if (!hasStructuredAttachments(message) || !message.external_ref) {
                continue;
            }

            message.attachments.forEach((attachment, index) => {
                referenced.add(getStagedAttachmentPath(OUTBOUND_ATTACHMENTS_DIR, message.external_ref, index, attachment.name));
            });
        }

        return referenced;
    }

    function markOutboundAttachmentsForGc(messages) {
        const paths = collectReferencedOutboundAttachmentPaths(messages);
        if (paths.size === 0) {
            return;
        }

        const timestamp = getNowDate();
        for (const filePath of paths) {
            touchAttachmentForGc(filePath, timestamp);
        }
    }

    function sweepOutboundAttachments() {
        try {
            ensureOutboundAttachmentsDir();
            const referenced = collectReferencedOutboundAttachmentPaths(chatStore ? chatStore.loadMessages() : []);
            const entries = fs.readdirSync(OUTBOUND_ATTACHMENTS_DIR, { withFileTypes: true });
            const currentTime = getNowDate().getTime();

            for (const entry of entries) {
                if (!entry.isFile()) {
                    continue;
                }

                const filePath = path.join(OUTBOUND_ATTACHMENTS_DIR, entry.name);
                if (referenced.has(filePath)) {
                    continue;
                }

                const stat = fs.statSync(filePath);
                if ((currentTime - stat.mtimeMs) < OUTBOUND_ATTACHMENT_GC_GRACE_MS) {
                    continue;
                }

                fs.unlinkSync(filePath);
                logDebug(`[ATTACH] Swept outbound attachment ${entry.name}`);
            }
        } catch (error) {
            logDebug(`[ATTACH] Sweep failed: ${error.message}`);
        }
    }

    function startOutboundAttachmentSweep() {
        clearInterval(outboundAttachmentSweepTimer);
        sweepOutboundAttachments();
        outboundAttachmentSweepTimer = setInterval(() => {
            sweepOutboundAttachments();
        }, OUTBOUND_ATTACHMENT_SWEEP_INTERVAL_MS);
    }

    function stopOutboundAttachmentSweep() {
        clearInterval(outboundAttachmentSweepTimer);
        outboundAttachmentSweepTimer = null;
    }

    function findMessageAttachmentById(message, attachmentId) {
        const attachments = stripAttachmentBytes(message?.attachments);
        if (!attachments || !attachmentId) {
            return null;
        }

        const attachmentIndex = attachments.findIndex((attachment) => attachment.id === attachmentId);
        if (attachmentIndex === -1) {
            return null;
        }

        return {
            attachment: attachments[attachmentIndex],
            attachmentIndex,
        };
    }

    function buildAttachmentBytesResponsePayload({ requestId, attachmentId, externalRef }) {
        const response = {
            type: 'attachment_bytes_response',
            request_id: requestId,
            attachment_id: attachmentId,
        };

        try {
            if (typeof requestId !== 'string' || !requestId.trim()) {
                throw new Error('Attachment request id missing');
            }
            if (typeof attachmentId !== 'string' || !attachmentId.trim()) {
                throw new Error('Attachment id missing');
            }
            if (typeof externalRef !== 'string' || !externalRef.trim()) {
                throw new Error('Attachment reference missing');
            }
            if (!chatStore) {
                throw new Error('Chat history unavailable');
            }

            const message = chatStore.findByExternalRef(externalRef);
            if (!message) {
                throw new Error('Attachment message not found');
            }

            const resolvedAttachment = findMessageAttachmentById(message, attachmentId);
            if (!resolvedAttachment) {
                throw new Error('Attachment metadata not found');
            }

            const attachmentBytes = loadStagedAttachmentBytes({
                outboundDir: OUTBOUND_ATTACHMENTS_DIR,
                effectId: externalRef,
                attachment: resolvedAttachment.attachment,
                attachmentIndex: resolvedAttachment.attachmentIndex,
            });

            return {
                ...response,
                ...attachmentBytes,
            };
        } catch (error) {
            return {
                ...response,
                isError: true,
                error: error.message || 'Attachment unavailable',
            };
        }
    }

    function parseStructuredChannelInput(inputData) {
        if (typeof inputData !== 'string') {
            return null;
        }

        const trimmed = inputData.trim();
        if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
            return null;
        }

        try {
            const parsed = JSON.parse(trimmed);
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
        } catch {
            return null;
        }
    }

    function buildTransportChannelMessage(message = {}, { supportsAttachments = true } = {}) {
        const normalized = {
            type: 'channel_message',
            role: message.role || 'assistant',
            content: message.content || '',
            ts: message.ts || getNowDate().toISOString(),
        };

        if (!hasStructuredAttachments(message)) {
            return normalized;
        }

        const attachments = stripAttachmentBytes(message.attachments);
        if (!supportsAttachments) {
            normalized.content = buildAttachmentFallbackText(normalized.content, attachments);
            return normalized;
        }

        if (message.external_ref) {
            normalized.external_ref = message.external_ref;
        }
        normalized.attachments = attachments;
        return normalized;
    }

    function createChatTimelineItem(activity = {}) {
        const markerTs = activity.ts || getNowDate().toISOString();
        const activityKey = activity.toolUseId || `${activity.phase || 'idle'}:${activity.label || 'Idle'}:${activity.toolName || ''}:${activity.filePath || ''}`;
        const isActive = activity.active !== false;

        return {
            id: `${markerTs}:${activityKey}`,
            key: activityKey,
            label: activity.label || 'Idle',
            detail: activity.detail || '',
            filePath: activity.filePath || '',
            fileLabel: activity.fileLabel || '',
            active: isActive,
            done: !isActive,
            ts: markerTs,
            completedAt: !isActive ? markerTs : undefined,
        };
    }

    function sanitizeTerminalOutput(data) {
        const oscPattern = /\x1b\](\d+);[^\x07\x1b]*(?:\x07|\x1b\\)/g;
        const dcsPattern = /\x1bP[^\x1b]*\x1b\\/g;
        const apcPattern = /\x1b_[^\x1b]*\x1b\\/g;
        const pmPattern = /\x1b\^[^\x1b]*\x1b\\/g;
        const sosPattern = /\x1bX[^\x1b]*\x1b\\/g;
        let sanitized = data;

        sanitized = sanitized.replace(oscPattern, (match, oscNum) => {
            const num = parseInt(oscNum, 10);
            const safeOsc = [4, 10, 11, 12, 104, 110, 111, 112, 17, 19];
            if (safeOsc.includes(num)) {
                return match;
            }

            logDebug(`[SECURITY] Blocked OSC ${num} sequence`);
            return '';
        });
        sanitized = sanitized.replace(dcsPattern, () => {
            logDebug('[SECURITY] Blocked DCS sequence');
            return '';
        });
        sanitized = sanitized.replace(apcPattern, () => {
            logDebug('[SECURITY] Blocked APC sequence');
            return '';
        });
        sanitized = sanitized.replace(pmPattern, () => {
            logDebug('[SECURITY] Blocked PM sequence');
            return '';
        });
        sanitized = sanitized.replace(sosPattern, () => {
            logDebug('[SECURITY] Blocked SOS sequence');
            return '';
        });

        return sanitized;
    }

    function getLocalChatState() {
        const messages = chatStore ? chatStore.loadMessages().map((message) => buildTransportChannelMessage(message)) : [];
        const latestChannelActivity = getLatestChannelActivity();
        const localChatWindow = getLocalChatWindow();
        const activities = latestChannelActivity ? [createChatTimelineItem(latestChannelActivity)] : [];

        return {
            messages,
            waiting: getChannelReplyPending(),
            activities,
            alwaysOnTop: Boolean(
                isUsableWindow(localChatWindow)
                && typeof localChatWindow.isAlwaysOnTop === 'function'
                && localChatWindow.isAlwaysOnTop()
            ),
        };
    }

    function startPty(ws) {
        const activeClients = getActiveClients();
        logDebug(`[PTY] Attaching client. Total: ${activeClients.size + 1}`);
        activeClients.add(ws);
        ws.send(JSON.stringify({
            type: 'system_status',
            state: getTunnelState(),
        }));

        if (getOperatingMode() === 'channel') {
            logDebug('[CHANNEL] Client attached in channel mode, skipping PTY');
            const history = getChatStore().loadMessages().map((message) => buildTransportChannelMessage(message, {
                supportsAttachments: ws.supportsAttachments === true,
            }));
            if (history.length > 0) {
                sendEncryptedOutput(ws, JSON.stringify({
                    type: 'channel_history',
                    messages: history,
                }));
                logDebug(`[CHANNEL] Sent ${history.length} history messages from disk`);
            }

            const latestChannelActivity = getLatestChannelActivity();
            if (latestChannelActivity) {
                sendEncryptedOutput(ws, JSON.stringify({
                    type: 'channel_activity',
                    activity: latestChannelActivity,
                }));
            }
            return;
        }

        const existingPtyProcess = getPtyProcess();
        if (existingPtyProcess) {
            logDebug(`[PTY] PTY exists. Sending buffer (size: ${getOutputBuffer().length})`);
            sendEncryptedOutput(ws, getOutputBuffer());
            return;
        }

        let shellPath = '/bin/zsh';
        if (!fs.existsSync(shellPath)) {
            shellPath = '/bin/bash';
            if (!fs.existsSync(shellPath)) {
                shellPath = '/bin/sh';
            }
        }

        if (!fs.existsSync(shellPath)) {
            logDebug('[PTY] FATAL: No shell found');
            sendEncryptedOutput(ws, '\r\n[SYSTEM] No shell found\r\n');
            return;
        }

        logDebug(`[PTY] Spawning new session (${shellPath})...`);
        try {
            const safeEnv = {
                HOME: env.HOME || '/tmp',
                USER: env.USER || 'user',
                SHELL: shellPath,
                PATH: env.PATH || '/usr/local/bin:/usr/bin:/bin',
                TERM: 'xterm-256color',
                COLORTERM: 'truecolor',
                LANG: 'en_US.UTF-8',
                LC_ALL: 'en_US.UTF-8',
                EDITOR: env.EDITOR || 'vim',
                VISUAL: env.VISUAL || env.EDITOR || 'vim',
                XDG_CONFIG_HOME: env.XDG_CONFIG_HOME || `${env.HOME}/.config`,
                XDG_DATA_HOME: env.XDG_DATA_HOME || `${env.HOME}/.local/share`,
                XDG_CACHE_HOME: env.XDG_CACHE_HOME || `${env.HOME}/.cache`,
                POCKET_BRIDGE: '1',
                SSH_TTY: '/dev/ttys000',
            };
            setPtyProcess(pty.spawn(shellPath, ['--login'], {
                name: 'xterm-256color',
                cols: 80,
                rows: 30,
                cwd: env.HOME || '/tmp',
                env: safeEnv,
            }));
        } catch (error) {
            consoleObject.error('PTY Spawn Error:', error);
            const mainWindow = getMainWindow();
            if (mainWindow) {
                mainWindow.webContents.send('CF_LOG', 'PTY ERROR: ' + error.message);
            }
            sendEncryptedOutput(ws, '\r\n[SYSTEM] Failed to spawn shell: ' + error.message + '\r\n');
            return;
        }

        const ptyProcess = getPtyProcess();
        ptyProcess.on('data', (data) => {
            let filtered = data.toString()
                .replace(/\u25CF/g, '\u25CF\uFE0E')
                .replace(/\u25CB/g, '\u25CB\uFE0E')
                .replace(/\u2022/g, '\u2022\uFE0E')
                .replace(/\u2219/g, '\u2219\uFE0E')
                .replace(/\u23FA/g, '\u23FA\uFE0E')
                .replace(/\uD83D\uDD35/g, '\u25CF\uFE0E');
            filtered = sanitizeTerminalOutput(filtered);

            let outputBuffer = getOutputBuffer() + filtered;
            if (outputBuffer.length > outputBufferMaxBytes) {
                outputBuffer = outputBuffer.slice(-outputBufferMaxBytes);
            }
            setOutputBuffer(outputBuffer);

            for (const client of activeClients) {
                if (client.readyState === 1) {
                    sendEncryptedOutput(client, filtered);
                }
            }
        });

        ptyProcess.on('exit', (exitCode, signal) => {
            logDebug(`[PTY] Process exited with code ${exitCode}, signal ${signal}`);
            setPtyProcess(null);
        });
    }

    function isDynamicMemoryEnabled(dynamicMemory) {
        return Boolean(
            dynamicMemory
            && typeof dynamicMemory.isEnabled === 'function'
            && dynamicMemory.isEnabled()
        );
    }

    async function submitChannelUserMessage(chatId, content, userId, options = {}) {
        const { echoToLocalChat = false, senderWs = null } = options;
        const assistantName = getActivityAssistantName();
        const channelManager = getChannelManager();

        if (getOperatingMode() !== 'channel' || !channelManager || !channelManager.connected) {
            return { success: false, error: 'Chat bridge unavailable' };
        }

        const ts = getNowDate().toISOString();
        const dynamicMemory = getDynamicMemory();
        let outboundContent = content;

        if (isDynamicMemoryEnabled(dynamicMemory)) {
            const perfStart = Date.now();
            try {
                // Channel history tail (first ~200 messages) is already in the
                // appended system prompt. Only surface memories OLDER than the
                // oldest message in that tail — otherwise dynamic memory just
                // re-injects what's already loaded.
                let beforeTimestamp = null;
                try {
                    const firstMessage = chatStore && chatStore.loadMessages()[0];
                    if (firstMessage && firstMessage.ts) beforeTimestamp = firstMessage.ts;
                } catch {}

                const memoryBlock = await Promise.race([
                    dynamicMemory.buildContextForSpawn(content, chatId, 5, beforeTimestamp),
                    new Promise((resolve) => setTimeout(() => resolve(null), 1000)),
                ]);

                if (memoryBlock && typeof memoryBlock === 'string' && memoryBlock.length) {
                    const sanitizeEnvelope = (value) => String(value).replace(
                        /<\/(system-reminder|memory-context|channel)>/g,
                        '<\u200B/$1>',
                    );
                    const safeContent = sanitizeEnvelope(content);
                    const safeBlock = sanitizeEnvelope(memoryBlock);
                    outboundContent = `${safeContent}\n\n<system-reminder>\n<memory-context>\n${safeBlock}\n</memory-context>\n\nReply via the mcp__root-operator__reply tool using the chat_id from the <channel> tag above. A single-emoji ack is still a reply. Plain text doesn't reach the user.\n</system-reminder>`;
                }

                if (env.NODE_ENV === 'development' || env.DYNAMIC_MEMORY_PERF === '1') {
                    const wall = Date.now() - perfStart;
                    const hit = outboundContent !== content;
                    const perfLine = `[MEMORY-PERF] enrichment wall=${wall}ms hit=${hit} original_len=${content.length} enriched_len=${outboundContent.length}`;
                    consoleObject.error(perfLine);
                    logDebug(perfLine);
                }
            } catch (error) {
                logDebug(`[MEMORY] Enrichment failed: ${error.message}`);
                outboundContent = content;
            }
        }

        const sentToBridge = channelManager.sendToChannel(chatId, outboundContent, userId || chatId);

        if (isDynamicMemoryEnabled(dynamicMemory)) {
            dynamicMemory.indexMessage('user', content, chatId).catch((error) => {
                logDebug(`[MEMORY] Index (user) error: ${error.message}`);
            });
        }

        setChannelReplyPending(true);
        setChannelActivity(sentToBridge ? {
            phase: 'bridging',
            label: `Forwarding to ${assistantName}`,
            detail: `The chat bridge accepted your message for ${assistantName}.`,
        } : {
            phase: 'queued',
            label: `Queued for ${assistantName}`,
            detail: `Waiting for the ${assistantName} chat bridge to reconnect.`,
        }, { force: true });

        const userWrite = chatStore.addMessage({ role: 'user', content, ts });
        markOutboundAttachmentsForGc(userWrite.evicted);

        if (echoToLocalChat) {
            sendLocalChatEvent({
                type: 'channel_message',
                role: 'user',
                content,
                ts,
            });
        }

        const body = JSON.stringify({ type: 'channel_message', role: 'user', content, ts });
        for (const client of getActiveClients()) {
            if (client !== senderWs && client.readyState === WebSocket.OPEN) {
                sendEncryptedOutput(client, body);
            }
        }

        return {
            success: true,
            queued: !sentToBridge,
            ts,
        };
    }

    return {
        getChatStore,
        setChatStore,
        initializeChatStore,
        sendLocalChatEventToWindow,
        sendLocalChatEvent,
        hasStructuredAttachments,
        buildAttachmentFallbackText,
        collectReferencedOutboundAttachmentPaths,
        markOutboundAttachmentsForGc,
        sweepOutboundAttachments,
        startOutboundAttachmentSweep,
        stopOutboundAttachmentSweep,
        findMessageAttachmentById,
        buildAttachmentBytesResponsePayload,
        parseStructuredChannelInput,
        buildTransportChannelMessage,
        createChatTimelineItem,
        getLocalChatState,
        startPty,
        submitChannelUserMessage,
    };
}

module.exports = {
    init,
};
