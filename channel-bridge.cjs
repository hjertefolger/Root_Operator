/**
 * ROOT OPERATOR - CHANNEL BRIDGE
 * MCP channel server that bridges the Electron app to a Claude Code session.
 * Claude Code spawns this as a subprocess via stdio transport.
 * The Electron main process connects via Unix socket IPC.
 */
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const { createServer: createNetServer } = require('net');
const { existsSync, unlinkSync } = require('fs');

const IPC_PATH = process.env.ROOT_OPERATOR_IPC || '/tmp/root-operator-channel.sock';

let electronSocket = null;
let ipcServer = null;
let shuttingDown = false;
// PR2: sticky "MCP is connected" flag. Once mcp.connect() has resolved, every
// newly-connected Electron socket MUST get a bridge_ready envelope immediately
// (not just the one that happened to be attached when mcp.connect() resolved).
// Otherwise an IPC-side reconnect (Electron flakes, bridge stays up) leaves the
// supervisor waiting for a bridge_ready event that will never come again.
let mcpReadyTs = null;

// PR3: per-dispatch ordinal counter (§N-v4.6). Reset to 0 when supervisor
// sends activate_dispatch. Incremented BEFORE each side-effecting tool call.
let activeDispatchId = null;
let dispatchOrdinal = 0;

function emitToElectron(payload) {
  if (!electronSocket || electronSocket.destroyed) {
    return;
  }

  electronSocket.write(JSON.stringify(payload) + '\n');
}

const mcp = new Server(
  {
    name: 'root-operator-channel',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
      experimental: {
        'claude/channel': {},
      },
    },
    instructions: [
      'Messages arrive as <channel source="root-operator" chat_id="...">content</channel>.',
      'Reply using the reply tool, passing the chat_id from the inbound message tag.',
      'Each chat_id represents a paired device connected via an encrypted Cloudflare tunnel.',
    ].join(' '),
  }
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description: 'Send a reply back to the Root Operator client device',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: {
            type: 'string',
            description: 'Device ID from the inbound channel message',
          },
          text: {
            type: 'string',
            description: 'Reply text to send to the device',
          },
        },
        required: ['chat_id', 'text'],
      },
    },
    {
      name: 'ro_schedule',
      description: 'Create a persistent scheduled job in Root Operator. Unlike built-in cron, these jobs survive session rotation, context compression, and restarts. The job fires by injecting the prompt into the Claude channel.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Human-readable job name' },
          cron: { type: 'string', description: 'Standard 5-field cron expression (minute hour day-of-month month day-of-week). All times are local timezone.' },
          prompt: { type: 'string', description: 'The prompt to inject when the job fires' },
          chat_id: { type: 'string', description: 'Optional device to notify on completion. Omit to broadcast.' },
        },
        required: ['name', 'cron', 'prompt'],
      },
    },
    {
      name: 'ro_list_schedules',
      description: 'List all persistent scheduled jobs in Root Operator.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'ro_delete_schedule',
      description: 'Delete a persistent scheduled job in Root Operator.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Job ID to delete' },
        },
        required: ['id'],
      },
    },
    {
      name: 'ro_toggle_schedule',
      description: 'Enable or disable a persistent scheduled job in Root Operator without deleting it.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Job ID' },
          enabled: { type: 'boolean', description: 'Whether the job should be enabled' },
        },
        required: ['id', 'enabled'],
      },
    },
    {
      name: 'ro_run_now',
      description: 'Manually trigger a scheduled job immediately, regardless of its cron schedule.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Job ID to trigger' },
        },
        required: ['id'],
      },
    },
    {
      name: '_ping',
      description: 'Internal health check. Call this when asked to verify spawn.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;

  // PR3: _ping — local-only health check, no IPC round-trip.
  if (toolName === '_ping') {
    return {
      content: [{ type: 'text', text: 'pong' }],
    };
  }

  // PR3: increment ordinal BEFORE any side-effecting tool call.
  const ordinal = ++dispatchOrdinal;

  if (toolName === 'reply') {
    const { chat_id, text } = request.params.arguments;

    // PR3: reply is now request/response through the effect ledger.
    // Forward to Electron, await commit confirmation.
    emitToElectron({
      type: 'claude_activity',
      phase: 'replying',
      label: 'Sending reply',
      detail: 'Claude is sending the final answer back to chat.',
      toolName: 'reply',
      ts: new Date().toISOString(),
    });

    return handleReplyRequest(chat_id, text, ordinal);
  }

  // --- Scheduler tools: forward to Electron and await response ---
  const schedulerTools = ['ro_schedule', 'ro_list_schedules', 'ro_delete_schedule', 'ro_toggle_schedule', 'ro_run_now'];
  if (schedulerTools.includes(toolName)) {
    return handleSchedulerTool(toolName, request.params.arguments || {}, ordinal);
  }

  return {
    content: [
      {
        type: 'text',
        text: `Unknown tool: ${toolName}`,
      },
    ],
    isError: true,
  };
});

