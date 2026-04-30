const fs = require('fs');
const path = require('path');

const DEFAULT_CHANNEL_ACTIVITY_IDLE_MS = 5000;
const DEFAULT_CLAUDE_DEBUG_POLL_INTERVAL_MS = 700;
const DEFAULT_CLAUDE_HOOK_POLL_INTERVAL_MS = 400;

function requireFunction(name, value) {
    if (typeof value !== 'function') {
        throw new TypeError(`activity-tracker.init expected function dependency: ${name}`);
    }

    return value;
}

function init(deps = {}) {
    const fsImpl = deps.fs || fs;
    const pathImpl = deps.path || path;
    const getActivityAssistantName = requireFunction('getActivityAssistantName', deps.getActivityAssistantName);
    const sendEncryptedChannelPayload = typeof deps.sendEncryptedChannelPayload === 'function'
        ? deps.sendEncryptedChannelPayload
        : () => {};
    const sendLocalChatEvent = typeof deps.sendLocalChatEvent === 'function'
        ? deps.sendLocalChatEvent
        : () => {};
    const syncStateWithRenderer = typeof deps.syncStateWithRenderer === 'function'
        ? deps.syncStateWithRenderer
        : () => {};
    const logDebug = typeof deps.logDebug === 'function' ? deps.logDebug : () => {};
    const now = typeof deps.now === 'function' ? deps.now : () => new Date();
    const nowMs = typeof deps.nowMs === 'function' ? deps.nowMs : () => Date.now();
    const setTimeoutImpl = typeof deps.setTimeout === 'function' ? deps.setTimeout : setTimeout;
    const clearTimeoutImpl = typeof deps.clearTimeout === 'function' ? deps.clearTimeout : clearTimeout;
    const setIntervalImpl = typeof deps.setInterval === 'function' ? deps.setInterval : setInterval;
    const clearIntervalImpl = typeof deps.clearInterval === 'function' ? deps.clearInterval : clearInterval;
    const channelActivityIdleMs = Number.isFinite(deps.channelActivityIdleMs)
        ? deps.channelActivityIdleMs
        : DEFAULT_CHANNEL_ACTIVITY_IDLE_MS;
    // Optional listener invoked after every normalized channel-activity
    // change (and on reset). Used by the cursor companion to bind its
    // loader/response transitions to the same authoritative signal that
    // drives desktop chat indicators — single source of truth for "is
    // Claude working?". Late-bindable so init order doesn't matter.
    let onChannelActivityChanged = typeof deps.onChannelActivityChanged === 'function'
        ? deps.onChannelActivityChanged
        : null;
    function setChannelActivityListener(fn) {
        onChannelActivityChanged = typeof fn === 'function' ? fn : null;
    }
    function emitChannelActivityChanged(activity) {
        if (!onChannelActivityChanged) return;
        try {
            onChannelActivityChanged(activity);
        } catch (err) {
            logDebug(`[ACTIVITY] onChannelActivityChanged listener error: ${err && err.message}`);
        }
    }
    const claudeDebugPollIntervalMs = Number.isFinite(deps.claudeDebugPollIntervalMs)
        ? deps.claudeDebugPollIntervalMs
        : DEFAULT_CLAUDE_DEBUG_POLL_INTERVAL_MS;
    const claudeHookPollIntervalMs = Number.isFinite(deps.claudeHookPollIntervalMs)
        ? deps.claudeHookPollIntervalMs
        : DEFAULT_CLAUDE_HOOK_POLL_INTERVAL_MS;

    let channelReplyPending = false;
    let latestChannelActivity = null;
    let lastChannelActivityKey = '';
    let lastChannelActivityAt = 0;
    let channelIdleTimer = null;

    let claudeDebugFilePath = '';
    let claudeDebugPollTimer = null;
    let claudeDebugReadOffset = 0;
    let claudeDebugLineBuffer = '';

    let claudeHookFilePath = '';
    let claudeHookPollTimer = null;
    let claudeHookReadOffset = 0;
    let claudeHookLineBuffer = '';

    function getChannelReplyPending() {
        return channelReplyPending;
    }

    function setChannelReplyPending(value) {
        channelReplyPending = Boolean(value);
        return channelReplyPending;
    }

    function getLatestChannelActivity() {
        return latestChannelActivity;
    }

    function getActivityState() {
        return {
            waiting: channelReplyPending,
            latestActivity: latestChannelActivity,
        };
    }

    function hasActiveChannelActivity() {
        return Boolean(channelReplyPending || latestChannelActivity);
    }

    function clearChannelIdleTimer() {
        if (channelIdleTimer) {
            clearTimeoutImpl(channelIdleTimer);
            channelIdleTimer = null;
        }
    }

    function formatClaudeToolLabel(toolName) {
        if (!toolName) {
            return 'Tool';
        }

        const alias = {
            Bash: 'Shell',
            MultiEdit: 'Multi Edit',
            TodoRead: 'Todo',
            TodoWrite: 'Todo',
            WebFetch: 'Web Fetch',
            WebSearch: 'Web Search',
            reply: 'Reply',
        };

        const shortName = toolName.split('__').pop() || toolName;
        if (alias[shortName]) {
            return alias[shortName];
        }

        return shortName
            .replace(/[-_]+/g, ' ')
            .trim()
            .split(/\s+/)
            .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
            .join(' ');
    }

    function getClaudeToolKey(toolName) {
        if (!toolName) {
            return '';
        }

        return toolName.split('__').pop() || toolName;
    }

    function getClaudeHookFilePath(event) {
        const toolInput = event?.toolInput && typeof event.toolInput === 'object' ? event.toolInput : {};
        const toolResponse = event?.toolResponse && typeof event.toolResponse === 'object' ? event.toolResponse : {};
        const candidates = [
            toolInput.file_path,
            toolInput.filePath,
            toolResponse.filePath,
            toolResponse.file_path,
            toolInput.path,
            toolResponse.path,
        ];

        for (const candidate of candidates) {
            if (typeof candidate === 'string' && candidate.trim()) {
                return candidate.trim();
            }
        }

        return '';
    }

    function formatClaudeActivityFileLabel(filePathValue, cwd = '') {
        if (!filePathValue) {
            return '';
        }

        const normalizedFilePath = pathImpl.normalize(filePathValue);
        const normalizedCwd = typeof cwd === 'string' && cwd.trim() ? pathImpl.normalize(cwd.trim()) : '';

        if (normalizedCwd) {
            const relativePath = pathImpl.relative(normalizedCwd, normalizedFilePath);
            if (relativePath && !relativePath.startsWith('..') && !pathImpl.isAbsolute(relativePath)) {
                const parts = relativePath.split(pathImpl.sep).filter(Boolean);
                if (parts.length >= 2) {
                    return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
                }

                return parts[0] || pathImpl.basename(normalizedFilePath);
            }
        }

        const baseName = pathImpl.basename(normalizedFilePath);
        const parentName = pathImpl.basename(pathImpl.dirname(normalizedFilePath));
        if (parentName && parentName !== '.' && parentName !== pathImpl.sep && parentName !== baseName) {
            return `${parentName}/${baseName}`;
        }

        return baseName || normalizedFilePath;
    }

    function getClaudeBashCommand(event) {
        const toolInput = event?.toolInput && typeof event.toolInput === 'object' ? event.toolInput : {};
        const candidates = [
            toolInput.command,
            toolInput.cmd,
        ];

        for (const candidate of candidates) {
            if (typeof candidate === 'string' && candidate.trim()) {
                return candidate.trim();
            }
        }

        return '';
    }

    function tokenizeShellCommand(command) {
        if (!command) {
            return [];
        }

        const matches = command.match(/"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|`(?:\\.|[^`])*`|[^\s]+/g) || [];
        return matches.map((token) => token.replace(/^["'`]|["'`]$/g, ''));
    }

    function formatShellCommandPreview(command, maxLength = 72) {
        const normalized = (command || '').replace(/\s+/g, ' ').trim();
        if (normalized.length <= maxLength) {
            return normalized;
        }

        return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
    }

    function getPrimaryShellCommand(tokens) {
        for (let index = 0; index < tokens.length; index += 1) {
            const token = tokens[index];
            if (!token) {
                continue;
            }

            if (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token)) {
                continue;
            }

            if (token === 'env' || token === '/usr/bin/env' || token === 'command') {
                continue;
            }

            return {
                primary: pathImpl.basename(token),
                index,
            };
        }

        return {
            primary: '',
            index: -1,
        };
    }

    function describeClaudeBashCommand(command) {
        const preview = formatShellCommandPreview(command);
        const tokens = tokenizeShellCommand(command);
        const { primary } = getPrimaryShellCommand(tokens);
        const commandLabel = primary || 'shell command';
        return {
            active: `is running ${commandLabel}`,
            done: `finished ${commandLabel}`,
            failed: `hit an error running ${commandLabel}`,
            detail: preview,
        };
    }

    function buildClaudeToolActivity(event) {
        const assistantName = getActivityAssistantName();
        const toolName = event.toolName || '';
        const toolKey = getClaudeToolKey(toolName);
        const filePathValue = getClaudeHookFilePath(event);
        const fileLabel = formatClaudeActivityFileLabel(filePathValue, event.cwd || '');
        const isActive = event.hookEventName === 'PreToolUse';
        const activityBase = {
            phase: isActive ? 'tool' : 'tool_complete',
            toolName,
            toolUseId: event.toolUseId || '',
            filePath: filePathValue,
            fileLabel,
            ts: event.ts || now().toISOString(),
            active: isActive,
        };
        const copyByTool = {
            Read: {
                active: 'is reading',
                done: 'finished reading',
            },
            Write: {
                active: 'is writing',
                done: 'finished writing',
            },
            Edit: {
                active: 'is editing',
                done: 'finished editing',
            },
            MultiEdit: {
                active: 'is editing',
                done: 'finished editing',
            },
            reply: {
                active: 'is preparing a reply',
                done: 'finished preparing a reply',
            },
        };

        if (toolKey === 'Bash') {
            const bashCommand = getClaudeBashCommand(event);
            const bashCopy = describeClaudeBashCommand(bashCommand);
            const action = isActive ? bashCopy.active : bashCopy.done;
            return {
                ...activityBase,
                label: `${assistantName} ${action}`,
                detail: bashCopy.detail || `${assistantName} ${action}.`,
            };
        }

        if (copyByTool[toolKey]) {
            const copy = copyByTool[toolKey];
            const action = isActive ? copy.active : copy.done;
            return {
                ...activityBase,
                label: fileLabel ? `${assistantName} ${action} ${fileLabel}` : `${assistantName} ${action}`,
                detail: filePathValue || `${assistantName} ${action}.`,
            };
        }

        const toolLabel = formatClaudeToolLabel(toolName);
        return {
            ...activityBase,
            label: isActive
                ? `${assistantName} is using ${toolLabel}`
                : `${assistantName} finished using ${toolLabel}`,
            detail: filePathValue || `${assistantName} ${isActive ? 'started' : 'finished'} using ${toolLabel}.`,
        };
    }

    function buildClaudeToolFailureActivity(event) {
        const assistantName = getActivityAssistantName();
        const toolName = event.toolName || '';
        const toolKey = getClaudeToolKey(toolName);
        const filePathValue = getClaudeHookFilePath(event);
        const fileLabel = formatClaudeActivityFileLabel(filePathValue, event.cwd || '');
        const copyByTool = {
            Read: 'stopped reading',
            Write: 'stopped writing',
            Edit: 'stopped editing',
            MultiEdit: 'stopped editing',
            reply: 'could not finish the reply',
        };

        if (toolKey === 'Bash') {
            const bashCommand = getClaudeBashCommand(event);
            const bashCopy = describeClaudeBashCommand(bashCommand);
            return {
                phase: 'tool_failed',
                label: `${assistantName} ${bashCopy.failed}`,
                detail: event.error || bashCopy.detail || `${assistantName} ${bashCopy.failed}.`,
                toolName,
                toolUseId: event.toolUseId || '',
                filePath: filePathValue,
                fileLabel,
                ts: event.ts || now().toISOString(),
                active: false,
            };
        }

        const fallbackToolLabel = formatClaudeToolLabel(toolName);
        const action = copyByTool[toolKey] || `hit an error using ${fallbackToolLabel}`;

        return {
            phase: 'tool_failed',
            label: fileLabel ? `${assistantName} ${action} ${fileLabel}` : `${assistantName} ${action}`,
            detail: event.error || filePathValue || `${assistantName} hit an error while using ${fallbackToolLabel}.`,
            toolName,
            toolUseId: event.toolUseId || '',
            filePath: filePathValue,
            fileLabel,
            ts: event.ts || now().toISOString(),
            active: false,
        };
    }

    function setChannelActivity(activity, options = {}) {
        const {
            force = false,
            broadcast = true,
        } = options;
        const source = activity && typeof activity === 'object' ? activity : {};

        const normalized = {
            phase: source.phase || 'idle',
            label: source.label || 'Idle',
            detail: source.detail || '',
            toolName: source.toolName || '',
            toolUseId: source.toolUseId || '',
            filePath: source.filePath || '',
            fileLabel: source.fileLabel || '',
            ts: source.ts || now().toISOString(),
            active: typeof source.active === 'boolean' ? source.active : source.phase !== 'idle',
        };

        const activityKey = normalized.toolUseId || `${normalized.phase}:${normalized.label}:${normalized.toolName}:${normalized.filePath}`;
        const activityNow = nowMs();
        if (!force && activityKey === lastChannelActivityKey && activityNow - lastChannelActivityAt < 900) {
            return normalized;
        }

        lastChannelActivityKey = activityKey;
        lastChannelActivityAt = activityNow;
        latestChannelActivity = normalized.active ? normalized : null;

        // Only ACTIVE phases cancel the idle countdown. Inactive
        // signals (tool_complete, tool_failed) describe the end of an
        // action — they shouldn't extend an already-scheduled idle
        // timer, otherwise a missed/delayed Stop hook can strand the
        // cursor loader in `loading` forever (no terminal event ever
        // arrives). Codex flagged this in review.
        if (normalized.active) {
            clearChannelIdleTimer();
        }

        if (broadcast) {
            sendEncryptedChannelPayload({
                type: 'channel_activity',
                activity: normalized,
            });
        }

        sendLocalChatEvent({
            type: 'channel_activity',
            activity: normalized,
        });

        syncStateWithRenderer();
        emitChannelActivityChanged(normalized);
        return normalized;
    }

    function resetChannelActivity() {
        clearChannelIdleTimer();
        channelReplyPending = false;
        latestChannelActivity = null;
        lastChannelActivityKey = '';
        lastChannelActivityAt = 0;
        syncStateWithRenderer();
        // Synthesize a reset event so subscribers (cursor companion)
        // can release stuck pending state without treating the reset
        // as a successful turn. The `reset: true` flag distinguishes
        // an admin teardown from a real terminal idle so a partial
        // captured reply isn't presented as the final response.
        emitChannelActivityChanged({
            phase: 'idle',
            label: 'Idle',
            detail: '',
            toolName: '',
            toolUseId: '',
            filePath: '',
            fileLabel: '',
            ts: now().toISOString(),
            active: false,
            reset: true,
        });
    }

    function scheduleChannelIdle(detail = `${getActivityAssistantName()} is ready for the next message.`) {
        clearChannelIdleTimer();
        channelIdleTimer = setTimeoutImpl(() => {
            channelIdleTimer = null;
            channelReplyPending = false;
            setChannelActivity({
                phase: 'idle',
                label: 'Idle',
                detail,
            }, { force: true });
        }, channelActivityIdleMs);
    }

    function applyChannelManagerActivity(activity) {
        if (!activity) {
            return null;
        }

        if (activity.phase === 'forwarded') {
            const assistantName = getActivityAssistantName();
            return setChannelActivity({
                phase: 'forwarded',
                label: `Delivered to ${assistantName}`,
                detail: `The chat bridge handed your message to ${assistantName}.`,
                ts: activity.ts,
            }, { force: true });
        }

        if (activity.phase === 'replying') {
            const assistantName = getActivityAssistantName();
            return setChannelActivity({
                phase: 'replying',
                label: `${assistantName} is sending the reply`,
                detail: `${assistantName} is sending the final answer back to chat.`,
                ts: activity.ts,
                toolName: activity.toolName,
            }, { force: true });
        }

        return setChannelActivity(activity);
    }

    function stopClaudeDebugWatcher() {
        if (claudeDebugPollTimer) {
            clearIntervalImpl(claudeDebugPollTimer);
            claudeDebugPollTimer = null;
        }

        claudeDebugReadOffset = 0;
        claudeDebugLineBuffer = '';
        claudeDebugFilePath = '';
    }

    function handleClaudeDebugLine(line) {
        if (!channelReplyPending) {
            return;
        }

        if (line.includes('Stream started - received first chunk')) {
            const assistantName = getActivityAssistantName();
            setChannelActivity({
                phase: 'thinking',
                label: `${assistantName} is working`,
                detail: `${assistantName} started generating a response.`,
            });
        }
    }

    function pollClaudeDebugWatcher() {
        if (!claudeDebugFilePath) {
            return;
        }

        try {
            const stats = fsImpl.statSync(claudeDebugFilePath);
            if (stats.size < claudeDebugReadOffset) {
                claudeDebugReadOffset = 0;
                claudeDebugLineBuffer = '';
            }

            if (stats.size === claudeDebugReadOffset) {
                return;
            }

            const length = stats.size - claudeDebugReadOffset;
            const fd = fsImpl.openSync(claudeDebugFilePath, 'r');
            try {
                const buffer = Buffer.alloc(length);
                const bytesRead = fsImpl.readSync(fd, buffer, 0, length, claudeDebugReadOffset);
                claudeDebugReadOffset += bytesRead;

                const chunk = claudeDebugLineBuffer + buffer.toString('utf8', 0, bytesRead);
                const lines = chunk.split(/\r?\n/);
                claudeDebugLineBuffer = lines.pop() || '';

                for (const line of lines) {
                    if (line) {
                        handleClaudeDebugLine(line);
                    }
                }
            } finally {
                fsImpl.closeSync(fd);
            }
        } catch (error) {
            if (error.code !== 'ENOENT') {
                logDebug(`[CLAUDE] Failed reading debug log: ${error.message}`);
            }
        }
    }

    function startClaudeDebugWatcher(filePathValue) {
        stopClaudeDebugWatcher();
        claudeDebugFilePath = typeof filePathValue === 'string' ? filePathValue : '';
        claudeDebugReadOffset = 0;
        claudeDebugLineBuffer = '';

        if (!claudeDebugFilePath) {
            return;
        }

        claudeDebugPollTimer = setIntervalImpl(pollClaudeDebugWatcher, claudeDebugPollIntervalMs);
        pollClaudeDebugWatcher();
    }

    function stopClaudeHookWatcher() {
        if (claudeHookPollTimer) {
            clearIntervalImpl(claudeHookPollTimer);
            claudeHookPollTimer = null;
        }

        claudeHookReadOffset = 0;
        claudeHookLineBuffer = '';
        claudeHookFilePath = '';
    }

    function handleClaudeHookLine(line) {
        let event;
        try {
            event = JSON.parse(line);
        } catch {
            return;
        }

        if (event.hookEventName === 'PreToolUse' || event.hookEventName === 'PostToolUse') {
            setChannelActivity(buildClaudeToolActivity(event), { force: true });
            return;
        }

        if (event.hookEventName === 'PostToolUseFailure') {
            setChannelActivity(buildClaudeToolFailureActivity(event), { force: true });
            return;
        }

        if (event.hookEventName === 'Stop') {
            const assistantName = getActivityAssistantName();
            clearChannelIdleTimer();
            channelReplyPending = false;
            setChannelActivity({
                phase: 'finished',
                label: `${assistantName} finished`,
                detail: `${assistantName} finished this turn.`,
                ts: event.ts || now().toISOString(),
                active: false,
            }, { force: true });
            return;
        }

        if (event.hookEventName === 'StopFailure') {
            const assistantName = getActivityAssistantName();
            clearChannelIdleTimer();
            channelReplyPending = false;
            setChannelActivity({
                phase: 'failed',
                label: `${assistantName} stopped with error`,
                detail: `${assistantName} ended the turn with ${event.error || 'an API error'}.`,
                ts: event.ts || now().toISOString(),
                active: false,
            }, { force: true });
        }
    }

    function pollClaudeHookWatcher() {
        if (!claudeHookFilePath) {
            return;
        }

        try {
            const stats = fsImpl.statSync(claudeHookFilePath);
            if (stats.size < claudeHookReadOffset) {
                claudeHookReadOffset = 0;
                claudeHookLineBuffer = '';
            }

            if (stats.size === claudeHookReadOffset) {
                return;
            }

            const length = stats.size - claudeHookReadOffset;
            const fd = fsImpl.openSync(claudeHookFilePath, 'r');
            try {
                const buffer = Buffer.alloc(length);
                const bytesRead = fsImpl.readSync(fd, buffer, 0, length, claudeHookReadOffset);
                claudeHookReadOffset += bytesRead;

                const chunk = claudeHookLineBuffer + buffer.toString('utf8', 0, bytesRead);
                const lines = chunk.split(/\r?\n/);
                claudeHookLineBuffer = lines.pop() || '';

                for (const hookLine of lines) {
                    if (hookLine) {
                        handleClaudeHookLine(hookLine);
                    }
                }
            } finally {
                fsImpl.closeSync(fd);
            }
        } catch (error) {
            if (error.code !== 'ENOENT') {
                logDebug(`[CLAUDE] Failed reading hook log: ${error.message}`);
            }
        }
    }

    function startClaudeHookWatcher(filePathValue) {
        stopClaudeHookWatcher();
        claudeHookFilePath = typeof filePathValue === 'string' ? filePathValue : '';
        claudeHookReadOffset = 0;
        claudeHookLineBuffer = '';

        if (!claudeHookFilePath) {
            return;
        }

        claudeHookPollTimer = setIntervalImpl(pollClaudeHookWatcher, claudeHookPollIntervalMs);
        pollClaudeHookWatcher();
    }

    function dispose() {
        clearChannelIdleTimer();
        stopClaudeDebugWatcher();
        stopClaudeHookWatcher();
    }

    return {
        getChannelReplyPending,
        setChannelReplyPending,
        getLatestChannelActivity,
        getActivityState,
        hasActiveChannelActivity,
        clearChannelIdleTimer,
        formatClaudeToolLabel,
        buildClaudeToolActivity,
        buildClaudeToolFailureActivity,
        setChannelActivity,
        resetChannelActivity,
        scheduleChannelIdle,
        applyChannelManagerActivity,
        setChannelActivityListener,
        startClaudeDebugWatcher,
        stopClaudeDebugWatcher,
        startClaudeHookWatcher,
        stopClaudeHookWatcher,
        dispose,
    };
}

module.exports = {
    init,
};
