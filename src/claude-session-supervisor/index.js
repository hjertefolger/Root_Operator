/**
 * ClaudeSessionSupervisor - public entry point
 *
 * Design doc: ~/.root-operator/workspace/design/claude-session-supervisor-v4.md
 */

const { DispatchStore } = require('./dispatch-store');
const { Runtime, HOOK_BASENAME, DEBUG_BASENAME, MAX_EPOCHS_KEPT } = require('./runtime');
const { IncidentLogger } = require('./incidents');
const {
    ClaudeSessionSupervisor,
    createSupervisor,
    DEFAULT_SILENCE_MS,
    SAFETY_NET_MULTIPLIER,
} = require('./orchestrator');
const {
    STATES,
    DISPATCH_STATES,
    TERMINAL_DISPATCH_STATES,
    transitionSupervisor,
    transitionDispatch,
    replayCapForSource,
    canReplayDispatch,
} = require('./policy');

module.exports = {
    // Stores / adapters
    DispatchStore,
    Runtime,
    IncidentLogger,

    // Orchestrator
    ClaudeSessionSupervisor,
    createSupervisor,

    // Pure policy
    STATES,
    DISPATCH_STATES,
    TERMINAL_DISPATCH_STATES,
    transitionSupervisor,
    transitionDispatch,
    replayCapForSource,
    canReplayDispatch,

    // Constants
    DEFAULT_SILENCE_MS,
    SAFETY_NET_MULTIPLIER,
    HOOK_BASENAME,
    DEBUG_BASENAME,
    MAX_EPOCHS_KEPT,
};