// --- PR3: Reply request/response (effect-ledger path) ---
let replyCallbacks = new Map();
let replyCallId = 0;

function handleReplyRequest(chatId, text, ordinal) {
  return new Promise((resolve) => {
    if (!electronSocket || electronSocket.destroyed) {
      resolve({
        content: [{ type: 'text', text: 'Error: No Electron connection available' }],
        isError: true,
      });
      return;
    }

    const callId = ++replyCallId;
    const timeout = setTimeout(() => {
      replyCallbacks.delete(callId);
      resolve({
        content: [{ type: 'text', text: 'Error: Reply request timed out' }],
        isError: true,
      });
    }, 15000);

    replyCallbacks.set(callId, { resolve, timeout });

    emitToElectron({
      type: 'reply_request',
      callId,
      dispatch_id: activeDispatchId,
      ordinal,
      chat_id: chatId,
      text,
      ts: new Date().toISOString(),
    });
  });
}

// --- Scheduler tool forwarding ---
let schedulerCallbacks = new Map();
let schedulerCallId = 0;

function handleSchedulerTool(toolName, args, ordinal) {
  return new Promise((resolve) => {
    if (!electronSocket || electronSocket.destroyed) {
      resolve({
        content: [{ type: 'text', text: 'Error: No Electron connection available' }],
        isError: true,
      });
      return;
    }

    const callId = ++schedulerCallId;
    const timeout = setTimeout(() => {
      schedulerCallbacks.delete(callId);
      resolve({
        content: [{ type: 'text', text: 'Error: Scheduler request timed out' }],
        isError: true,
      });
    }, 10000);

    schedulerCallbacks.set(callId, { resolve, timeout });

    emitToElectron({
      type: 'scheduler_request',
      callId,
      dispatch_id: activeDispatchId,
      ordinal,
      tool: toolName,
      args,
      ts: new Date().toISOString(),
    });
  });
}

function startIPCServer() {
  try {
    if (existsSync(IPC_PATH)) unlinkSync(IPC_PATH);
  } catch {}

  ipcServer = createNetServer((socket) => {
    electronSocket = socket;
    console.error('[channel-bridge] Electron connected via IPC');

    // PR2: if MCP is already connected (late IPC attach), re-emit bridge_ready
    // so the supervisor on the other side doesn't miss the edge-triggered
    // readiness signal.
    if (mcpReadyTs) {
      socket.write(JSON.stringify({
        type: 'bridge_ready',
        pid: process.pid,
        ts: new Date(mcpReadyTs).toISOString(),
        replayed: true,
      }) + '\n');
    }

    let buffer = '';
    socket.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          handleElectronMessage(msg).catch((error) => {
            console.error(`[channel-bridge] Failed handling message: ${error.message}`);
            emitToElectron({
              type: 'claude_activity',
              phase: 'error',
              label: 'Bridge error',
              detail: 'The chat bridge failed while sending a message to Claude.',
              ts: new Date().toISOString(),
            });
          });
        } catch (error) {
          console.error(`[channel-bridge] Invalid IPC message: ${error}`);
        }
      }
    });

    socket.on('close', () => {
      console.error('[channel-bridge] Electron disconnected');
      electronSocket = null;
    });

    socket.on('error', (error) => {
      console.error(`[channel-bridge] IPC socket error: ${error.message}`);
    });
  });

  ipcServer.listen(IPC_PATH, () => {
    console.error(`[channel-bridge] IPC listening on ${IPC_PATH}`);
  });

  return ipcServer;
}

