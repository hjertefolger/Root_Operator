/**
 * ROOT OPERATOR - CHANNEL BRIDGE
 * MCP channel server that bridges the Electron app to a Claude Code session.
 * Claude Code spawns this as a subprocess via stdio transport.
 * The Electron main process connects via Unix socket IPC.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createServer as createNetServer, type Socket } from "net";
import { existsSync, unlinkSync } from "fs";

// --- Configuration ---
const IPC_PATH =
  process.env.ROOT_OPERATOR_IPC || "/tmp/root-operator-channel.sock";

// --- State ---
let electronSocket: Socket | null = null;

// --- MCP Server Setup ---
const mcp = new Server(
  {
    name: "root-operator-channel",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
      experimental: {
        "claude/channel": {},
      },
    },
    instructions: [
      'Messages arrive as <channel source="root-operator" chat_id="...">content</channel>.',
      "Reply using the reply tool, passing the chat_id from the inbound message tag.",
      "Each chat_id represents a paired device connected via an encrypted Cloudflare tunnel.",
    ].join(" "),
  }
);

// --- Reply Tool ---
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description: "Send a reply back to the Root Operator client device",
      inputSchema: {
        type: "object" as const,
        properties: {
          chat_id: {
            type: "string",
            description: "Device ID from the inbound channel message",
          },
          text: {
            type: "string",
            description: "Reply text to send to the device",
          },
        },
        required: ["chat_id", "text"],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "reply") {
    const { chat_id, text } = request.params.arguments as {
      chat_id: string;
      text: string;
    };

    if (electronSocket && !electronSocket.destroyed) {
      const payload = JSON.stringify({
        type: "claude_reply",
        chat_id,
        text,
        ts: new Date().toISOString(),
      });
      electronSocket.write(payload + "\n");

      return {
        content: [
          { type: "text" as const, text: `Reply sent to device ${chat_id}` },
        ],
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: "Error: No Electron connection available",
        },
      ],
      isError: true,
    };
  }

  return {
    content: [
      {
        type: "text" as const,
        text: `Unknown tool: ${request.params.name}`,
      },
    ],
    isError: true,
  };
});

// --- IPC Server (receives messages from Electron main process) ---
function startIPCServer() {
  // Clean up stale socket file
  try {
    if (existsSync(IPC_PATH)) unlinkSync(IPC_PATH);
  } catch {}

  const ipcServer = createNetServer((socket) => {
    electronSocket = socket;
    console.error("[channel-bridge] Electron connected via IPC");

    let buffer = "";
    socket.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          handleElectronMessage(msg);
        } catch (e) {
          console.error(`[channel-bridge] Invalid IPC message: ${e}`);
        }
      }
    });

    socket.on("close", () => {
      console.error("[channel-bridge] Electron disconnected");
      electronSocket = null;
    });

    socket.on("error", (err: NodeJS.ErrnoException) => {
      console.error(`[channel-bridge] IPC socket error: ${err.message}`);
    });
  });

  ipcServer.listen(IPC_PATH, () => {
    console.error(`[channel-bridge] IPC listening on ${IPC_PATH}`);
  });

  return ipcServer;
}

// --- Handle inbound messages from Electron ---
async function handleElectronMessage(msg: {
  type: string;
  chat_id: string;
  content: string;
  user_id?: string;
  ts?: string;
}) {
  if (msg.type === "client_message") {
    const content = `<channel source="root-operator" chat_id="${msg.chat_id}">${msg.content}</channel>`;

    await mcp.notification({
      method: "notifications/claude/channel",
      params: {
        content,
        meta: {
          chat_id: msg.chat_id,
          user_id: msg.user_id || msg.chat_id,
          ts: msg.ts || new Date().toISOString(),
        },
      },
    });

    console.error(
      `[channel-bridge] Forwarded message from ${msg.chat_id} to Claude`
    );
  }
}

// --- Start ---
async function main() {
  startIPCServer();

  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  console.error("[channel-bridge] MCP channel server running");
}

main().catch((err) => {
  console.error(`[channel-bridge] Fatal: ${err}`);
  process.exit(1);
});
