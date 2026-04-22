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
let mcpReadyTs = null;

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
          attachments: {
            type: 'array',
            description:
              'Optional absolute paths to local image or video files on the Mac. Images: PNG, JPEG, WebP, GIF (up to 10 MB each). Videos: MP4, QuickTime (.mov), WebM (up to 100 MB each).',
            items: {
              type: 'string',
            },
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
      name: 'ro_memory_search',
      description: 'Search Root Operator dynamic memory for messages older than the channel-history tail already in your system prompt. Use when you need to recall context from earlier conversations not present in recent history. Returns matching fragments with ids, timestamps, and content.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural-language search query.' },
          limit: { type: 'number', description: 'Maximum number of results (default: 5).' },
          chat_id: { type: 'string', description: 'Optional chat_id to scope the search. Omit to search across all.' },
        },
        required: ['query'],
      },
    },
    {
      name: 'ro_memory_save',
      description: 'Save an intentional note to Root Operator dynamic memory. Use for insights, decisions, or context worth preserving beyond the rolling channel history. Bypasses automatic chunking — the full text is stored as a single entry.',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'The text to remember.' },
          chat_id: { type: 'string', description: 'Optional chat_id to associate with this memory.' },
        },
        required: ['content'],
      },
    },
    {
      name: 'ro_memory_update',
      description: 'Update the content of an existing memory entry by id. Re-embeds after the change.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'Memory id (from ro_memory_search results).' },
          content: { type: 'string', description: 'New content to replace the old entry.' },
        },
        required: ['id', 'content'],
      },
    },
    {
      name: 'ro_memory_delete',
      description: 'Delete a memory entry by id. Hard delete — no undo.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'Memory id to delete.' },
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

  if (toolName === '_ping') {
    return {
      content: [{ type: 'text', text: 'pong' }],
    };
  }

  if (toolName === 'reply') {
    const { chat_id, text, attachments } = request.params.arguments;

    if (electronSocket && !electronSocket.destroyed) {
      emitToElectron({
        type: 'claude_activity',
        phase: 'replying',
        label: 'Sending reply',
        detail: 'Claude is sending the final answer back to chat.',
        toolName: 'reply',
        ts: new Date().toISOString(),
      });

      emitToElectron({
        type: 'claude_reply',
        chat_id,
        text,
        attachments: Array.isArray(attachments) ? attachments : undefined,
        ts: new Date().toISOString(),
      });

      return {
        content: [
          { type: 'text', text: `Reply sent to device ${chat_id}` },
        ],
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: 'Error: No Electron connection available',
        },
      ],
      isError: true,
    };
  }

  const schedulerTools = ['ro_schedule', 'ro_list_schedules', 'ro_delete_schedule', 'ro_toggle_schedule', 'ro_run_now'];
  if (schedulerTools.includes(toolName)) {
    return handleSchedulerTool(toolName, request.params.arguments || {});
  }

  const memoryTools = ['ro_memory_search', 'ro_memory_save', 'ro_memory_update', 'ro_memory_delete'];
  if (memoryTools.includes(toolName)) {
    return handleMemoryTool(toolName, request.params.arguments || {});
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

let schedulerCallbacks = new Map();
let schedulerCallId = 0;

function handleSchedulerTool(toolName, args) {
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
      tool: toolName,
      args,
      ts: new Date().toISOString(),
    });
  });
}

let memoryCallbacks = new Map();
let memoryCallId = 0;

function handleMemoryTool(toolName, args) {
  return new Promise((resolve) => {
    if (!electronSocket || electronSocket.destroyed) {
      resolve({
        content: [{ type: 'text', text: 'Error: No Electron connection available' }],
        isError: true,
      });
      return;
    }

    const callId = ++memoryCallId;
    // Memory tools may call into the embedder (first-call warmup can take up
    // to a few seconds); give them more headroom than scheduler tools.
    const timeout = setTimeout(() => {
      memoryCallbacks.delete(callId);
      resolve({
        content: [{ type: 'text', text: 'Error: Memory request timed out' }],
        isError: true,
      });
    }, 15000);

    memoryCallbacks.set(callId, { resolve, timeout });

    emitToElectron({
      type: 'memory_request',
      callId,
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
      // Fail any in-flight scheduler/memory RPCs rather than waiting out the
      // 15s timeout; the peer they were waiting for has just vanished.
      for (const [, cb] of schedulerCallbacks) {
        clearTimeout(cb.timeout);
        cb.resolve({
          content: [{ type: 'text', text: 'Error: Electron bridge disconnected' }],
          isError: true,
        });
      }
      schedulerCallbacks.clear();
      for (const [, cb] of memoryCallbacks) {
        clearTimeout(cb.timeout);
        cb.resolve({
          content: [{ type: 'text', text: 'Error: Electron bridge disconnected' }],
          isError: true,
        });
      }
      memoryCallbacks.clear();
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

  if (msg.type === 'memory_response') {
    const cb = memoryCallbacks.get(msg.callId);
    if (cb) {
      clearTimeout(cb.timeout);
      memoryCallbacks.delete(msg.callId);
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
