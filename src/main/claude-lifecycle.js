const DEFAULT_CHANNEL_STARTUP_TIMEOUT_MS = 15000
const DEFAULT_CHANNEL_RESTART_DELAY_MS = 2500
const DEFAULT_SETTINGS_FILENAME = 'root-operator-claude-settings.json'
const DEFAULT_DEBUG_LOG_FILENAME = 'claude-channel-debug.log'
const DEFAULT_HOOK_LOG_FILENAME = 'claude-channel-hooks.jsonl'
const LEGACY_SUPERVISOR_CLEANUP_KEY = 'legacy-supervisor-cleanup-complete'

function requireDependency(name, value) {
    if (value === undefined || value === null) {
        throw new TypeError(`claude-lifecycle.init missing dependency: ${name}`)
    }

    return value
}

function requireFunction(name, value) {
    if (typeof value !== 'function') {
        throw new TypeError(`claude-lifecycle.init expected function dependency: ${name}`)
    }

    return value
}

function requireString(name, value) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new TypeError(`claude-lifecycle.init expected string dependency: ${name}`)
    }

    return value
}

function defaultShellEscapeArg(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function resolveRuntimeRootDir(appDir, isDev, runtimeRootDir) {
    if (typeof runtimeRootDir === 'string' && runtimeRootDir.trim()) {
        return runtimeRootDir
    }

    return isDev ? appDir : appDir.replace('app.asar', 'app.asar.unpacked')
}

function init(deps = {}) {
    const app = requireDependency('app', deps.app)
    const fs = requireDependency('fs', deps.fs)
    const path = requireDependency('path', deps.path)
    const pty = requireDependency('pty', deps.pty)
    const ensureWorkspace = requireFunction('ensureWorkspace', deps.ensureWorkspace)
    const ensureAttachmentsDir = requireFunction('ensureAttachmentsDir', deps.ensureAttachmentsDir)
    const writeSystemPromptFile = requireFunction('writeSystemPromptFile', deps.writeSystemPromptFile)
    const writeProjectMcpConfig = requireFunction('writeProjectMcpConfig', deps.writeProjectMcpConfig)
    const getActivityAssistantName = requireFunction('getActivityAssistantName', deps.getActivityAssistantName)
    const getOperatingMode = requireFunction('getOperatingMode', deps.getOperatingMode)
    const getIsAppQuitting = requireFunction('getIsAppQuitting', deps.getIsAppQuitting)
    const getChannelReplyPending = requireFunction('getChannelReplyPending', deps.getChannelReplyPending)
    const getChannelManager = requireFunction('getChannelManager', deps.getChannelManager)
    const getClaudeProcess = requireFunction('getClaudeProcess', deps.getClaudeProcess)
    const setClaudeProcess = requireFunction('setClaudeProcess', deps.setClaudeProcess)
    const getChannelStartupTimer = requireFunction('getChannelStartupTimer', deps.getChannelStartupTimer)
    const setChannelStartupTimer = requireFunction('setChannelStartupTimer', deps.setChannelStartupTimer)
    const getChannelRestartTimer = requireFunction('getChannelRestartTimer', deps.getChannelRestartTimer)
    const setChannelRestartTimer = requireFunction('setChannelRestartTimer', deps.setChannelRestartTimer)
    const getChannelConfirmTimers = requireFunction('getChannelConfirmTimers', deps.getChannelConfirmTimers)
    const setChannelConfirmTimers = requireFunction('setChannelConfirmTimers', deps.setChannelConfirmTimers)
    const getChannelStartupAttempt = requireFunction('getChannelStartupAttempt', deps.getChannelStartupAttempt)
    const setChannelStartupAttempt = requireFunction('setChannelStartupAttempt', deps.setChannelStartupAttempt)
    const setChannelRuntime = requireFunction('setChannelRuntime', deps.setChannelRuntime)
    const setChannelActivity = requireFunction('setChannelActivity', deps.setChannelActivity)
    const resetChannelActivity = requireFunction('resetChannelActivity', deps.resetChannelActivity)
    const startClaudeDebugWatcher = requireFunction('startClaudeDebugWatcher', deps.startClaudeDebugWatcher)
    const stopClaudeDebugWatcher = requireFunction('stopClaudeDebugWatcher', deps.stopClaudeDebugWatcher)
    const startClaudeHookWatcher = requireFunction('startClaudeHookWatcher', deps.startClaudeHookWatcher)
    const stopClaudeHookWatcher = requireFunction('stopClaudeHookWatcher', deps.stopClaudeHookWatcher)

    const appDir = requireString('appDir', deps.appDir)
    const channelIpcPath = requireString('channelIpcPath', deps.channelIpcPath)
    const workspaceDir = requireString('workspaceDir', deps.workspaceDir)

    const isDev = Boolean(deps.isDev)
    const processObject = deps.process || process
    const setTimeoutFn = typeof deps.setTimeout === 'function' ? deps.setTimeout : setTimeout
    const clearTimeoutFn = typeof deps.clearTimeout === 'function' ? deps.clearTimeout : clearTimeout
    const logDebug = typeof deps.logDebug === 'function' ? deps.logDebug : () => {}
    const recordPid = typeof deps.recordPid === 'function' ? deps.recordPid : () => {}
    const shellEscapeArg = typeof deps.shellEscapeArg === 'function' ? deps.shellEscapeArg : defaultShellEscapeArg
    const runtimeRootDir = resolveRuntimeRootDir(appDir, isDev, deps.runtimeRootDir)
    const getHomePath = typeof deps.getHomePath === 'function'
        ? deps.getHomePath
        : () => app.getPath('home')
    const getStore = typeof deps.getStore === 'function' ? deps.getStore : null
    const removeChannelSocket = typeof deps.removeChannelSocket === 'function'
        ? deps.removeChannelSocket
        : () => {
            try {
                if (fs.existsSync(channelIpcPath)) {
                    fs.unlinkSync(channelIpcPath)
                }
            } catch (error) {
                logDebug(`[CHANNEL] Failed to remove socket: ${error.message}`)
            }
        }

    const channelStartupTimeoutMs = Number.isFinite(deps.channelStartupTimeoutMs)
        ? deps.channelStartupTimeoutMs
        : DEFAULT_CHANNEL_STARTUP_TIMEOUT_MS
    const channelRestartDelayMs = Number.isFinite(deps.channelRestartDelayMs)
        ? deps.channelRestartDelayMs
        : DEFAULT_CHANNEL_RESTART_DELAY_MS
    const claudeCommand = typeof deps.claudeCommand === 'string' && deps.claudeCommand.trim()
        ? deps.claudeCommand.trim()
        : 'claude'
    const bridgeFile = typeof deps.bridgeFile === 'string' && deps.bridgeFile.trim()
        ? deps.bridgeFile.trim()
        : (isDev ? 'channel-bridge.cjs' : 'channel-bridge.bundle.cjs')
    const hookScriptFile = typeof deps.hookScriptFile === 'string' && deps.hookScriptFile.trim()
        ? deps.hookScriptFile.trim()
        : 'claude-stop-hook.cjs'
    const settingsFilename = typeof deps.settingsFilename === 'string' && deps.settingsFilename.trim()
        ? deps.settingsFilename.trim()
        : DEFAULT_SETTINGS_FILENAME
    const debugLogFilename = typeof deps.debugLogFilename === 'string' && deps.debugLogFilename.trim()
        ? deps.debugLogFilename.trim()
        : DEFAULT_DEBUG_LOG_FILENAME
    const hookLogFilename = typeof deps.hookLogFilename === 'string' && deps.hookLogFilename.trim()
        ? deps.hookLogFilename.trim()
        : DEFAULT_HOOK_LOG_FILENAME

    function collectFilesByName(rootDir, targetNames, found = []) {
        if (!rootDir || !fs.existsSync(rootDir)) {
            return found
        }

        const entries = fs.readdirSync(rootDir, { withFileTypes: true })
        for (const entry of entries) {
            const fullPath = path.join(rootDir, entry.name)
            if (entry.isDirectory()) {
                collectFilesByName(fullPath, targetNames, found)
                continue
            }

            if (targetNames.has(entry.name)) {
                found.push(fullPath)
            }
        }

        return found
    }

    function cleanupLegacySupervisorArtifacts() {
        const targets = new Set(['supervisor.db', 'claude-supervisor.db'])
        const roots = [
            path.join(workspaceDir, 'brain'),
            path.join(getHomePath(), '.root-operator', 'runtime'),
        ]
        const removed = []

        for (const rootDir of roots) {
            for (const filePath of collectFilesByName(rootDir, targets)) {
                try {
                    fs.unlinkSync(filePath)
                    removed.push(filePath)
                } catch (error) {
                    logDebug(`[SYSTEM] Failed to remove legacy supervisor artifact ${filePath}: ${error.message}`)
                }
            }
        }

        if (removed.length > 0) {
            logDebug('[SYSTEM] Removed legacy supervisor artifacts', { removed })
        }
    }

    function shouldCleanupLegacySupervisorArtifacts() {
        const store = getStore ? getStore() : null
        if (!store || typeof store.get !== 'function') {
            return true
        }

        return !Boolean(store.get(LEGACY_SUPERVISOR_CLEANUP_KEY, false))
    }

    function markLegacySupervisorArtifactsCleaned() {
        const store = getStore ? getStore() : null
        if (!store || typeof store.set !== 'function') {
            return
        }

        store.set(LEGACY_SUPERVISOR_CLEANUP_KEY, true)
    }

    async function prepareStartupEnvironment(fixPath = async () => {}) {
        await fixPath()

        try {
            const { missingTemplateFiles } = ensureWorkspace()
            if (missingTemplateFiles.length > 0) {
                console.warn(`[WORKSPACE] Missing bundled templates: ${missingTemplateFiles.join(', ')}`)
            }
            if (shouldCleanupLegacySupervisorArtifacts()) {
                cleanupLegacySupervisorArtifacts()
                markLegacySupervisorArtifactsCleaned()
            }
        } catch (error) {
            console.error(`[WORKSPACE] Failed to prepare workspace: ${error.message}`)
            logDebug(`[WORKSPACE] Startup preparation failed: ${error.message}`)
        }
    }

    function clearChannelConfirmTimers() {
        const timers = getChannelConfirmTimers()
        if (Array.isArray(timers)) {
            for (const timer of timers) {
                clearTimeoutFn(timer)
            }
        }

        setChannelConfirmTimers([])
    }

    function clearChannelStartupTimer() {
        const timer = getChannelStartupTimer()
        if (!timer) {
            return
        }

        clearTimeoutFn(timer)
        setChannelStartupTimer(null)
    }

    function clearChannelRestartTimer() {
        const timer = getChannelRestartTimer()
        if (!timer) {
            return
        }

        clearTimeoutFn(timer)
        setChannelRestartTimer(null)
    }

    function normalizeClaudeBootstrapText(text) {
        return String(text || '')
            .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
            .toLowerCase()
            .replace(/[^a-z0-9]/g, '')
    }

    function scheduleClaudeRestart(reason) {
        if (getOperatingMode() !== 'channel' || getIsAppQuitting()) {
            return
        }

        clearChannelRestartTimer()
        setChannelRuntime('retrying', reason, { lastError: reason })
        if (getChannelReplyPending()) {
            const assistantName = getActivityAssistantName()
            setChannelActivity({
                phase: 'retrying',
                label: `Restarting ${assistantName}`,
                detail: reason,
            }, { force: true })
        }

        const restartTimer = setTimeoutFn(() => {
            setChannelRestartTimer(null)
            if (getOperatingMode() !== 'channel' || getIsAppQuitting() || getClaudeProcess()) {
                return
            }

            spawnClaudeCode()
            const channelManager = getChannelManager()
            if (channelManager && !channelManager.connected) {
                channelManager.connect()
            }
        }, channelRestartDelayMs)

        setChannelRestartTimer(restartTimer)
    }

    function prepareClaudeWorkspaceRuntime() {
        const bridgePath = path.join(runtimeRootDir, bridgeFile)
        const hookScriptPath = path.join(runtimeRootDir, hookScriptFile)
        const {
            workspaceDir,
            runtimeDir,
            isFirstRun,
            repairedFiles,
            missingTemplateFiles,
        } = ensureWorkspace()
        ensureAttachmentsDir()
        const settingsPath = path.join(runtimeDir, settingsFilename)
        const debugFilePath = path.join(runtimeDir, debugLogFilename)
        const hookLogPath = path.join(runtimeDir, hookLogFilename)
        const systemPromptFile = writeSystemPromptFile()
        const hookCommand = `/usr/bin/env ELECTRON_RUN_AS_NODE=1 ${shellEscapeArg(processObject.execPath)} ${shellEscapeArg(hookScriptPath)}`
        const projectMcpPath = writeProjectMcpConfig({
            command: processObject.execPath,
            args: [bridgePath],
            env: {
                ...processObject.env,
                ELECTRON_RUN_AS_NODE: '1',
                ROOT_OPERATOR_IPC: channelIpcPath,
            },
        })

        fs.writeFileSync(settingsPath, JSON.stringify({
            hooks: {
                Stop: [
                    {
                        hooks: [
                            {
                                type: 'command',
                                command: hookCommand,
                            },
                        ],
                    },
                ],
                StopFailure: [
                    {
                        hooks: [
                            {
                                type: 'command',
                                command: hookCommand,
                            },
                        ],
                    },
                ],
                PreToolUse: [
                    {
                        hooks: [
                            {
                                type: 'command',
                                command: hookCommand,
                            },
                        ],
                    },
                ],
                PostToolUse: [
                    {
                        hooks: [
                            {
                                type: 'command',
                                command: hookCommand,
                            },
                        ],
                    },
                ],
                PostToolUseFailure: [
                    {
                        hooks: [
                            {
                                type: 'command',
                                command: hookCommand,
                            },
                        ],
                    },
                ],
            },
        }, null, 2))

        if (isFirstRun) {
            logDebug('[CLAUDE] First run — workspace seeded with identity templates')
        }

        if (repairedFiles.length > 0) {
            logDebug(`[WORKSPACE] Repaired missing files: ${repairedFiles.join(', ')}`)
        }

        if (missingTemplateFiles.length > 0) {
            logDebug(`[WORKSPACE] Missing bundled templates: ${missingTemplateFiles.join(', ')}`)
        }

        return {
            workspaceDir,
            runtimeDir,
            bridgePath,
            hookScriptPath,
            settingsPath,
            debugFilePath,
            hookLogPath,
            systemPromptFile,
            projectMcpPath,
            isFirstRun,
            repairedFiles,
            missingTemplateFiles,
        }
    }

    async function spawnClaudeCode() {
        if (getClaudeProcess()) {
            logDebug('[CLAUDE] Already running, skipping spawn')
            return
        }

        const assistantName = getActivityAssistantName()

        setChannelStartupAttempt(getChannelStartupAttempt() + 1)
        clearChannelRestartTimer()
        clearChannelStartupTimer()
        clearChannelConfirmTimers()
        removeChannelSocket()
        resetChannelActivity()
        setChannelRuntime('starting', `Launching ${assistantName} for the chat channel.`, {
            attempt: getChannelStartupAttempt(),
            lastError: '',
        })

        const {
            workspaceDir,
            settingsPath,
            debugFilePath,
            hookLogPath,
            systemPromptFile,
        } = prepareClaudeWorkspaceRuntime()

        logDebug('[CLAUDE] Spawning Claude Code via PTY...')
        try {
            fs.writeFileSync(debugFilePath, '')
            fs.writeFileSync(hookLogPath, '')
            startClaudeDebugWatcher(debugFilePath)
            startClaudeHookWatcher(hookLogPath)

            const claudeProcess = pty.spawn(claudeCommand, [
                '--dangerously-skip-permissions',
                '--debug-file', debugFilePath,
                '--settings', settingsPath,
                '--append-system-prompt-file', systemPromptFile,
                '--dangerously-load-development-channels', 'server:root-operator',
            ], {
                name: 'xterm-256color',
                cols: 80,
                rows: 24,
                cwd: workspaceDir,
                env: {
                    ...processObject.env,
                    ROOT_OPERATOR_IPC: channelIpcPath,
                    ROOT_OPERATOR_HOOK_LOG: hookLogPath,
                },
            })

            setClaudeProcess(claudeProcess)

            if (claudeProcess && typeof claudeProcess.pid === 'number') {
                try {
                    recordPid(claudeProcess.pid)
                } catch (error) {
                    logDebug(`[CLAUDE] recordPid failed: ${error.message}`)
                }
            }

            setChannelRuntime('waiting_confirm', `Waiting for ${assistantName} to confirm local development access.`, {
                attempt: getChannelStartupAttempt(),
            })

            const sendConfirm = (chars, reason) => {
                const activeClaudeProcess = getClaudeProcess()
                const channelManager = getChannelManager()
                if (!activeClaudeProcess || (channelManager && channelManager.connected)) {
                    return false
                }

                try {
                    activeClaudeProcess.write(chars)
                    logDebug(`[CLAUDE] ${reason}`)
                    setChannelRuntime('waiting_bridge', `${assistantName} is running. Waiting for the chat bridge to come online.`, {
                        attempt: getChannelStartupAttempt(),
                    })
                    return true
                } catch (error) {
                    logDebug(`[CLAUDE] Failed to send confirmation: ${error.message}`)
                    return false
                }
            }

            claudeProcess.on('data', (data) => {
                const text = data.toString()
                logDebug(`[CLAUDE] ${text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').substring(0, 200).trim()}`)

                const normalized = normalizeClaudeBootstrapText(text)
                const waitingForConfirmation =
                    normalized.includes('entertoconfirm') ||
                    normalized.includes('iamusingthisforlocaldevelopment') ||
                    normalized.includes('1iamusingthisforlocaldevelopment')

                if (waitingForConfirmation) {
                    sendConfirm('\r', 'Pressed Enter to confirm local development')
                }
            })

            setChannelConfirmTimers([
                setTimeoutFn(() => sendConfirm('\r', 'Fallback Enter sent after 2s'), 2000),
                setTimeoutFn(() => sendConfirm('\r', 'Second fallback Enter sent after 5s'), 5000),
                setTimeoutFn(() => sendConfirm('1\r', 'Final fallback selection sent after 8s'), 8000),
            ])

            const startupTimer = setTimeoutFn(() => {
                const channelManager = getChannelManager()
                if (channelManager && channelManager.connected) {
                    return
                }

                const timeoutMessage = `${assistantName} never brought the chat bridge online.`
                setChannelRuntime('error', timeoutMessage, {
                    attempt: getChannelStartupAttempt(),
                    lastError: timeoutMessage,
                })

                if (getClaudeProcess()) {
                    logDebug('[CLAUDE] Startup timed out; terminating stuck process')
                    getClaudeProcess().kill()
                } else {
                    scheduleClaudeRestart('Chat bridge startup timed out. Retrying.')
                }
            }, channelStartupTimeoutMs)

            setChannelStartupTimer(startupTimer)

            claudeProcess.on('exit', (exitCode, signal) => {
                logDebug(`[CLAUDE] Exited (code: ${exitCode}, signal: ${signal ?? 'none'})`)
                clearChannelStartupTimer()
                clearChannelConfirmTimers()
                stopClaudeDebugWatcher()
                stopClaudeHookWatcher()
                setClaudeProcess(null)
                removeChannelSocket()

                if (getOperatingMode() === 'channel' && !getIsAppQuitting()) {
                    const exitMessage = exitCode === 0
                        ? `${assistantName} exited before the chat bridge was ready.`
                        : `${assistantName} exited with code ${exitCode}.`
                    setChannelRuntime('error', exitMessage, {
                        attempt: getChannelStartupAttempt(),
                        lastError: exitMessage,
                    })
                    if (getChannelReplyPending()) {
                        setChannelActivity({
                            phase: 'error',
                            label: `${assistantName} stopped`,
                            detail: exitMessage,
                        }, { force: true })
                    } else {
                        resetChannelActivity()
                    }
                    scheduleClaudeRestart(`${assistantName} exited unexpectedly. Retrying.`)
                    return
                }

                resetChannelActivity()
                setChannelRuntime('stopped', `${assistantName} is not running.`)
            })
        } catch (error) {
            logDebug(`[CLAUDE] Failed to spawn: ${error.message}`)
            stopClaudeDebugWatcher()
            stopClaudeHookWatcher()
            setClaudeProcess(null)
            setChannelRuntime('error', `Failed to launch ${assistantName}: ${error.message}`, {
                attempt: getChannelStartupAttempt(),
                lastError: error.message,
            })
            scheduleClaudeRestart(`Failed to launch ${assistantName}. Retrying.`)
        }
    }

    function killClaudeCode() {
        const claudeProcess = getClaudeProcess()
        if (!claudeProcess) {
            return
        }

        logDebug('[CLAUDE] Stopping Claude Code...')
        clearChannelStartupTimer()
        clearChannelConfirmTimers()
        stopClaudeDebugWatcher()
        stopClaudeHookWatcher()
        claudeProcess.kill()
    }

    return {
        normalizeClaudeBootstrapText,
        clearChannelConfirmTimers,
        clearChannelStartupTimer,
        clearChannelRestartTimer,
        scheduleClaudeRestart,
        prepareClaudeWorkspaceRuntime,
        prepareStartupEnvironment,
        cleanupLegacySupervisorArtifacts,
        spawnClaudeCode,
        killClaudeCode,
    }
}

module.exports = {
    init,
}
