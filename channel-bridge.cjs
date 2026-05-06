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
              'Optional absolute paths to local image, video, or doc files on the Mac. Images: PNG, JPEG, WebP, GIF (up to 10 MB each). Videos: MP4, QuickTime (.mov), WebM (up to 25 MB each). Docs: Markdown (.md, .markdown), plain text (.txt) up to 1 MB each.',
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
      name: 'agent_move_to_cursor',
      description: 'Travel your agent body (the blue dot) to the user\'s cursor and dwell there in ACTIVE mode (slightly larger, with a soft accent halo). By default the dot is already attached to the user\'s cursor in AMBIENT mode (small, spring-following) — call this when you want to visibly arrive in the user\'s area of interest, e.g. when transitioning into a focused task or after you\'ve been off in another app. Pass optional offsets if you want to land a specific number of pixels away from the cursor (defaults: 30 right, 0 down).',
      inputSchema: {
        type: 'object',
        properties: {
          offset_x: { type: 'number', description: 'Horizontal offset from the cursor in pixels. Default 30 (right of cursor).' },
          offset_y: { type: 'number', description: 'Vertical offset from the cursor in pixels. Default 0.' },
        },
      },
    },
    {
      name: 'agent_move_to',
      description: 'Move your agent body (the blue dot) to an explicit screen-space point and dwell there. Used when you want to look at a specific element you already know the coordinates of (e.g. resolved via agent_read_at_cursor).',
      inputSchema: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'Target x coordinate in screen pixels.' },
          y: { type: 'number', description: 'Target y coordinate in screen pixels.' },
        },
        required: ['x', 'y'],
      },
    },
    {
      name: 'agent_park',
      description: 'Return your agent body to the user\'s cursor and resume the AMBIENT spring-follow (small, attached to cursor). Call this when you finish a task — it signals "I\'m back beside you, idle." The cursor is home; there is no Dock anchor in this model.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'agent_read_at_cursor',
      description: 'Read the text under the user\'s current cursor via macOS accessibility. Returns the full element value, the selected portion (if any), the element role, and its frame. Use this when the user asks you to look at, rewrite, or summarize text they\'re pointing at. Does NOT move the cursor or any UI.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'agent_read_focused',
      description: 'Read text from the currently focused UI element via macOS accessibility. Useful when the user is composing in a text field and the cursor isn\'t hovering it. Returns the same shape as agent_read_at_cursor.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'agent_write_selection',
      description: 'Replace the user\'s current text selection with new text via the macOS accessibility channel. NEVER call without explicit user approval — your job is to show the proposed text in the bubble first, then call this only after the user confirms. Default: requires a non-empty selection (refuses to overwrite a whole field). To overwrite the entire focused field (rare, ask first), pass replace_all=true. Refuses sensitive roles (passwords, secure inputs). Capped at 8000 chars and rate-limited to one write per 750ms.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The text to write. Must be non-empty.' },
          replace_all: { type: 'boolean', description: 'If true, replace the entire focused field even with no selection. Default false. Use only when the user has explicitly asked to replace the whole field.' },
          force: { type: 'boolean', description: 'Override the recent user-activity guard after explicit consent.' },
        },
        required: ['text'],
      },
    },
    {
      name: 'agent_check_ax',
      description: 'Check whether the macOS Accessibility permission is granted for Root Operator. Returns {trusted: true|false}. Call this once at the start of any AX-using flow so you can give the user an actionable error if the permission is missing.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'agent_read_window',
      description: 'Read the structured AX tree of the active app\'s focused window. Returns role/label/frame/value for each node up to 8 levels deep, capped at 500 nodes. Use this when you need spatial + semantic awareness of the surrounding UI — to know what buttons, fields, panels, and rows exist in the room you\'re operating in. Does NOT move the cursor.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'agent_discover_app',
      description: 'Build a compact live app map for the frontmost or named macOS app: focused window/element, text inputs, pressable controls, menu buttons, top menu inventory, role counts, and remembered workflows for this app. Use this as the first step in unfamiliar apps before acting; it helps the agent learn available affordances without guessing. Menu discovery may briefly open app menus through AX but does not press leaf commands.',
      inputSchema: {
        type: 'object',
        properties: {
          app: { type: 'string', description: 'Optional app name or bundle id. Defaults to the frontmost app.' },
          bundle_id: { type: 'string', description: 'Optional bundle id. Equivalent to app for lookup.' },
          include_menus: { type: 'boolean', description: 'Whether to inventory top-level menus. Default true. Set false for a faster pure window scan.' },
          activate: { type: 'boolean', description: 'Whether to activate the named app before discovery. Default true when app/bundle_id is provided.' },
        },
      },
    },
    {
      name: 'agent_list_app_workflows',
      description: 'List learned computer-use workflows remembered for the frontmost or named app. Call after agent_discover_app when deciding whether a proven app-specific recipe already exists.',
      inputSchema: {
        type: 'object',
        properties: {
          app: { type: 'string', description: 'Optional app name or bundle id. Defaults to the frontmost app.' },
          bundle_id: { type: 'string', description: 'Optional bundle id. Equivalent to app for lookup.' },
        },
      },
    },
    {
      name: 'agent_remember_app_workflow',
      description: 'Save a successful app-specific workflow recipe so future agents can reuse it. Use only after verifying the workflow through the real bridge. Store semantic agent_act steps, selectors, preconditions, postconditions, and whether the workflow is destructive.',
      inputSchema: {
        type: 'object',
        properties: {
          app: { type: 'string', description: 'Optional app name or bundle id. Defaults to the frontmost app.' },
          bundle_id: { type: 'string', description: 'Optional bundle id. Equivalent to app for lookup.' },
          id: { type: 'string', description: 'Optional stable workflow id. Defaults to a slug from name.' },
          name: { type: 'string', description: 'Short workflow name.' },
          summary: { type: 'string', description: 'What this workflow does and when to use it.' },
          preconditions: { type: 'array', items: { type: 'string' }, description: 'Required visible/app state before running.' },
          postconditions: { type: 'array', items: { type: 'string' }, description: 'State to verify after running.' },
          selectors: { type: 'object', description: 'Stable selectors discovered for this app.' },
          steps: { type: 'array', items: { type: 'object' }, description: 'Verified semantic action steps, usually agent_act steps.' },
          destructive: { type: 'boolean', description: 'True if the workflow can delete, send, submit, spend, or otherwise have irreversible effects.' },
          last_verified_at: { type: 'string', description: 'Optional ISO timestamp. Defaults to now.' },
          success_count: { type: 'number', description: 'Optional success counter. Defaults to 1.' },
        },
        required: ['name'],
      },
    },
    {
      name: 'agent_read_subtree',
      description: 'Read a scoped AX subtree by resolving a label/role target first, then walking only that subtree. Use this when read_window is too broad or sidebar/table content hides the target. Supports role, label, index, near_x/near_y, skip_role(s), and prefer_role(s). Pure AX read; does not move the cursor.',
      inputSchema: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Optional label/value substring to resolve the subtree root.' },
          role: { type: 'string', description: 'Optional AX role for the subtree root, e.g. AXTextArea or AXScrollArea.' },
          index: { type: 'number', description: 'Optional 0-based match index.' },
          near_x: { type: 'number', description: 'Optional screen-x for proximity disambiguation, paired with near_y.' },
          near_y: { type: 'number', description: 'Optional screen-y for proximity disambiguation.' },
          skip_roles: { type: 'array', items: { type: 'string' }, description: 'Optional AX roles to omit while walking the subtree.' },
          prefer_roles: { type: 'array', items: { type: 'string' }, description: 'Optional AX roles to prioritize before lower-value branches.' },
          exact: { type: 'boolean', description: 'If true, require exact label/value match and return not_found without slower substring fallback.' },
        },
      },
    },
    {
      name: 'agent_find_element',
      description: 'Find a UI element in the active app\'s focused window by label substring (case-insensitive) and optionally by role. Returns the element\'s role, label, screen-space frame, total match count and selected match index. By default returns the best lexical match (title > description > help > value). When labels collide ("More" matching multiple toolbar items), use `index` to pick the Nth-best match (0-based) or `near` to bias toward proximity to a screen point.',
      inputSchema: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Substring to match against the element\'s title, description, help, or value (case-insensitive).' },
          role: { type: 'string', description: 'Optional AX role to constrain the search (e.g. "AXButton", "AXLink", "Button" — "AX" prefix optional).' },
          index: { type: 'number', description: 'Optional 0-based index into the sorted match list. 0 = best match (default). Use to disambiguate when several elements match.' },
          near_x: { type: 'number', description: 'Optional screen-x; when paired with near_y, sorts matches by distance ascending (closest first). Useful for "the More button at x≈1010".' },
          near_y: { type: 'number', description: 'Optional screen-y companion to near_x.' },
        },
        required: ['label'],
      },
    },
    {
      name: 'agent_focus_element',
      description: 'Resolve an AX element by label and/or role, then perform a verified AX focus transaction without moving the hardware cursor. The native helper activates/raises the target app/window, focuses the element, and refuses success unless a fresh helper process can read the same focused target. Use this to enter a cold app window before read_focused, select_*, type_text, or menu formatting. Same disambiguation as agent_find_element; pass force=true only after explicit consent if recent user activity is detected.',
      inputSchema: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Optional label/value substring. Required unless role is specific enough.' },
          role: { type: 'string', description: 'Optional AX role, e.g. AXTextArea.' },
          index: { type: 'number', description: 'Optional 0-based match index.' },
          near_x: { type: 'number', description: 'Optional screen-x for proximity disambiguation, paired with near_y.' },
          near_y: { type: 'number', description: 'Optional screen-y companion to near_x.' },
          prefer_roles: { type: 'array', items: { type: 'string' }, description: 'Optional roles to prioritize while resolving.' },
          force: { type: 'boolean', description: 'Override the recent user-activity guard after explicit consent.' },
        },
      },
    },
    {
      name: 'agent_focus_at',
      description: 'AX hit-test a screen coordinate and focus that element without sending a mouse event. Use this when you know the target coordinate and want a clean AX focus handoff instead of HID click.',
      inputSchema: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'Screen x coordinate.' },
          y: { type: 'number', description: 'Screen y coordinate.' },
          force: { type: 'boolean', description: 'Override the recent user-activity guard after explicit consent.' },
        },
        required: ['x', 'y'],
      },
    },
    {
      name: 'agent_recent_events',
      description: 'Read the most recent passive-awareness events from the macOS Accessibility observer — focused window changes, focused element changes, selected-text changes, value changes, app activations. Use this to know what just happened on screen before you act ("the user just selected text in Mail"). Returns one event per line, ordered oldest → newest within the buffer (last 50 events). Optional filters: count (cap), since_ms (only events newer than now-since_ms).',
      inputSchema: {
        type: 'object',
        properties: {
          count: { type: 'number', description: 'Maximum number of events to return (returns the most recent).' },
          since_ms: { type: 'number', description: 'Only return events newer than this many milliseconds ago.' },
        },
      },
    },
    {
      name: 'agent_run_chain',
      description: 'Execute an atomic native macOS action chain in one ax-helper process. Use this for cold-start computer-use flows where focus may not survive MCP round trips. Steps can launch apps, wait for app windows, press named AX controls, resolve target elements, focus, set or insert text, select ranges, invoke menus, read, and verify values. Captures cursor position before and after and fails honestly if the helper reports an error.',
      inputSchema: {
        type: 'object',
        properties: {
          cursor_tolerance: { type: 'number', description: 'Allowed cursor delta in screen points. Default 1.' },
          steps: {
            type: 'array',
            description: 'Ordered native chain steps. Each step is an object with op plus op-specific fields.',
            items: { type: 'object' },
          },
        },
        required: ['steps'],
      },
    },
    {
      name: 'agent_act',
      description: 'Execute an atomic generic macOS computer-use action list in one ax-helper process. Prefer this over adding new named tools. Generic steps include launch/wait_window, resolve by app/window/system scope, inspect, perform_action for any AX action exposed by the element (AXPress, AXShowMenu, AXIncrement, custom actions), set_attribute for settable AX attributes (AXValue, AXSelected, AXFocused, AXSelectedText), cursor-invariant HID fallback, read, and verify_present/verify_absent. Existing agent_run_chain steps are still accepted for compatibility.',
      inputSchema: {
        type: 'object',
        properties: {
          cursor_tolerance: { type: 'number', description: 'Allowed hardware cursor delta in screen points. Default 1.' },
          force: { type: 'boolean', description: 'Override the recent user-activity guard after explicit consent.' },
          steps: {
            type: 'array',
            description: 'Ordered generic native steps. Each step is an object with op plus op-specific fields.',
            items: { type: 'object' },
          },
        },
        required: ['steps'],
      },
    },
    {
      name: 'agent_press_named',
      description: 'Find a UI element by label substring (and optional role) in the active app\'s focused window and perform an AX press action on it (clicks the button, activates the link, etc.). Goes through the macOS accessibility channel — does NOT move the user\'s cursor or synthesize a click event. Use this for buttons, links, menu items the user named ("press the Send button"). Same disambiguation as agent_find_element: pass `index` or `near_x`/`near_y` when the label matches multiple elements. Prefer to confirm with the user first for any destructive action.',
      inputSchema: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Substring to match against the element\'s title, description, or help (case-insensitive).' },
          role: { type: 'string', description: 'Optional AX role to constrain the search (e.g. "AXButton", "AXLink").' },
          index: { type: 'number', description: 'Optional 0-based index into the sorted match list. 0 = best match (default).' },
          near_x: { type: 'number', description: 'Optional screen-x; when paired with near_y, sorts matches by distance to (near_x, near_y) ascending.' },
          near_y: { type: 'number', description: 'Optional screen-y companion to near_x.' },
        },
        required: ['label'],
      },
    },
    {
      name: 'agent_press_at',
      description: 'AX hit-test a screen coordinate and perform AXPress on the element at that point if it exposes the press action. Does not move the hardware cursor. Use this before HID click when AX can press the target cleanly.',
      inputSchema: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'Screen x coordinate.' },
          y: { type: 'number', description: 'Screen y coordinate.' },
          force: { type: 'boolean', description: 'Override the recent user-activity guard after explicit consent.' },
        },
        required: ['x', 'y'],
      },
    },
    {
      name: 'agent_click_at',
      description: 'Borrow the HID cursor lane and post a real mouse move + click at screen coordinates. Supports left/right/middle and single/double/triple clicks. The avatar enters DRIVING state while the cursor is borrowed. Refuses on recent user activity unless force=true after explicit consent.',
      inputSchema: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'Screen x coordinate.' },
          y: { type: 'number', description: 'Screen y coordinate.' },
          button: { type: 'string', description: 'left, right, or middle. Default left.' },
          count: { type: 'number', description: '1, 2, or 3 clicks. Default 1.' },
          force: { type: 'boolean', description: 'Override the recent user-activity guard after explicit consent.' },
        },
        required: ['x', 'y'],
      },
    },
    {
      name: 'agent_drag',
      description: 'Borrow the HID cursor lane and perform a real mouse drag from one screen coordinate to another with eased intermediate moves. Required for Finder drag/drop, sliders, canvas tools, and partial-AX apps. Avatar follows the cursor while dragging.',
      inputSchema: {
        type: 'object',
        properties: {
          from_x: { type: 'number', description: 'Source screen x coordinate.' },
          from_y: { type: 'number', description: 'Source screen y coordinate.' },
          to_x: { type: 'number', description: 'Destination screen x coordinate.' },
          to_y: { type: 'number', description: 'Destination screen y coordinate.' },
          duration_ms: { type: 'number', description: 'Drag duration, 50..5000ms. Default 450.' },
          button: { type: 'string', description: 'left, right, or middle. Default left.' },
          force: { type: 'boolean', description: 'Override the recent user-activity guard after explicit consent.' },
        },
        required: ['from_x', 'from_y', 'to_x', 'to_y'],
      },
    },
    {
      name: 'agent_scroll_at',
      description: 'Borrow the HID cursor lane, move to a screen coordinate, and post a pixel scroll wheel event. Use when AX scrolling is unavailable or the target is a canvas/web surface.',
      inputSchema: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'Screen x coordinate.' },
          y: { type: 'number', description: 'Screen y coordinate.' },
          dx: { type: 'number', description: 'Horizontal scroll delta in pixels.' },
          dy: { type: 'number', description: 'Vertical scroll delta in pixels.' },
          force: { type: 'boolean', description: 'Override the recent user-activity guard after explicit consent.' },
        },
        required: ['x', 'y', 'dx', 'dy'],
      },
    },
    {
      name: 'agent_hover_at',
      description: 'Borrow the HID cursor lane and move the cursor to a screen coordinate without clicking. Useful for hover menus and tooltips. The avatar enters DRIVING state while the cursor is borrowed.',
      inputSchema: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'Screen x coordinate.' },
          y: { type: 'number', description: 'Screen y coordinate.' },
          duration_ms: { type: 'number', description: 'Optional hover dwell, 0..5000ms.' },
          force: { type: 'boolean', description: 'Override the recent user-activity guard after explicit consent.' },
        },
        required: ['x', 'y'],
      },
    },
    {
      name: 'agent_keystroke',
      description: 'Post a single keyboard event (down + up) via macOS CGEvent — does NOT move the user\'s hardware cursor. Routes the keystroke to whatever element currently has system focus, so this requires a focused element (refuses with no_focus otherwise). Use named keys ("return", "esc", "tab", "up", "down", "left", "right", "j", "f5") or numeric virtual codes ("0x26"). Combine with `mods` (CSV: cmd, shift, opt, ctrl, fn) for chord shortcuts (Cmd+Shift+J, Cmd+S). Refuses by default if user activity is detected in the last ~1.2s — pass force=true to override after explicit user consent. Rate-limited to one keystroke per 200ms. Prefer agent_menu_command for menu invocations and agent_select_* for text selection — keystrokes are the right tool for app-specific shortcuts and key-driven navigation.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Named key or numeric virtual key code. Examples: "return", "esc", "tab", "left", "right", "j", "f5", "0x26".' },
          mods: { type: 'string', description: 'Optional comma-separated modifier keys: cmd,shift,opt,ctrl,fn.' },
          force: { type: 'boolean', description: 'Override the user-activity guard. Use only after explicit user consent (e.g. user said "go ahead even if I just typed").' },
        },
        required: ['key'],
      },
    },
    {
      name: 'agent_keystroke_global',
      description: 'Post a single keyboard event without requiring a focused AX element. Use for apps/windows where only the app has focus or AX focus is unavailable. Same key/mod syntax, user-activity guard, and rate limit as agent_keystroke.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Named key or numeric virtual key code.' },
          mods: { type: 'string', description: 'Optional comma-separated modifiers: cmd,shift,opt,ctrl,fn.' },
          force: { type: 'boolean', description: 'Override the recent user-activity guard after explicit consent.' },
        },
        required: ['key'],
      },
    },
    {
      name: 'agent_key_hold',
      description: 'Post key-down, hold for duration_ms, then key-up. Use for app shortcuts, games, sliders, or controls that distinguish held keys. Requires focused AX element unless global=true. Same user-activity guard and rate limit as keystroke.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Named key or numeric virtual key code.' },
          mods: { type: 'string', description: 'Optional comma-separated modifiers.' },
          duration_ms: { type: 'number', description: 'Hold duration, 10..5000ms. Default 250.' },
          global: { type: 'boolean', description: 'If true, skip the focused-element requirement.' },
          force: { type: 'boolean', description: 'Override the recent user-activity guard after explicit consent.' },
        },
        required: ['key'],
      },
    },
    {
      name: 'agent_modifier_latch',
      description: 'Press one or more modifiers down, hold for duration_ms, then release. Useful for apps that react to a held modifier without a character key. Same user-activity guard and rate limit as keystroke.',
      inputSchema: {
        type: 'object',
        properties: {
          mods: { type: 'string', description: 'Comma-separated modifiers: cmd,shift,opt,ctrl,fn.' },
          duration_ms: { type: 'number', description: 'Latch duration, 10..5000ms. Default 250.' },
          force: { type: 'boolean', description: 'Override the recent user-activity guard after explicit consent.' },
        },
        required: ['mods'],
      },
    },
    {
      name: 'agent_type_text',
      description: 'Type Unicode text via macOS CGEvent into the focused element — exercises real key handling (paragraph styling, autocomplete, IME, app key handlers) unlike AX value-write. Use this for natural-typing flows where character-by-character behavior matters; use agent_write_selection when you want a clean AX replacement that bypasses key handlers. Requires focused element. Same user-activity guard and rate limit as keystroke (one per 750ms). Hard-capped at 2000 UTF-16 code units (more conservative than AX writes since this is a real keyboard-synthesis path).',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to type. Must be non-empty, max 2000 UTF-16 code units.' },
          force: { type: 'boolean', description: 'Override the user-activity guard.' },
        },
        required: ['text'],
      },
    },
    {
      name: 'agent_select_range',
      description: 'Select a specific character range in the currently focused text element via the AX kAXSelectedTextRangeAttribute — does NOT move the cursor or send keystrokes. Useful for selecting a known offset+length without resorting to Cmd+A or arrow-key navigation. Length is automatically capped at the remaining text (so selecting more than exists never overruns).',
      inputSchema: {
        type: 'object',
        properties: {
          location: { type: 'number', description: '0-based character offset where the selection starts.' },
          length: { type: 'number', description: 'Number of characters to select. Capped at remaining text.' },
          force: { type: 'boolean', description: 'Override the recent user-activity guard after explicit consent.' },
        },
        required: ['location', 'length'],
      },
    },
    {
      name: 'agent_select_all',
      description: 'Select every character in the currently focused text element via AX (not Cmd+A). Cursor and keyboard are untouched. Returns the total character count for downstream sizing decisions.',
      inputSchema: {
        type: 'object',
        properties: {
          force: { type: 'boolean', description: 'Override the recent user-activity guard after explicit consent.' },
        },
      },
    },
    {
      name: 'agent_select_substring',
      description: 'Find a substring in the currently focused text element and select it via AX (kAXSelectedTextRangeAttribute). UTF-16 code-unit accurate so it works correctly with native text apps (Notes, Mail, TextEdit). Pick a specific occurrence with `occurrence` (0-based, default 0 = first match).',
      inputSchema: {
        type: 'object',
        properties: {
          needle: { type: 'string', description: 'Text to find within the focused element.' },
          occurrence: { type: 'number', description: '0-based occurrence index (default 0 = first match).' },
          force: { type: 'boolean', description: 'Override the recent user-activity guard after explicit consent.' },
        },
        required: ['needle'],
      },
    },
    {
      name: 'agent_menu_command',
      description: 'Invoke a menu item in the frontmost app by walking the AXMenuBar with a path of titles (e.g. ["Format","Body"], ["Edit","Find","Find…"]). Pure AX — no keystrokes, no menu visually flashing open. Match strategy: exact title match first, then unique case-insensitive prefix; ambiguous prefix matches return ambiguous_menu_segment. Descends through any AXMenu intermediate container automatically and polls briefly for child population after opening a non-leaf. Same user-activity guard as keystroke / type-text — refused if the user just switched apps or opened a menu (override with force=true after explicit consent).',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'array',
            description: 'Menu path as an array of titles, top-level first. E.g. ["Format","Body"].',
            items: { type: 'string' },
          },
          force: { type: 'boolean', description: 'Override the user-activity guard.' },
        },
        required: ['path'],
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

  const agentTools = [
    'agent_move_to_cursor',
    'agent_move_to',
    'agent_park',
    'agent_read_at_cursor',
    'agent_read_focused',
    'agent_write_selection',
    'agent_check_ax',
    'agent_read_window',
    'agent_discover_app',
    'agent_list_app_workflows',
    'agent_remember_app_workflow',
    'agent_read_subtree',
    'agent_find_element',
    'agent_focus_element',
    'agent_focus_at',
    'agent_press_named',
    'agent_press_at',
    'agent_run_chain',
    'agent_act',
    'agent_click_at',
    'agent_drag',
    'agent_scroll_at',
    'agent_hover_at',
    'agent_recent_events',
    'agent_keystroke',
    'agent_keystroke_global',
    'agent_key_hold',
    'agent_modifier_latch',
    'agent_type_text',
    'agent_select_range',
    'agent_select_all',
    'agent_select_substring',
    'agent_menu_command',
  ];
  if (agentTools.includes(toolName)) {
    return handleAgentTool(toolName, request.params.arguments || {});
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

let agentCallbacks = new Map();
let agentCallId = 0;

function handleAgentTool(toolName, args) {
  return new Promise((resolve) => {
    if (!electronSocket || electronSocket.destroyed) {
      resolve({
        content: [{ type: 'text', text: 'Error: No Electron connection available' }],
        isError: true,
      });
      return;
    }

    const callId = ++agentCallId;
    // Agent AX calls shell out to the Swift helper. Simple reads are fast,
    // but real app workflows such as Notes create/format/delete chains can
    // take several seconds and should fail with helper detail, not a bridge
    // race timeout.
    const timeout = setTimeout(() => {
      agentCallbacks.delete(callId);
      resolve({
        content: [{ type: 'text', text: 'Error: Agent action timed out' }],
        isError: true,
      });
    }, 30000);

    agentCallbacks.set(callId, { resolve, timeout });

    emitToElectron({
      type: 'agent_request',
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
      for (const [, cb] of agentCallbacks) {
        clearTimeout(cb.timeout);
        cb.resolve({
          content: [{ type: 'text', text: 'Error: Electron bridge disconnected' }],
          isError: true,
        });
      }
      agentCallbacks.clear();
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

  if (msg.type === 'agent_response') {
    const cb = agentCallbacks.get(msg.callId);
    if (cb) {
      clearTimeout(cb.timeout);
      agentCallbacks.delete(msg.callId);
      cb.resolve({
        content: [{ type: 'text', text: msg.result }],
        isError: msg.isError || false,
      });
    }
    return;
  }

  if (msg.type === 'client_message') {
    // Append a system-reminder so Claude is reminded — at the point of action,
    // not just at session start — to use the reply tool instead of plain text.
    // Plain prose output stays in the local Mac console and never reaches the
    // paired device; this reminder closes that gap on every inbound.
    const reminder = '<system-reminder>Reply naturally via the reply tool. Plaintext replies never reach your human.</system-reminder>';
    const content = `<channel source="root-operator" chat_id="${msg.chat_id}">${msg.content}</channel>\n${reminder}`;

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
