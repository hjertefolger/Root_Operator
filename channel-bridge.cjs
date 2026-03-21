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
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'reply') {
    const { chat_id, text } = request.params.arguments;

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

  return {
    content: [
      {
        type: 'text',
        text: `Unknown tool: ${request.params.name}`,
      },
    ],
    isError: true,
  };
});

function startIPCServer() {
  try {
    if (existsSync(IPC_PATH)) unlinkSync(IPC_PATH);
  } catch {}

  ipcServer = createNetServer((socket) => {
    electronSocket = socket;
    console.error('[channel-bridge] Electron connected via IPC');

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
}

main().catch((error) => {
  console.error(`[channel-bridge] Fatal: ${error}`);
  process.exit(1);
});

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('beforeExit', () => cleanupIPCPath());
process.once('exit', () => cleanupIPCPath());