function cleanupIPCPath() {
  try {
    if (existsSync(IPC_PATH)) unlinkSync(IPC_PATH);
  } catch {}
}

function shutdown(signal = 'shutdown') {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.error(`[channel-bridge] Shutting down (${signal})`);

  if (electronSocket && !electronSocket.destroyed) {
    electronSocket.destroy();
  }

  if (ipcServer) {
    ipcServer.close(() => {
      cleanupIPCPath();
      process.exit(0);
    });
    return;
  }

  cleanupIPCPath();
  process.exit(0);
}

async function handleElectronMessage(msg) {
  // PR3: supervisor tells bridge which dispatch is active so ordinal resets.
  if (msg.type === 'activate_dispatch') {
    activeDispatchId = msg.dispatch_id || null;
    dispatchOrdinal = 0;
    return;
  }

  // PR3: reply committed by main.js, resolve the pending reply call.
  if (msg.type === 'reply_response') {
    const cb = replyCallbacks.get(msg.callId);
    if (cb) {
      clearTimeout(cb.timeout);
      replyCallbacks.delete(msg.callId);
      if (msg.isError) {
        cb.resolve({
          content: [{ type: 'text', text: msg.error || 'Reply commit failed' }],
          isError: true,
        });
      } else {
        cb.resolve({
          content: [{ type: 'text', text: `Reply sent to device ${msg.chat_id || '?'}` }],
        });
      }
    }
    return;
  }

  if (msg.type === 'scheduler_response') {
    const cb = schedulerCallbacks.get(msg.callId);
    if (cb) {
      clearTimeout(cb.timeout);
      schedulerCallbacks.delete(msg.callId);
      cb.resolve({
        content: [{ type: 'text', text: msg.result }],
        isError: msg.isError || false,
      });
    }
    return;
  }

  if (msg.type === 'client_message') {
    const content = `<channel source="root-operator" chat_id="${msg.chat_id}">${msg.content}</channel>`;

    await mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content,
        meta: {
          chat_id: msg.chat_id,
          user_id: msg.user_id || msg.chat_id,
          ts: msg.ts || new Date().toISOString(),
        },
      },
    });

    emitToElectron({
      type: 'claude_activity',
      phase: 'forwarded',
      label: 'Delivered to Claude',
      detail: 'The chat bridge handed your message to Claude.',
      ts: new Date().toISOString(),
    });

    console.error(`[channel-bridge] Forwarded message from ${msg.chat_id} to Claude`);
  }
}

async function main() {
  startIPCServer();

  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  console.error('[channel-bridge] MCP channel server running');

  // PR2 bridge-ready handshake. ChannelManager's `connected` event fires when
  // the Unix socket accepts, which is BEFORE mcp.connect() has resolved. For
  // replay-after-respawn we need the supervisor to gate on the real readiness
  // of the MCP stdio transport, not just "IPC socket up." Emit an explicit
  // bridge_ready envelope here so the main process can distinguish the two.
  // Also latch `mcpReadyTs` so later IPC reconnects can re-emit readiness.
  mcpReadyTs = Date.now();
  emitToElectron({
    type: 'bridge_ready',
    pid: process.pid,
    ts: new Date(mcpReadyTs).toISOString(),
  });
}

main().catch((error) => {
  console.error(`[channel-bridge] Fatal: ${error}`);
  process.exit(1);
});

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('beforeExit', () => cleanupIPCPath());
process.once('exit', () => cleanupIPCPath());
