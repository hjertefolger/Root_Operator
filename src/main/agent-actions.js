/**
 * ROOT OPERATOR — AGENT ACTIONS
 *
 * Handles the agent_* MCP tools by routing them to:
 *   — agent-avatar (for motion: moveTo / moveToCursor / park)
 *   — the Swift AX helper binary (for AX read/write/check)
 *
 * The Swift helper is shipped at src/main/native/ax-helper/ax-helper
 * (built from main.swift). When the app is bundled, the binary is
 * resolved relative to the app path; in dev it sits next to source.
 */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const presenceMotionConfig = require('../shared/presence-motion-config.json');

const HELPER_TIMEOUT_MS = 45000; // Long launch/wait AX chains need room to settle without helper timeouts.

// Hard caps on AX write payloads. The AX channel can technically accept
// long strings but the user-visible blast radius scales with size.
const MAX_WRITE_TEXT_LENGTH = 8000; // characters

// Rate limit for AX writes. Prevents runaway loops (e.g. an LLM stuck in
// a write/observe cycle) from rapid-firing edits into the user's app.
const WRITE_INTERVAL_MIN_MS = 750;

// Same idea for AX presses. A button-press loop has the same blast
// radius as a write loop — could click "Delete" repeatedly on a list,
// drain a queue, send messages. Keep button presses paced.
const PRESS_INTERVAL_MIN_MS = 750;

// Keystrokes are higher-frequency than presses — chord shortcuts and
// typed text both compose multiple keys in a row. Rate-limit at the
// per-keystroke layer is tighter than press; the type-text path takes
// a single helper call so it gets the same window as a write.
const KEYSTROKE_INTERVAL_MIN_MS = 200;
const TYPE_TEXT_INTERVAL_MIN_MS = 750;
const HID_INTERVAL_MIN_MS = 250;
const FOCUS_INTERVAL_MIN_MS = 250;
// Keyboard-synthesis path is more conservative than AX value-write
// because a single CGEvent unicode string types into focus, exercises
// app key handlers, and behaves less like natural typing for long
// payloads. Keep this short until chunked-typing semantics ship.
const MAX_TYPE_TEXT_LENGTH = 2000;
const MAX_CHAIN_STEPS = 80;
const MAX_CHAIN_JSON_LENGTH = 120000;
const APP_PROFILE_STORE_KEY = 'agentAppProfiles';
const MAX_APP_WORKFLOWS = 40;
const MAX_WORKFLOW_JSON_LENGTH = 80000;
const FOCUS_LEASE_TTL_MS = 5000;
const FOCUS_LEASE_TARGET = '__focus_lease_target';
const MAX_FORMATTED_STEP_OUTPUT_CHARS = 12000;

const DEFAULT_APP_WORKFLOWS = {
    'com.apple.Notes': [
        {
            id: 'notes-create-format-delete',
            name: 'Create, format, and delete a note',
            summary: 'Create a temporary note, write text into the editor, format one line via Format > Heading, then delete via the toolbar More menu.',
            preconditions: [
                'Notes is running and an editable notes folder is selected.',
                'The task is explicitly allowed to create and delete a temporary note.',
            ],
            postconditions: [
                'Verify the exact temporary title is absent while skipping AXMenu and AXMenuItem roles.',
            ],
            selectors: {
                editor: { app: 'Notes', scope: 'app', role: 'AXTextArea' },
                new_note: { app: 'Notes', label: 'New Note', role: 'AXButton' },
                more: { app: 'Notes', label: 'More', role: 'AXMenuButton' },
                delete_note: { app: 'Notes', label: 'Delete Note', role: 'AXMenuItem' },
                format_heading_menu: ['Format', 'Heading'],
            },
            steps: [
                { op: 'launch', app: 'Notes', activate: true, timeout_ms: 8000 },
                { op: 'wait_window', app: 'Notes', timeout_ms: 8000 },
                { op: 'press_named', app: 'Notes', label: 'New Note', role: 'AXButton' },
                { op: 'resolve', app: 'Notes', scope: 'app', role: 'AXTextArea', as: 'editor' },
                { op: 'set_value', target: 'editor', text: '<title>\\n<format line>\\n<body>' },
                { op: 'select_substring', target: 'editor', needle: '<format line>' },
                { op: 'menu', app: 'Notes', path: ['Format', 'Heading'] },
                { op: 'select_range', target: 'editor', location: 0, length: 0 },
                { op: 'press_named', app: 'Notes', label: 'More', role: 'AXMenuButton' },
                { op: 'press_named', app: 'Notes', label: 'Delete Note', role: 'AXMenuItem' },
                { op: 'verify_absent', app: 'Notes', scope: 'app', label: '<title>', exact: true, skip_roles: ['AXMenu', 'AXMenuItem'] },
            ],
            destructive: true,
            source: 'preset',
        },
    ],
    'com.apple.calculator': [
        {
            id: 'calculator-enter-digits-smoke',
            name: 'Enter digits in Calculator',
            summary: 'Launch Calculator, press numeric buttons, and verify the display with a read-window observation.',
            preconditions: [
                'Calculator is allowed to become frontmost.',
            ],
            postconditions: [
                'Calculator display contains the entered digit sequence.',
            ],
            selectors: {
                one: { label: '1', role: 'AXButton' },
                two: { label: '2', role: 'AXButton' },
                clear: { label: 'Clear', role: 'AXButton', optional: true },
            },
            steps: [
                { op: 'launch', app: 'Calculator', activate: true, timeout_ms: 8000 },
                { op: 'wait_window', app: 'Calculator', timeout_ms: 8000 },
                { op: 'press_named', app: 'Calculator', label: '1', role: 'AXButton' },
                { op: 'press_named', app: 'Calculator', label: '2', role: 'AXButton' },
            ],
            destructive: false,
            source: 'preset',
        },
    ],
    'com.apple.finder': [
        {
            id: 'finder-front-window-smoke',
            name: 'Inspect Finder front window',
            summary: 'Launch Finder and resolve common navigation affordances without creating, moving, or deleting files.',
            preconditions: [
                'Finder is allowed to become frontmost.',
            ],
            postconditions: [
                'A Finder window or Finder app surface is present and discoverable.',
            ],
            selectors: {
                toolbar: { app: 'Finder', scope: 'app', role: 'AXToolbar' },
                search: { app: 'Finder', scope: 'app', role: 'AXSearchField', optional: true },
            },
            steps: [
                { op: 'launch', app: 'Finder', activate: true, timeout_ms: 8000 },
                { op: 'wait_window', app: 'Finder', timeout_ms: 8000 },
                { op: 'resolve', app: 'Finder', scope: 'app', role: 'AXToolbar', as: 'toolbar', optional: true },
                { op: 'resolve', app: 'Finder', scope: 'app', role: 'AXSearchField', as: 'search', optional: true },
            ],
            destructive: false,
            source: 'preset',
        },
    ],
    'com.apple.TextEdit': [
        {
            id: 'textedit-scratch-write-smoke',
            name: 'Write scratch text in TextEdit',
            summary: 'Open TextEdit, create or use an untitled document, write a short scratch string, and verify the editor value. Close manually or add a confirmed cleanup step when needed.',
            preconditions: [
                'TextEdit is allowed to become frontmost.',
                'The user permits creating a temporary unsaved document.',
            ],
            postconditions: [
                'The editor contains the scratch string.',
            ],
            selectors: {
                editor: { app: 'TextEdit', scope: 'app', role: 'AXTextArea' },
                new_menu: ['File', 'New'],
            },
            steps: [
                { op: 'launch', app: 'TextEdit', activate: true, timeout_ms: 8000 },
                { op: 'wait_window', app: 'TextEdit', timeout_ms: 8000 },
                { op: 'menu', app: 'TextEdit', path: ['File', 'New'] },
                { op: 'resolve', app: 'TextEdit', scope: 'app', role: 'AXTextArea', as: 'editor' },
                { op: 'set_value', target: 'editor', text: '<scratch text>' },
                { op: 'verify_value', target: 'editor', contains: '<scratch text>' },
            ],
            destructive: false,
            source: 'preset',
        },
    ],
    'com.apple.Dictionary': [
        {
            id: 'dictionary-lookup-smoke',
            name: 'Look up a word in Dictionary',
            summary: 'Launch Dictionary, focus the search field, enter a word, and verify the window updates without changing user files.',
            preconditions: [
                'Dictionary is allowed to become frontmost.',
            ],
            postconditions: [
                'Dictionary search field contains the lookup term or results are visible.',
            ],
            selectors: {
                search: { app: 'Dictionary', scope: 'app', role: 'AXSearchField' },
            },
            steps: [
                { op: 'launch', app: 'Dictionary', activate: true, timeout_ms: 8000 },
                { op: 'wait_window', app: 'Dictionary', timeout_ms: 8000 },
                { op: 'resolve', app: 'Dictionary', scope: 'app', role: 'AXSearchField', as: 'search' },
                { op: 'set_value', target: 'search', text: '<word>' },
                { op: 'verify_value', target: 'search', contains: '<word>' },
            ],
            destructive: false,
            source: 'preset',
        },
    ],
};

const DEFAULT_APP_BUNDLE_ALIASES = {
    Notes: 'com.apple.Notes',
    Calculator: 'com.apple.calculator',
    Finder: 'com.apple.finder',
    TextEdit: 'com.apple.TextEdit',
    Dictionary: 'com.apple.Dictionary',
};

const AGENT_ACT_OPS = [
    { op: 'launch', aliases: ['launch_app'], required: ['app|bundle_id|bundle'], optional: ['activate', 'timeout_ms'] },
    { op: 'wait_window', aliases: ['wait_for_app_window'], required: ['app|bundle_id|bundle'], optional: ['timeout_ms'] },
    { op: 'wait_ms', aliases: ['sleep', 'sleep_ms', 'wait'], required: ['ms|duration_ms'], optional: [] },
    { op: 'wait_for_role', aliases: ['wait_for_element', 'wait_until_present'], required: ['role|label|x/y'], optional: ['app|bundle_id', 'scope', 'timeout_ms', 'as', 'index', 'near_x/near_y', 'prefer_roles', 'skip_roles', 'exact'] },
    { op: 'resolve', required: ['as', 'role|label|x/y'], optional: ['app|bundle_id', 'scope', 'index', 'near_x/near_y', 'prefer_roles', 'skip_roles', 'exact', 'optional'] },
    { op: 'focus', required: ['target'], optional: ['allow_unstable'] },
    { op: 'inspect', required: ['target'], optional: [] },
    { op: 'perform_action', aliases: ['action'], required: ['target', 'action'], optional: [] },
    { op: 'set_attribute', required: ['target', 'attribute', 'value|text'], optional: ['location/length for AXSelectedTextRange'] },
    { op: 'set_value', required: ['target', 'text'], optional: [] },
    { op: 'select_all', required: ['target'], optional: [] },
    { op: 'select_range', required: ['target', 'location', 'length'], optional: [] },
    { op: 'select_substring', required: ['target', 'needle'], optional: ['occurrence'] },
    { op: 'write_selection', aliases: ['write'], required: ['target', 'text'], optional: ['replace_all'] },
    { op: 'insert_text', required: ['target', 'text'], optional: ['location'] },
    { op: 'menu', aliases: ['menu_command', 'menu-command'], required: ['path'], optional: ['app|bundle_id', 'activate'] },
    { op: 'press_named', required: ['label'], optional: ['app|bundle_id', 'role', 'index', 'near_x/near_y'] },
    { op: 'hid', required: ['x/y|target'], optional: ['kind', 'button', 'count'] },
    { op: 'keystroke', aliases: ['key'], required: ['key'], optional: ['app|bundle_id', 'mods', 'require_focus'] },
    { op: 'type_text', aliases: ['type'], required: ['text'], optional: ['app|bundle_id', 'require_focus'] },
    { op: 'read', required: ['target'], optional: [] },
    { op: 'verify_value', required: ['target'], optional: ['equals', 'contains'] },
    { op: 'font_info', required: ['target'], optional: ['location'] },
    { op: 'verify_font_size', required: ['target', 'size|font_size|expected'], optional: ['tolerance'] },
    { op: 'verify_present', required: ['role|label|x/y'], optional: ['app|bundle_id', 'scope', 'index', 'near_x/near_y', 'skip_roles', 'exact'] },
    { op: 'verify_absent', required: ['role|label|x/y'], optional: ['app|bundle_id', 'scope', 'index', 'near_x/near_y', 'skip_roles', 'exact'] },
];

// User-activity guard window. Before posting a keystroke or typing
// text we look at the AX subscribe ring buffer. If we see a recent
// AXValueChanged or AXFocusedUIElementChanged that we did NOT cause
// (heuristic: outside our own action window), refuse with
// `user_active` so we don't fire keys into a moving focus or while
// the user is typing. The window is generous (1200ms) because user
// activity events trail their physical action by 50-300ms in tests.
const USER_ACTIVITY_WINDOW_MS = 1200;
// We grant ourselves a "self-caused" window after each AX action so
// that legitimate follow-on keystrokes aren't mistaken for user
// activity caused by our own previous write/press.
const SELF_ACTION_WINDOW_MS = 800;

function resolveHelperPath(deps) {
    if (deps && Object.prototype.hasOwnProperty.call(deps, 'helperPath')) {
        if (!deps.helperPath) return null;
        return fs.existsSync(deps.helperPath) ? deps.helperPath : null;
    }
    const candidates = [];
    // Packaged build (electron-builder copies the binary into Resources/
    // via the extraResources entry).
    if (deps && deps.resourcesPath) {
        candidates.push(path.join(deps.resourcesPath, 'ax-helper'));
    }
    // Dev build — built by scripts/build-native-helpers.js.
    if (deps && deps.appPath) {
        candidates.push(path.join(deps.appPath, 'build/native/ax-helper'));
    }
    // Fallback for `swiftc` runs directly in the source tree.
    candidates.push(path.join(__dirname, 'native/ax-helper/ax-helper'));
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    return null;
}

function runHelper(deps, args) {
    const helperPath = resolveHelperPath(deps);
    if (!helperPath) {
        return Promise.resolve({
            error: 'helper_missing',
            detail: 'ax-helper binary not found; run src/main/native/ax-helper/build.sh',
        });
    }

    return new Promise((resolve) => {
        let resolved = false;
        let stdout = '';
        let stderr = '';
        let child;

        try {
            child = spawn(helperPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (err) {
            resolve({ error: 'spawn_failed', detail: err.message });
            return;
        }

        const timer = setTimeout(() => {
            if (resolved) return;
            resolved = true;
            try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
            resolve({ error: 'helper_timeout' });
        }, HELPER_TIMEOUT_MS);

        child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
        child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

        child.on('error', (err) => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            resolve({ error: 'spawn_error', detail: err.message });
        });

        child.on('close', (code) => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            if (code !== 0) {
                resolve({
                    error: 'helper_exit',
                    detail: `exit=${code} stderr=${stderr.trim()}`,
                });
                return;
            }
            try {
                const parsed = JSON.parse(stdout.trim());
                resolve(parsed);
            } catch (err) {
                resolve({
                    error: 'helper_bad_json',
                    detail: stdout.trim().slice(0, 200),
                });
            }
        });
    });
}

function formatRead(result) {
    if (result.error) {
        return `AX read failed: ${result.error}${result.detail ? ` (${result.detail})` : ''}`;
    }
    const lines = [];
    lines.push(`Element role: ${result.role || 'unknown'}`);
    if (result.frame) {
        lines.push(`Frame: x=${Math.round(result.frame.x)} y=${Math.round(result.frame.y)} w=${Math.round(result.frame.w)} h=${Math.round(result.frame.h)}`);
    }
    if (result.selectedText && result.selectedText.length > 0) {
        lines.push(`Selected text:\n${result.selectedText}`);
    }
    if (result.value !== undefined && result.value !== null) {
        lines.push(`Value:\n${result.value}`);
    } else if (!result.selectedText) {
        lines.push('Value: (empty)');
    }
    return lines.join('\n');
}

function formatWrite(result) {
    if (result.error) {
        return `AX write failed: ${result.error}${result.detail ? ` (${result.detail})` : ''}`;
    }
    if (result.ok) {
        return `Write succeeded (mode=${result.mode}).`;
    }
    return `Write returned unexpected: ${JSON.stringify(result).slice(0, 200)}`;
}

function formatTree(node, depth, lines) {
    if (depth > 8) return;
    const indent = '  '.repeat(depth);
    const parts = [node.role];
    if (node.subrole) parts.push(`(${node.subrole})`);
    if (node.label) parts.push(`"${node.label}"`);
    const hasDistinctValue = node.value && (!node.label || node.value !== node.label);
    const textRoles = new Set(['AXTextArea', 'AXTextField', 'AXSearchField', 'AXComboBox']);
    const renderValueInline = hasDistinctValue && !textRoles.has(node.role);
    if (renderValueInline) parts.push(`= ${JSON.stringify(String(node.value).slice(0, 120))}`);
    if (node.frame) {
        parts.push(`[${Math.round(node.frame.x)},${Math.round(node.frame.y)} ${Math.round(node.frame.w)}x${Math.round(node.frame.h)}]`);
    }
    lines.push(`${indent}${parts.join(' ')}`);
    if (hasDistinctValue && textRoles.has(node.role)) {
        lines.push(`${indent}  value:`);
        const value = String(node.value);
        for (const line of compactOutput(value, 8000).split('\n')) {
            lines.push(`${indent}    ${line}`);
        }
    }
    if (Array.isArray(node.children)) {
        for (const child of node.children) {
            formatTree(child, depth + 1, lines);
        }
    }
    if (node.truncated) {
        lines.push(`${indent}  …(truncated)`);
    }
}

function formatReadWindow(result) {
    if (result.error) {
        return `Read window failed: ${result.error}${result.detail ? ` (${result.detail})` : ''}`;
    }
    const header = result.app
        ? `Active app: ${result.app}${result.bundle_id ? ` (${result.bundle_id})` : ''} — ${result.node_count} nodes\n`
        : `${result.node_count} nodes\n`;
    const lines = [];
    if (result.tree) formatTree(result.tree, 0, lines);
    return header + lines.join('\n');
}

function formatReadSubtree(result) {
    if (result.error) {
        return `Read subtree failed: ${result.error}${result.detail ? ` (${result.detail})` : ''}`;
    }
    return formatReadWindow(result);
}

function frameShort(frame) {
    if (!frame) return '';
    return ` [${Math.round(frame.x || 0)},${Math.round(frame.y || 0)} ${Math.round(frame.w || 0)}x${Math.round(frame.h || 0)}]`;
}

function elementLine(item) {
    if (!item || typeof item !== 'object') return '';
    const label = item.label ? ` "${String(item.label).slice(0, 80)}"` : '';
    const value = item.value && item.value !== item.label ? ` = ${JSON.stringify(String(item.value).slice(0, 80))}` : '';
    const actionNames = Array.isArray(item.actions)
        ? item.actions
            .map((action) => String(action || '').trim())
            .filter((action) => action.startsWith('AX') && action.length <= 40)
        : [];
    const actions = actionNames.length
        ? ` actions=${actionNames.slice(0, 4).join(',')}`
        : '';
    return `${item.role || 'AXUnknown'}${label}${value}${frameShort(item.frame)}${actions}`;
}

function formatElementList(title, items, limit = 12) {
    if (!Array.isArray(items) || items.length === 0) return `${title}: none`;
    const lines = [`${title}:`];
    for (const item of items.slice(0, limit)) {
        const line = elementLine(item);
        if (line) lines.push(`- ${line}`);
    }
    if (items.length > limit) lines.push(`- +${items.length - limit} more`);
    return lines.join('\n');
}

function formatMenus(menus, limit = 8) {
    if (!Array.isArray(menus) || menus.length === 0) return 'Menus: none';
    const lines = ['Menus:'];
    for (const menu of menus.slice(0, limit)) {
        const items = Array.isArray(menu.items)
            ? menu.items.map((item) => item.title).filter(Boolean).slice(0, 12)
            : [];
        const suffix = menu.truncated ? ', ...' : '';
        lines.push(`- ${menu.title}: ${items.join(', ')}${suffix}`);
    }
    if (menus.length > limit) lines.push(`- +${menus.length - limit} more menus`);
    return lines.join('\n');
}

function normalizeWorkflowList(value) {
    return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : [];
}

function defaultWorkflowsFor(bundleId, appName) {
    const keys = [
        profileKey(bundleId, appName),
        profileKey('', appName),
        profileKey(bundleId, ''),
    ].filter(Boolean);
    for (const key of keys) {
        if (Array.isArray(DEFAULT_APP_WORKFLOWS[key])) {
            return DEFAULT_APP_WORKFLOWS[key];
        }
    }
    return [];
}

function mergePresetWorkflows(profile, bundleId, appName) {
    const base = profile && typeof profile === 'object' ? profile : {};
    const stored = normalizeWorkflowList(base.workflows);
    const presets = defaultWorkflowsFor(bundleId || base.bundle_id, appName || base.app);
    const storedIds = new Set(stored.map((workflow) => workflow.id).filter(Boolean));
    return {
        ...base,
        app: base.app || appName || '',
        bundle_id: base.bundle_id || bundleId || '',
        workflows: [
            ...stored,
            ...presets.filter((workflow) => !storedIds.has(workflow.id)),
        ],
    };
}

function getProfileStore(deps) {
    if (!deps || typeof deps.getStore !== 'function') return null;
    try {
        const store = deps.getStore();
        return store && typeof store.get === 'function' && typeof store.set === 'function' ? store : null;
    } catch (_) {
        return null;
    }
}

function readAppProfiles(deps) {
    const store = getProfileStore(deps);
    if (!store) return {};
    const raw = store.get(APP_PROFILE_STORE_KEY, {});
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

function writeAppProfiles(deps, profiles) {
    const store = getProfileStore(deps);
    if (!store) return false;
    store.set(APP_PROFILE_STORE_KEY, profiles && typeof profiles === 'object' ? profiles : {});
    return true;
}

function profileKey(bundleId, appName) {
    return String(bundleId || appName || '').trim();
}

function profileForDiscovery(deps, discovery) {
    const key = profileKey(discovery && discovery.bundle_id, discovery && discovery.app);
    const appKey = profileKey('', discovery && discovery.app);
    if (!key && !appKey) return null;
    const profiles = readAppProfiles(deps);
    const profile = profiles[key] || profiles[appKey];
    return mergePresetWorkflows(profile, discovery && discovery.bundle_id, discovery && discovery.app);
}

function formatRememberedWorkflows(profile, limit = 8) {
    const workflows = normalizeWorkflowList(profile && profile.workflows);
    if (workflows.length === 0) return 'Remembered workflows: none';
    const lines = ['Remembered workflows:'];
    for (const workflow of workflows.slice(0, limit)) {
        const flags = workflow.destructive ? ' destructive' : '';
        const verified = workflow.last_verified_at ? ` verified=${workflow.last_verified_at}` : '';
        lines.push(`- ${workflow.name || workflow.id || 'unnamed'}:${flags}${verified} ${workflow.summary || ''}`.trim());
    }
    if (workflows.length > limit) lines.push(`- +${workflows.length - limit} more`);
    return lines.join('\n');
}

function formatDiscoverApp(result, profile) {
    if (result.error) {
        return `Discover app failed: ${result.error}${result.detail ? ` (${result.detail})` : ''}`;
    }
    const lines = [];
    lines.push(`App: ${result.app || 'unknown'}${result.bundle_id ? ` (${result.bundle_id})` : ''} pid=${result.pid || 'unknown'}`);
    lines.push(`Windows: ${result.window_count || 0}; scanned nodes=${result.node_count || 0}${result.truncated ? ' (truncated)' : ''}`);
    if (result.focused_window) {
        lines.push(`Focused window: ${elementLine(result.focused_window)}`);
    }
    if (result.focused_element) {
        lines.push(`Focused element: ${elementLine(result.focused_element)}`);
    }
    lines.push(formatRememberedWorkflows(profile));
    lines.push(formatElementList('Text inputs', result.text_inputs, 10));
    lines.push(formatElementList('Menu buttons/popups', result.menu_buttons, 10));
    lines.push(formatElementList('Controls', result.controls, 16));
    lines.push(formatMenus(result.menus, 8));
    if (result.role_counts && typeof result.role_counts === 'object') {
        const roles = Object.entries(result.role_counts)
            .sort((a, b) => Number(b[1]) - Number(a[1]))
            .slice(0, 12)
            .map(([role, count]) => `${role}:${count}`)
            .join(', ');
        lines.push(`Top roles: ${roles || 'none'}`);
    }
    return lines.join('\n');
}

async function resolveAppIdentity(deps, args) {
    const explicitBundle = String(args.bundle_id || args.bundle || '').trim();
    const explicitApp = String(args.app || args.application || '').trim();
    if (explicitBundle || explicitApp) {
        const lookup = explicitBundle || explicitApp;
        const discovery = await runHelper(deps, ['discover-app', '--app', lookup, '--no-menus']);
        if (!discovery.error) {
            return {
                bundle_id: discovery.bundle_id || explicitBundle || lookup,
                app: discovery.app || explicitApp || lookup,
            };
        }
        const aliasedBundle = DEFAULT_APP_BUNDLE_ALIASES[explicitApp] || DEFAULT_APP_BUNDLE_ALIASES[explicitBundle];
        return {
            bundle_id: explicitBundle || aliasedBundle || explicitApp,
            app: explicitApp || explicitBundle,
        };
    }
    const discovery = await runHelper(deps, ['discover-app', '--no-menus']);
    if (discovery.error) return { error: discovery.error, detail: discovery.detail };
    return {
        bundle_id: discovery.bundle_id || discovery.app || '',
        app: discovery.app || discovery.bundle_id || '',
    };
}

// Validate the optional disambiguation args (`index`, `near_x`, `near_y`)
// shared by agent_find_element and agent_press_named, and turn them
// into the corresponding ax-helper argv tail. Codex flagged the silent
// coercion paths (fractional index, half-specified near, null → 0) as
// MED — explicit validation here returns a structured error to the
// caller instead of letting a malformed arg silently default the press.
function buildDisambiguationArgs(args, toolName) {
    const out = [];

    if (args.index !== undefined && args.index !== null) {
        const idxRaw = args.index;
        const idx = typeof idxRaw === 'number' ? idxRaw : Number(idxRaw);
        if (!Number.isFinite(idx) || !Number.isInteger(idx) || idx < 0) {
            return {
                error: `${toolName}: index must be a non-negative integer (got ${JSON.stringify(idxRaw)}).`,
                args: out,
            };
        }
        out.push('--index', String(idx));
    }

    const nxProvided = args.near_x !== undefined && args.near_x !== null;
    const nyProvided = args.near_y !== undefined && args.near_y !== null;
    if (nxProvided !== nyProvided) {
        return {
            error: `${toolName}: near_x and near_y must be provided together.`,
            args: out,
        };
    }
    if (nxProvided && nyProvided) {
        const nx = typeof args.near_x === 'number' ? args.near_x : Number(args.near_x);
        const ny = typeof args.near_y === 'number' ? args.near_y : Number(args.near_y);
        if (!Number.isFinite(nx) || !Number.isFinite(ny)) {
            return {
                error: `${toolName}: near_x and near_y must be finite numbers.`,
                args: out,
            };
        }
        out.push('--near', `${nx},${ny}`);
    }

    return { args: out };
}

function normalizeRole(role) {
    const s = String(role || '').trim();
    return s ? s : '';
}

function appendRoleList(out, flag, value) {
    if (Array.isArray(value)) {
        for (const item of value) {
            const role = normalizeRole(item);
            if (role) out.push(flag, role);
        }
    } else {
        const role = normalizeRole(value);
        if (role) out.push(flag, role);
    }
}

function buildElementTargetArgs(args, toolName, { requireLabel = false, requireTarget = true } = {}) {
    const out = [];
    const label = String(args.label || '').trim();
    const role = normalizeRole(args.role);
    if (requireLabel && !label) {
        return { error: `${toolName} requires a non-empty label.` };
    }
    if (requireTarget && !label && !role) {
        return { error: `${toolName} requires either label or role.` };
    }
    if (role) out.push('--role', role);
    appendRoleList(out, '--skip-role', args.skip_role || args.skip_roles);
    appendRoleList(out, '--prefer-role', args.prefer_role || args.prefer_roles);
    if (args.exact === true) out.push('--exact');

    const disambig = buildDisambiguationArgs(args, toolName);
    if (disambig.error) return disambig;
    out.push(...disambig.args);
    if (label) out.push(label);
    return { args: out };
}

const SELECTOR_KEYS = [
    'app',
    'application',
    'bundle',
    'bundle_id',
    'scope',
    'label',
    'role',
    'index',
    'near_x',
    'near_y',
    'x',
    'y',
    'point',
    'skip_role',
    'skip_roles',
    'prefer_role',
    'prefer_roles',
    'exact',
];

function cloneSelectorValue(value) {
    if (Array.isArray(value)) return value.slice();
    if (value && typeof value === 'object') return { ...value };
    return value;
}

function hasSelectorTarget(selector) {
    if (!selector || typeof selector !== 'object') return false;
    if (String(selector.label || '').trim()) return true;
    if (String(selector.role || '').trim()) return true;
    if (selector.point && typeof selector.point === 'object') {
        return finiteNumber(selector.point.x) !== null && finiteNumber(selector.point.y) !== null;
    }
    return finiteNumber(selector.x) !== null && finiteNumber(selector.y) !== null;
}

function selectorFromSource(source, fallbackScope) {
    if (!source || typeof source !== 'object') return null;
    const selector = {};
    for (const key of SELECTOR_KEYS) {
        if (source[key] !== undefined && source[key] !== null) {
            selector[key] = cloneSelectorValue(source[key]);
        }
    }
    if (!selector.scope && fallbackScope) selector.scope = fallbackScope;
    if (!selector.scope && (selector.app || selector.application || selector.bundle || selector.bundle_id)) {
        selector.scope = 'app';
    }
    return hasSelectorTarget(selector) ? selector : null;
}

function selectorFromArgs(args, fallbackScope) {
    return selectorFromSource(args, fallbackScope);
}

function stripControlKeysFromSelectorArgs(args) {
    const out = {};
    for (const key of SELECTOR_KEYS) {
        if (args[key] !== undefined && args[key] !== null) {
            out[key] = cloneSelectorValue(args[key]);
        }
    }
    return out;
}

function resolveStepName(step) {
    if (!step || typeof step !== 'object') return '';
    return String(step.as || step.var || '').trim();
}

function focusLeaseFromActSteps(inputSteps, result) {
    if (!Array.isArray(inputSteps) || !result || !result.ok || !Array.isArray(result.steps)) {
        return null;
    }
    const resolves = new Map();
    for (let i = 0; i < inputSteps.length; i += 1) {
        const step = inputSteps[i];
        const op = String(step && step.op || '').toLowerCase();
        if (op === 'resolve' || op === 'wait_for_role' || op === 'wait_for_element' || op === 'wait_until_present') {
            const name = resolveStepName(step);
            const stepResult = result.steps[i];
            const selector = selectorFromSource(step, step.scope || (step.app || step.bundle_id ? 'app' : 'window'));
            if (name && selector && stepResult && !stepResult.error && stepResult.found !== false) {
                resolves.set(name, selector);
            }
        }
    }
    for (let i = inputSteps.length - 1; i >= 0; i -= 1) {
        const step = inputSteps[i];
        const op = String(step && step.op || '').toLowerCase();
        const stepResult = result.steps[i];
        if (op === 'focus' && stepResult && !stepResult.error) {
            const targetName = String(step.target || 'target');
            const selector = resolves.get(targetName) || selectorFromSource(step, step.scope);
            if (selector) {
                return {
                    selector,
                    source: 'agent_act',
                    role: stepResult.role,
                    label: stepResult.label,
                    frame: stepResult.frame,
                };
            }
        }
    }
    return null;
}

function focusLeaseFromSelector(selector, source, result) {
    if (!selector) return null;
    return {
        selector,
        source,
        role: result && result.role,
        label: result && result.label,
        frame: result && result.frame,
    };
}

function leasedActSteps(selector, actionStep) {
    return [
        { ...selector, op: 'resolve', as: FOCUS_LEASE_TARGET },
        { op: 'focus', target: FOCUS_LEASE_TARGET, allow_unstable: true },
        { ...actionStep, target: FOCUS_LEASE_TARGET },
    ];
}

function formatDescribeOps() {
    const lines = [
        'agent_act op registry:',
    ];
    for (const spec of AGENT_ACT_OPS) {
        const aliases = Array.isArray(spec.aliases) && spec.aliases.length
            ? ` aliases=${spec.aliases.join(',')}`
            : '';
        const required = Array.isArray(spec.required) && spec.required.length
            ? ` required=${spec.required.join(',')}`
            : ' required=none';
        const optional = Array.isArray(spec.optional) && spec.optional.length
            ? ` optional=${spec.optional.join(',')}`
            : '';
        lines.push(`- ${spec.op}:${aliases}${required}${optional}`);
    }
    lines.push('Selector fields: app/bundle_id, scope=window|app|system|focused|target, role, label, index, near_x+near_y, x+y, prefer_roles, skip_roles, exact.');
    lines.push('Workflow-first rule: before composing primitive actions in an unfamiliar app, call agent_discover_app and agent_list_app_workflows; reuse a verified workflow when one matches the user request.');
    lines.push('Production rules: inspect/discover the AX tree, resolve semantic elements, perform AX actions or set AX attributes, and verify the requested app-state postcondition in the same chain. Do not treat an intermediate control AXValue as proof unless that value is the requested state.');
    lines.push('Native control rule: prefer AXUIElementCopyAttributeValue, AXUIElementIsAttributeSettable, AXUIElementSetAttributeValue, and AXUIElementPerformAction. If an AX setter/action reports success but verification fails, stop and report the mismatch instead of trying unrelated setters.');
    lines.push('CGEvent/HID fallback policy: use only for focus repair, text insertion fallback, or controls with no reliable AX action after explicit user consent. Keep fallback steps scoped to the intended app with app/bundle_id plus require_focus=false only when the app has just been activated/resolved in the same chain; preserve cursor/clipboard and fail closed with diagnostics.');
    lines.push('Focus rule: some native controls accept AXFocused or AXValue without changing the underlying document/app state. For unstable focus or pop-up/combo controls, do not loop on AXFocused; perform the native user gesture in a single scoped chain and verify the semantic result.');
    lines.push('Rich text rule: changing a formatting control is not sufficient. Resolve the edited text element and verify actual attributed content with font_info or verify_font_size when the user asked to change text size.');
    lines.push('Known native pattern for font-size combo boxes: launch/wait_window, resolve edited text as body, select_all/select_range, resolve the font-size AXComboBox by label, hid click it, keystroke cmd+a scoped to the app with require_focus=false, type_text the numeric size scoped to the app, keystroke return scoped to the app, then verify_font_size on body.');
    return lines.join('\n');
}

function finiteNumber(value) {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : null;
}

function requireFiniteArg(args, key, toolName) {
    const n = finiteNumber(args[key]);
    if (n === null) {
        return { error: `${toolName} requires numeric ${key}.` };
    }
    return { value: n };
}

function optionalDurationMs(value, fallback, min, max, toolName) {
    if (value === undefined || value === null) return { value: fallback };
    const n = finiteNumber(value);
    if (n === null || !Number.isInteger(n) || n < min || n > max) {
        return { error: `${toolName} duration_ms must be an integer from ${min} to ${max}.` };
    }
    return { value: n };
}

function optionalClickCount(value) {
    if (value === undefined || value === null) return { value: 1 };
    const n = finiteNumber(value);
    if (n === null || !Number.isInteger(n) || n < 1 || n > 3) {
        return { error: 'agent_click_at count must be 1, 2, or 3.' };
    }
    return { value: n };
}

function normalizeButton(value, fallback = 'left') {
    const button = String(value || fallback).trim().toLowerCase();
    if (!['left', 'right', 'middle', 'center'].includes(button)) {
        return { error: 'button must be left, right, or middle.' };
    }
    return { value: button === 'center' ? 'middle' : button };
}

function formatMatchSuffix(result) {
    const total = Number(result.match_count);
    if (!Number.isFinite(total) || total <= 1) return '';
    const idx = Number.isFinite(Number(result.match_index)) ? Number(result.match_index) : 0;
    return ` (match ${idx + 1} of ${total} — pass index or near_x/near_y to pick a different one)`;
}

function formatFind(result) {
    if (result.error) {
        const searched = result.searched ? ` (searched ${result.searched} nodes)` : '';
        const matched = Number.isFinite(Number(result.match_count)) && Number(result.match_count) > 0
            ? ` — ${result.match_count} match(es) but index out of range`
            : '';
        return `Find failed: ${result.error}${searched}${matched}`;
    }
    if (result.found) {
        const label = result.label ? ` labeled "${result.label}"` : '';
        const where = result.frame
            ? ` at [${Math.round(result.frame.x)},${Math.round(result.frame.y)} ${Math.round(result.frame.w)}x${Math.round(result.frame.h)}]`
            : '';
        return `Found ${result.role}${label}${where}${formatMatchSuffix(result)}`;
    }
    return `Find returned unexpected: ${JSON.stringify(result).slice(0, 200)}`;
}

function formatPress(result) {
    if (result.error) {
        return `Press failed: ${result.error}${result.detail ? ` (${result.detail})` : ''}${formatMatchSuffix(result)}`;
    }
    if (result.ok) {
        const label = result.label ? ` "${result.label}"` : '';
        return `Pressed ${result.role}${label}.${formatMatchSuffix(result)}`;
    }
    return `Press returned unexpected: ${JSON.stringify(result).slice(0, 200)}`;
}

function numberish(value) {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : null;
}

function framesApproximatelyEqual(a, b) {
    if (!a || !b) return false;
    for (const key of ['x', 'y', 'w', 'h']) {
        const av = numberish(a[key]);
        const bv = numberish(b[key]);
        if (av === null || bv === null || Math.abs(av - bv) > 1) return false;
    }
    return true;
}

function focusedSnapshotMatches(expected, snapshot) {
    if (!expected || !snapshot || snapshot.error) return false;
    if (expected.role && snapshot.role && expected.role !== snapshot.role) return false;
    if (expected.pid !== undefined && snapshot.pid !== undefined && Number(expected.pid) !== Number(snapshot.pid)) {
        return false;
    }
    return framesApproximatelyEqual(expected.frame, snapshot.frame);
}

function formatFreshFocusFailure(result, snapshot) {
    const fresh = snapshot && snapshot.error
        ? `${snapshot.error}${snapshot.detail ? ` (${snapshot.detail})` : ''}`
        : JSON.stringify(snapshot || null).slice(0, 160);
    return {
        error: 'focus_not_sticky',
        role: result.role,
        detail: `fresh post-focus snapshot did not match the verified target; focused=${fresh}`,
        frame: result.frame,
        focused_role: snapshot && snapshot.role ? snapshot.role : null,
        focused_frame: snapshot && snapshot.frame ? snapshot.frame : undefined,
        focus_statuses: result.focus_statuses,
    };
}

async function withFocusDiagnostics(deps, result) {
    if (!result || result.error !== 'focus_not_sticky' || result.diagnostics) return result;
    const diagnostics = await runHelper(deps, ['diagnostics']);
    return { ...result, diagnostics };
}

async function verifyFocusAfterReturn(deps, result) {
    if (!result || !result.ok) return withFocusDiagnostics(deps, result);
    if (result.fresh_verified !== true) {
        return withFocusDiagnostics(deps, {
            error: 'focus_not_sticky',
            role: result.role,
            detail: 'native helper returned focus success without fresh process verification',
            frame: result.frame,
            focus_statuses: result.focus_statuses,
        });
    }
    const snapshotArgs = Number.isFinite(Number(result.pid))
        ? ['focused-snapshot', '--pid', String(Number(result.pid))]
        : ['focused-snapshot'];
    const snapshot = await runHelper(deps, snapshotArgs);
    const expected = result.fresh_focused && !result.fresh_focused.error ? result.fresh_focused : result;
    if (!focusedSnapshotMatches(expected, snapshot)) {
        return withFocusDiagnostics(deps, formatFreshFocusFailure(result, snapshot));
    }
    return {
        ...result,
        post_return_verified: true,
        post_return_focused: snapshot,
    };
}

function formatFrameShort(frame) {
    if (!frame) return '';
    const x = numberish(frame.x);
    const y = numberish(frame.y);
    const w = numberish(frame.w);
    const h = numberish(frame.h);
    if (x === null || y === null || w === null || h === null) return '';
    return `[${Math.round(x)},${Math.round(y)} ${Math.round(w)}x${Math.round(h)}]`;
}

function formatAppShort(app) {
    if (!app || typeof app !== 'object') return 'none';
    const name = app.name || app.app || 'unknown';
    const pid = app.pid !== undefined ? ` pid=${app.pid}` : '';
    const bundle = app.bundle_id ? ` ${app.bundle_id}` : '';
    return `${name}${pid}${bundle}`;
}

function formatWindowShort(window) {
    if (!window || typeof window !== 'object') return 'none';
    const name = window.title || window.label;
    const title = name ? ` "${name}"` : '';
    const key = window.is_key !== undefined ? ` key=${window.is_key}` : '';
    const main = window.is_main !== undefined ? ` main=${window.is_main}` : '';
    const frame = formatFrameShort(window.frame);
    return `${window.role || 'AXWindow'}${title}${frame ? ` ${frame}` : ''}${key}${main}`;
}

function formatElementShort(element) {
    if (!element || typeof element !== 'object') return 'none';
    const label = element.label ? ` "${String(element.label).slice(0, 80)}"` : '';
    const frame = formatFrameShort(element.frame);
    const pid = element.pid !== undefined ? ` pid=${element.pid}` : '';
    return `${element.role || 'AXUnknown'}${label}${frame ? ` ${frame}` : ''}${pid}`;
}

function formatFocusDiagnostics(result) {
    const diag = result && result.diagnostics;
    if (!diag) return '';
    if (diag.error) {
        return `\nFocus diagnostics: ${diag.error}${diag.detail ? ` (${diag.detail})` : ''}`;
    }

    const lines = ['Focus diagnostics:'];
    if (diag.frontmost_application) {
        lines.push(`frontmost=${formatAppShort(diag.frontmost_application)}`);
    }
    if (diag.system_focused_application) {
        lines.push(`system_focused_app=${formatAppShort(diag.system_focused_application)}`);
        if (diag.system_focused_application.focused_window) {
            lines.push(`system_focused_window=${formatWindowShort(diag.system_focused_application.focused_window)}`);
        }
        const focusedInApp = diag.system_focused_application.focused_ui_element
            || diag.system_focused_application.window_focused_ui_element;
        if (focusedInApp) {
            lines.push(`app_focused_element=${formatElementShort(focusedInApp)}`);
        }
    }
    if (diag.system_focused_ui_element) {
        lines.push(`system_focused_element=${formatElementShort(diag.system_focused_ui_element)}`);
    }
    if (Array.isArray(diag.root_operator_focused_windows)) {
        const ro = diag.root_operator_focused_windows.slice(0, 3).map(formatWindowShort);
        lines.push(`root_operator_focused_windows=${ro.length ? ro.join(' | ') : 'none'}`);
    }
    const targetPid = result && result.pid !== undefined ? Number(result.pid) : null;
    if (targetPid !== null && Array.isArray(diag.running_applications)) {
        const app = diag.running_applications.find((entry) => Number(entry.pid) === targetPid);
        if (app && Array.isArray(app.windows) && app.windows.length > 0) {
            const windows = app.windows.slice(0, 4).map(formatWindowShort).join(' | ');
            const more = app.windows.length > 4 ? ` | +${app.windows.length - 4} more` : '';
            lines.push(`target_app_windows=${windows}${more}`);
        }
    }
    return `\n${lines.join('\n')}`;
}

function formatFocus(result) {
    if (result.error) {
        return `Focus failed: ${result.error}${result.detail ? ` (${result.detail})` : ''}${formatMatchSuffix(result)}${formatFocusDiagnostics(result)}`;
    }
    if (result.ok) {
        const label = result.label ? ` "${result.label}"` : '';
        return `Focused ${result.role || 'element'}${label}.`;
    }
    return `Focus returned unexpected: ${JSON.stringify(result).slice(0, 200)}`;
}

function formatPointAction(result, verb) {
    if (result.error) {
        return `${verb} failed: ${result.error}${result.detail ? ` (${result.detail})` : ''}`;
    }
    if (result.ok) {
        const x = Number.isFinite(Number(result.x)) ? Math.round(Number(result.x)) : null;
        const y = Number.isFinite(Number(result.y)) ? Math.round(Number(result.y)) : null;
        const where = x !== null && y !== null ? ` at (${x}, ${y})` : '';
        return `${verb} succeeded${where}.`;
    }
    return `${verb} returned unexpected: ${JSON.stringify(result).slice(0, 200)}`;
}

function formatDrag(result) {
    if (result.error) {
        return `Drag failed: ${result.error}${result.detail ? ` (${result.detail})` : ''}`;
    }
    if (result.ok) {
        const from = result.from || {};
        const to = result.to || {};
        return `Drag succeeded from (${Math.round(from.x || 0)}, ${Math.round(from.y || 0)}) to (${Math.round(to.x || 0)}, ${Math.round(to.y || 0)}).`;
    }
    return `Drag returned unexpected: ${JSON.stringify(result).slice(0, 200)}`;
}

function formatKeyboardAction(result, verb) {
    if (result.error) {
        return `${verb} failed: ${result.error}${result.detail ? ` (${result.detail})` : ''}`;
    }
    if (result.ok) {
        return `${verb} succeeded.`;
    }
    return `${verb} returned unexpected: ${JSON.stringify(result).slice(0, 200)}`;
}

function formatRunChain(result) {
    if (result.error) {
        const failed = result.failed_step !== undefined
            ? ` at step ${result.failed_step}${result.failed_op ? ` (${result.failed_op})` : ''}`
            : '';
        const failedStep = Array.isArray(result.steps) && result.failed_step !== undefined
            ? result.steps[Number(result.failed_step)]
            : null;
        const helperDetail = failedStep && failedStep.error
            ? `; helper: ${failedStep.error}${failedStep.detail ? ` (${failedStep.detail})` : ''}`
            : '';
        const cursor = result.cursor_unchanged === false
            ? ` Cursor moved by ${Math.round(Number(result.cursor_delta) || 0)} point(s).`
            : '';
        return `Run chain failed${failed}: ${result.error}${result.detail ? ` (${result.detail})` : ''}${helperDetail}.${cursor}`;
    }
    if (result.ok) {
        const count = Array.isArray(result.steps) ? result.steps.length : 0;
        const cursor = result.cursor_unchanged === true
            ? ` Cursor unchanged (delta=${Number(result.cursor_delta || 0).toFixed(2)}).`
            : '';
        return `Run chain completed ${count} step${count === 1 ? '' : 's'}.${cursor}`;
    }
    return `Run chain returned unexpected: ${JSON.stringify(result).slice(0, 200)}`;
}

function compactOutput(text, limit = MAX_FORMATTED_STEP_OUTPUT_CHARS) {
    const s = String(text || '');
    if (s.length <= limit) return s;
    return `${s.slice(0, limit)}\n...(truncated ${s.length - limit} chars)`;
}

function formatStepOutputs(result) {
    if (!result || !Array.isArray(result.steps)) return '';
    const outputSteps = result.steps.filter((step) => {
        if (!step || step.error) return false;
        return String(step.op || '').toLowerCase() === 'read'
            || String(step.action || '').toLowerCase() === 'read';
    });
    if (outputSteps.length === 0) return '';
    const lines = ['Step outputs:'];
    for (const step of outputSteps) {
        const idx = step.index !== undefined ? `step ${step.index}` : 'read';
        lines.push(`${idx}:`);
        lines.push(compactOutput(formatRead(step)));
    }
    return lines.join('\n');
}

function formatRunChainWithOutputs(result) {
    const base = formatRunChain(result);
    const outputs = formatStepOutputs(result);
    return outputs ? `${base}\n${outputs}` : base;
}

function formatEventLine(evt) {
    if (!evt || typeof evt !== 'object') return '';
    const tsIso = Number.isFinite(evt.ts)
        ? new Date(evt.ts * 1000).toISOString().slice(11, 19)
        : '--:--:--';
    const parts = [tsIso, evt.event || 'unknown'];
    if (evt.app) parts.push(`app=${evt.app}`);
    if (evt.role) parts.push(`role=${evt.role}`);
    if (evt.label) parts.push(`label="${evt.label}"`);
    if (evt.selected_text) {
        parts.push(`selected=${JSON.stringify(evt.selected_text).slice(0, 80)}`);
    } else if (evt.value) {
        parts.push(`value=${JSON.stringify(evt.value).slice(0, 80)}`);
    }
    return parts.join(' · ');
}

function formatEvents(events) {
    if (!Array.isArray(events) || events.length === 0) {
        return 'No recent events.';
    }
    return events.map(formatEventLine).join('\n');
}

// Travel the agent body to land BESIDE an AX result frame so every
// action is visibly grounded without the dot covering the content
// it's reading or writing. Default landing point: right edge of the
// frame, vertically centered, with a small outward offset. If the
// frame's right side would push the dot off the cursor's display,
// fall back to landing at the left edge. Pairs with maybeHalo at the
// call site: halo around the element, dot beside it.
//
// Pure module-level function so tests can call it directly. Optional
// `screen` dep used to keep the dot on-screen when an element sits
// flush against a display edge; without it we just default to the
// right edge.
const FRAME_LANDING_OFFSET_PX = 12;
const ACTION_FEEDBACK_STEP_MS = 620;
const HALO_CONFIG = presenceMotionConfig.halo || {};
const ACTION_AVATAR_DISMISS_MS = Number.isFinite(HALO_CONFIG.avatarDismissMs)
    ? HALO_CONFIG.avatarDismissMs
    : ((HALO_CONFIG.actionAutoHideMs || 1700) + 550);

function computeFrameLanding(frame, screen) {
    if (!frame || !Number.isFinite(frame.x) || !Number.isFinite(frame.y)
        || !Number.isFinite(frame.w) || !Number.isFinite(frame.h)) return null;
    const cy = frame.y + frame.h / 2;
    const right = frame.x + frame.w + FRAME_LANDING_OFFSET_PX;
    const left = frame.x - FRAME_LANDING_OFFSET_PX;

    // No screen helper → default to right.
    if (!screen || typeof screen.getDisplayNearestPoint !== 'function') {
        return { x: right, y: cy };
    }
    try {
        const display = screen.getDisplayNearestPoint({
            x: Math.round(frame.x + frame.w / 2),
            y: Math.round(cy),
        });
        const wa = display && display.workArea;
        if (!wa) return { x: right, y: cy };
        const fitsRight = right <= wa.x + wa.width;
        if (fitsRight) return { x: right, y: cy };
        // Right edge would push past display — fall back to left.
        return { x: left, y: cy };
    } catch (_) {
        return { x: right, y: cy };
    }
}

function maybeTravelToFrame(avatar, result, screen) {
    if (!avatar || typeof avatar.moveTo !== 'function') return;
    const landing = computeFrameLanding(result && result.frame, screen);
    if (!landing) return;
    try { avatar.moveTo(landing.x, landing.y); } catch (_) { /* best-effort */ }
}

function init(deps) {
    if (!deps || !deps.getAgentAvatar || !deps.screen) {
        throw new Error('agent-actions.init requires getAgentAvatar, screen');
    }

    let lastWriteAt = 0;
    let lastPressAt = 0;
    let lastKeystrokeAt = 0;
    let lastTypeTextAt = 0;
    let lastHidAt = 0;
    let lastFocusAt = 0;
    let avatarDismissTimer = null;
    // Timestamp of the most recent AX-mutating action we performed
    // (write, press, keystroke, type-text, select-*). Subsequent
    // user-activity checks ignore events older than this — those are
    // ours, not the user's. Updated on every successful action.
    let lastSelfActionAt = 0;
    let focusLease = null;

    function bumpSelfActionAt() {
        lastSelfActionAt = Date.now();
    }

    function clearAvatarDismissTimer() {
        if (avatarDismissTimer) {
            clearTimeout(avatarDismissTimer);
            avatarDismissTimer = null;
        }
    }

    function scheduleAvatarDismiss(avatar, delayMs = ACTION_AVATAR_DISMISS_MS) {
        if (!avatar || typeof avatar.park !== 'function') return;
        clearAvatarDismissTimer();
        const ms = Math.max(400, Math.round(Number.isFinite(delayMs) ? delayMs : ACTION_AVATAR_DISMISS_MS));
        avatarDismissTimer = setTimeout(() => {
            avatarDismissTimer = null;
            try {
                const state = typeof avatar.getState === 'function' ? avatar.getState() : null;
                if (state === 'driving') {
                    scheduleAvatarDismiss(avatar, 700);
                    return;
                }
                if (state === 'ambient') return;
                avatar.park();
            } catch (_) { /* best-effort visual dismissal */ }
        }, ms);
        if (typeof avatarDismissTimer.unref === 'function') avatarDismissTimer.unref();
    }

    function releaseHostKeyboardFocus(reason) {
        const fns = [
            deps.releaseKeyboardFocus,
            deps.prepareForExternalFocus,
        ].filter((fn) => typeof fn === 'function');
        for (const fn of fns) {
            try { fn(reason); } catch (_) { /* best-effort host focus release */ }
        }
    }

    // Inspect the AX subscribe ring buffer for evidence that the user
    // is actively typing or navigating in the time window leading up
    // to a planned keystroke. Returns the offending event line, or
    // null if no user activity is detected.
    function detectUserActivity() {
        if (typeof deps.getAgentEvents !== 'function') return null;
        const events = deps.getAgentEvents();
        if (!events || typeof events.getEvents !== 'function') return null;
        const list = events.getEvents({ since_ms: USER_ACTIVITY_WINDOW_MS });
        if (!Array.isArray(list) || list.length === 0) return null;
        const cutoffMs = Date.now() - USER_ACTIVITY_WINDOW_MS;
        const selfCutoffMs = lastSelfActionAt - SELF_ACTION_WINDOW_MS;
        const triggers = new Set([
            'AXValueChanged',
            'AXFocusedUIElementChanged',
            'AXSelectedTextChanged',
            'AXFocusedWindowChanged',
            'AXMainWindowChanged',
            'AXMenuOpened',
            'app_activated',
        ]);
        for (const e of list) {
            if (!e || !triggers.has(e.event)) continue;
            const tsMs = Number(e.ts) * 1000;
            if (!Number.isFinite(tsMs) || tsMs < cutoffMs) continue;
            // If the event happened within our own self-caused window
            // immediately after a recent agent action, treat it as ours.
            if (lastSelfActionAt > 0 && tsMs >= selfCutoffMs && tsMs <= lastSelfActionAt + SELF_ACTION_WINDOW_MS) {
                continue;
            }
            return e;
        }
        return null;
    }

    function rememberFocusLease(partial) {
        if (!partial || !partial.selector) return null;
        const now = Date.now();
        focusLease = {
            ...partial,
            createdAt: now,
            expiresAt: now + FOCUS_LEASE_TTL_MS,
        };
        return focusLease;
    }

    function clearFocusLease() {
        focusLease = null;
    }

    function focusLeaseInvalidatingActivity() {
        if (!focusLease || typeof deps.getAgentEvents !== 'function') return null;
        const events = deps.getAgentEvents();
        if (!events || typeof events.getEvents !== 'function') return null;
        const sinceMs = Math.max(USER_ACTIVITY_WINDOW_MS, Date.now() - focusLease.createdAt + 250);
        const list = events.getEvents({ since_ms: sinceMs });
        if (!Array.isArray(list) || list.length === 0) return null;
        const selfCutoffMs = lastSelfActionAt - SELF_ACTION_WINDOW_MS;
        const triggers = new Set([
            'AXValueChanged',
            'AXFocusedUIElementChanged',
            'AXSelectedTextChanged',
            'AXFocusedWindowChanged',
            'AXMainWindowChanged',
            'AXMenuOpened',
            'app_activated',
        ]);
        for (const e of list) {
            if (!e || !triggers.has(e.event)) continue;
            const tsMs = Number(e.ts) * 1000;
            if (!Number.isFinite(tsMs) || tsMs < focusLease.createdAt) continue;
            if (lastSelfActionAt > 0 && tsMs >= selfCutoffMs && tsMs <= lastSelfActionAt + SELF_ACTION_WINDOW_MS) {
                continue;
            }
            return e;
        }
        return null;
    }

    function usableFocusLease(force = false) {
        if (!focusLease || !focusLease.selector) return { lease: null };
        if (Date.now() > focusLease.expiresAt) {
            clearFocusLease();
            return { lease: null, expired: true };
        }
        const offending = focusLeaseInvalidatingActivity();
        if (offending && !force) {
            return { lease: null, invalidated: offending };
        }
        return { lease: focusLease, invalidated: offending || null };
    }

    function formatFocusLeaseInvalidation(offending) {
        const event = offending && offending.event ? offending.event : 'unknown activity';
        const app = offending && offending.app ? ` in ${offending.app}` : '';
        return `focus_invalidated_by_user_activity: ${event}${app}. Pass force=true to override.`;
    }

    async function runActSteps(steps, cursorTolerance) {
        const payload = {
            cursor_tolerance: cursorTolerance,
            steps,
        };
        return runHelper(deps, ['act', JSON.stringify(payload)]);
    }

    function lastStepResult(result) {
        if (!result || !Array.isArray(result.steps) || result.steps.length === 0) return result;
        return result.steps[result.steps.length - 1];
    }

    async function runSelectorAction(selector, actionStep, cursorTolerance) {
        const steps = leasedActSteps(selector, actionStep);
        const result = await runActSteps(steps, cursorTolerance);
        return { result, step: lastStepResult(result), steps };
    }

    function selectorOrLease(args, force, fallbackScope) {
        const explicit = selectorFromArgs(stripControlKeysFromSelectorArgs(args), fallbackScope);
        if (explicit) return { selector: explicit, source: 'explicit' };
        const leaseState = usableFocusLease(force);
        if (leaseState.invalidated) {
            return { error: formatFocusLeaseInvalidation(leaseState.invalidated) };
        }
        if (leaseState.lease) {
            return { selector: leaseState.lease.selector, source: 'lease' };
        }
        return { selector: null };
    }

    // Pulse the halo around the AX element identified by the helper's
    // structured frame, if the halo overlay is wired and the frame is
    // valid. Best-effort — never throw, never block the action result.
    function haloOptionsForResult(result) {
        const action = String((result && (result.action || result.op)) || '').toLowerCase();
        const role = result && result.role ? String(result.role) : undefined;
        const explicitRadius = result && (result.borderRadius ?? result.border_radius);
        const parsedRadius = Number(explicitRadius);
        const radius = Number.isFinite(parsedRadius) ? parsedRadius : undefined;
        if (action === 'focus' || action === 'read' || action === 'inspect') {
            return { mode: action || 'focus', role, borderRadius: radius };
        }
        return { mode: action || 'action', role, borderRadius: radius };
    }

    function maybeHalo(result, options = {}) {
        if (!result || !result.frame) return;
        if (typeof deps.getAgentHalo !== 'function') return;
        const halo = deps.getAgentHalo();
        if (!halo || typeof halo.show !== 'function') return;
        try {
            halo.show({
                x: result.frame.x,
                y: result.frame.y,
                w: result.frame.w,
                h: result.frame.h,
            }, { ...haloOptionsForResult(result), ...options });
        } catch (_) { /* swallow halo errors — purely decorative */ }
    }

    // Halo + travel together — every successful AX action where we have
    // a frame should make the dot legible at the action site.
    function showActionAt(avatar, result, options = {}) {
        const { dismiss = true, dismissMs, ...haloOptions } = options;
        maybeHalo(result, haloOptions);
        maybeTravelToFrame(avatar, result, deps.screen);
        if (dismiss) scheduleAvatarDismiss(avatar, dismissMs);
    }

    function successfulFramedSteps(result) {
        if (!result || !Array.isArray(result.steps)) return [];
        return result.steps.filter((step) => {
            if (!step || !step.frame || step.skipped) return false;
            if (step.error) return false;
            if (step.ok === false) return false;
            return step.ok === true || step.found === true || step.action || step.op;
        });
    }

    function scheduleActionSignals(avatar, result) {
        const steps = successfulFramedSteps(result);
        if (steps.length === 0) return false;
        steps.forEach((step, index) => {
            if (index === 0) {
                showActionAt(avatar, step);
                return;
            }
            const schedule = typeof deps.setTimeout === 'function' ? deps.setTimeout : setTimeout;
            const timer = schedule(() => showActionAt(avatar, step), index * ACTION_FEEDBACK_STEP_MS);
            if (typeof timer.unref === 'function') timer.unref();
        });
        return true;
    }

    async function withDrivingAvatar(avatar, fn) {
        if (avatar && typeof avatar.beginDriving === 'function') {
            clearAvatarDismissTimer();
            try { avatar.beginDriving(); } catch (_) { /* best-effort */ }
        }
        try {
            return await fn();
        } finally {
            if (avatar && typeof avatar.endDriving === 'function') {
                try { avatar.endDriving(); } catch (_) { /* best-effort */ }
            }
        }
    }

    function refuseIfUserActive(force, prefix) {
        if (force) return null;
        const offending = detectUserActivity();
        if (!offending) return null;
        return {
            result: `${prefix}: user activity detected (${offending.event}${offending.app ? ' in ' + offending.app : ''}). Pass force=true to override.`,
            isError: true,
        };
    }

    async function handle(req) {
        const tool = req.tool;
        const args = req.args || {};
        const avatar = deps.getAgentAvatar();

        try {
            switch (tool) {
                case 'agent_move_to_cursor': {
                    if (!avatar) return { result: 'Agent avatar not available.', isError: true };
                    const ox = Number(args.offset_x);
                    const oy = Number(args.offset_y);
                    clearAvatarDismissTimer();
                    const r = avatar.moveToCursor(
                        Number.isFinite(ox) ? ox : undefined,
                        Number.isFinite(oy) ? oy : undefined,
                    );
                    return {
                        result: `Moving to cursor → (${Math.round(r.to.x)}, ${Math.round(r.to.y)}).`,
                        isError: false,
                    };
                }

                case 'agent_move_to': {
                    if (!avatar) return { result: 'Agent avatar not available.', isError: true };
                    const x = Number(args.x);
                    const y = Number(args.y);
                    if (!Number.isFinite(x) || !Number.isFinite(y)) {
                        return { result: 'agent_move_to requires numeric x and y.', isError: true };
                    }
                    clearAvatarDismissTimer();
                    avatar.moveTo(x, y);
                    return {
                        result: `Moving to (${Math.round(x)}, ${Math.round(y)}).`,
                        isError: false,
                    };
                }

                case 'agent_park': {
                    if (!avatar) return { result: 'Agent avatar not available.', isError: true };
                    clearAvatarDismissTimer();
                    const r = avatar.park();
                    return {
                        result: `Parking at (${Math.round(r.to.x)}, ${Math.round(r.to.y)}).`,
                        isError: false,
                    };
                }

                case 'agent_check_ax': {
                    const r = await runHelper(deps, ['check']);
                    if (r.error) {
                        return { result: `AX check error: ${r.error}`, isError: true };
                    }
                    if (r.trusted) {
                        return { result: 'AX permission granted (trusted=true).', isError: false };
                    }
                    return {
                        result: 'AX permission NOT granted. Open System Settings → Privacy & Security → Accessibility and enable Root Operator.',
                        isError: true,
                    };
                }

                case 'agent_describe_ops': {
                    return { result: formatDescribeOps(), isError: false };
                }

                case 'agent_read_at_cursor': {
                    const cursor = deps.screen.getCursorScreenPoint();
                    const r = await runHelper(deps, ['read-at', String(cursor.x), String(cursor.y)]);
                    if (!r.error || r.error === 'no_text') showActionAt(avatar, r);
                    return { result: formatRead(r), isError: !!r.error && r.error !== 'no_text' };
                }

                case 'agent_read_focused': {
                    const force = args.force === true;
                    const target = selectorOrLease(args, force, 'window');
                    if (target.error) return { result: `Read focused failed: ${target.error}`, isError: true };
                    if (target.selector) {
                        const { result: chain, step } = await runSelectorAction(target.selector, { op: 'read' }, args.cursor_tolerance);
                        if (chain.ok) {
                            rememberFocusLease(focusLeaseFromSelector(target.selector, target.source === 'lease' ? 'agent_read_focused:lease' : 'agent_read_focused', step));
                            bumpSelfActionAt();
                            if (step && !step.error) showActionAt(avatar, step);
                            return { result: formatRead(step), isError: !!(step && step.error) };
                        }
                        return { result: formatRunChain(chain).replace(/^Run chain/, 'Read focused chain'), isError: true };
                    }
                    const r = await runHelper(deps, ['read-focused']);
                    if (!r.error || r.error === 'no_text') showActionAt(avatar, r);
                    return { result: formatRead(r), isError: !!r.error && r.error !== 'no_text' };
                }

                case 'agent_write_selection': {
                    const text = String(args.text || '');
                    const replaceAll = args.replace_all === true;
                    if (!text) {
                        return { result: 'agent_write_selection requires non-empty text.', isError: true };
                    }
                    if (text.length > MAX_WRITE_TEXT_LENGTH) {
                        return {
                            result: `Refusing write: text length ${text.length} exceeds limit ${MAX_WRITE_TEXT_LENGTH}.`,
                            isError: true,
                        };
                    }
                    const now = Date.now();
                    if (now - lastWriteAt < WRITE_INTERVAL_MIN_MS) {
                        const wait = WRITE_INTERVAL_MIN_MS - (now - lastWriteAt);
                        return {
                            result: `Rate limited: another write is allowed in ${wait}ms.`,
                            isError: true,
                        };
                    }
                    const force = args.force === true;
                    const target = selectorOrLease(args, force, 'window');
                    if (target.error) {
                        return { result: `AX write failed: ${target.error}`, isError: true };
                    }
                    const refused = refuseIfUserActive(force, 'Refused write');
                    if (refused) return refused;
                    lastWriteAt = now;
                    if (target.selector) {
                        const { result: chain, step } = await runSelectorAction(
                            target.selector,
                            { op: 'write_selection', text, replace_all: replaceAll },
                            args.cursor_tolerance,
                        );
                        if (chain.ok && step && !step.error) {
                            bumpSelfActionAt();
                            rememberFocusLease(focusLeaseFromSelector(target.selector, target.source === 'lease' ? 'agent_write_selection:lease' : 'agent_write_selection', step));
                            showActionAt(avatar, step);
                            return { result: formatWrite(step), isError: false };
                        }
                        if (chain.error) {
                            return {
                                result: formatRunChain(chain).replace(/^Run chain/, 'Write selection chain'),
                                isError: true,
                            };
                        }
                        return { result: formatWrite(step || chain), isError: true };
                    }
                    // Resolve the target via the user's cursor position
                    // rather than system focus. The Presence bubble owns
                    // focus while the user is typing into it, so writing
                    // through `write-focused` reliably fails. The Swift
                    // helper now restores focus on the cursor-resolved
                    // element before the write.
                    const cursor = deps.screen.getCursorScreenPoint();
                    const helperArgs = replaceAll
                        ? ['write-at', String(cursor.x), String(cursor.y), '--replace-all', text]
                        : ['write-at', String(cursor.x), String(cursor.y), text];
                    const r = await runHelper(deps, helperArgs);
                    if (r.ok) { bumpSelfActionAt(); showActionAt(avatar, r); }
                    return { result: formatWrite(r), isError: !r.ok };
                }

                case 'agent_read_window': {
                    const r = await runHelper(deps, ['read-window']);
                    return { result: formatReadWindow(r), isError: !!r.error };
                }

                case 'agent_discover_app': {
                    const helperArgs = ['discover-app'];
                    const appName = String(args.app || args.application || args.bundle_id || args.bundle || '').trim();
                    if (appName) helperArgs.push('--app', appName);
                    if (args.include_menus === false) helperArgs.push('--no-menus');
                    if (args.activate === false) helperArgs.push('--no-activate');
                    const r = await runHelper(deps, helperArgs);
                    const profile = r.error ? null : profileForDiscovery(deps, r);
                    return { result: formatDiscoverApp(r, profile), isError: !!r.error };
                }

                case 'agent_list_app_workflows': {
                    const identity = await resolveAppIdentity(deps, args);
                    if (identity.error) {
                        return {
                            result: `Could not resolve app profile: ${identity.error}${identity.detail ? ` (${identity.detail})` : ''}`,
                            isError: true,
                        };
                    }
                    const key = profileKey(identity.bundle_id, identity.app);
                    const profiles = readAppProfiles(deps);
                    const storedProfile = profiles[key] || profiles[profileKey('', identity.app)] || {
                        app: identity.app,
                        bundle_id: identity.bundle_id,
                        workflows: [],
                    };
                    const profile = mergePresetWorkflows(storedProfile, identity.bundle_id, identity.app);
                    return {
                        result: `App profile: ${profile.app || identity.app || key}${profile.bundle_id ? ` (${profile.bundle_id})` : ''}\n${formatRememberedWorkflows(profile, 20)}`,
                        isError: false,
                    };
                }

                case 'agent_remember_app_workflow': {
                    const name = String(args.name || '').trim();
                    if (!name) {
                        return { result: 'agent_remember_app_workflow requires a non-empty name.', isError: true };
                    }
                    const workflow = {
                        id: String(args.id || name).trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, ''),
                        name,
                        summary: String(args.summary || '').trim(),
                        preconditions: Array.isArray(args.preconditions) ? args.preconditions.filter((s) => typeof s === 'string' && s.trim()) : [],
                        postconditions: Array.isArray(args.postconditions) ? args.postconditions.filter((s) => typeof s === 'string' && s.trim()) : [],
                        selectors: args.selectors && typeof args.selectors === 'object' ? args.selectors : undefined,
                        steps: Array.isArray(args.steps) ? args.steps : [],
                        destructive: args.destructive === true,
                        last_verified_at: args.last_verified_at ? String(args.last_verified_at) : new Date().toISOString(),
                        success_count: Number.isFinite(Number(args.success_count)) ? Number(args.success_count) : 1,
                    };
                    if (!workflow.id) workflow.id = `workflow-${Date.now()}`;
                    const json = JSON.stringify(workflow);
                    if (json.length > MAX_WORKFLOW_JSON_LENGTH) {
                        return {
                            result: `Refusing to save workflow: payload length ${json.length} exceeds ${MAX_WORKFLOW_JSON_LENGTH}.`,
                            isError: true,
                        };
                    }
                    const identity = await resolveAppIdentity(deps, args);
                    if (identity.error) {
                        return {
                            result: `Could not resolve app profile: ${identity.error}${identity.detail ? ` (${identity.detail})` : ''}`,
                            isError: true,
                        };
                    }
                    const key = profileKey(identity.bundle_id, identity.app);
                    if (!key) {
                        return { result: 'Could not resolve app profile key.', isError: true };
                    }
                    const profiles = readAppProfiles(deps);
                    const legacyKey = profileKey('', identity.app);
                    const existing = (profiles[key] && typeof profiles[key] === 'object')
                        ? profiles[key]
                        : ((profiles[legacyKey] && typeof profiles[legacyKey] === 'object') ? profiles[legacyKey] : {});
                    const workflows = normalizeWorkflowList(existing.workflows);
                    const nextWorkflows = [workflow, ...workflows.filter((item) => item.id !== workflow.id)].slice(0, MAX_APP_WORKFLOWS);
                    profiles[key] = {
                        ...existing,
                        app: identity.app || existing.app || key,
                        bundle_id: identity.bundle_id || existing.bundle_id || key,
                        updated_at: new Date().toISOString(),
                        workflows: nextWorkflows,
                    };
                    if (!writeAppProfiles(deps, profiles)) {
                        return { result: 'Could not save app workflow: app profile store unavailable.', isError: true };
                    }
                    return {
                        result: `Remembered workflow "${workflow.name}" for ${profiles[key].app || key}. Workflows stored: ${nextWorkflows.length}.`,
                        isError: false,
                    };
                }

                case 'agent_read_subtree': {
                    const target = buildElementTargetArgs(args, 'agent_read_subtree', { requireTarget: true });
                    if (target.error) return { result: target.error, isError: true };
                    const r = await runHelper(deps, ['read-subtree', ...target.args]);
                    if (r.tree && r.tree.frame) showActionAt(avatar, r.tree);
                    return { result: formatReadSubtree(r), isError: !!r.error };
                }

                case 'agent_find_element': {
                    const label = String(args.label || '').trim();
                    if (!label) {
                        return { result: 'agent_find_element requires a non-empty label.', isError: true };
                    }
                    const disambig = buildDisambiguationArgs(args, 'agent_find_element');
                    if (disambig.error) {
                        return { result: disambig.error, isError: true };
                    }
                    const helperArgs = ['find-element'];
                    if (args.role) {
                        helperArgs.push('--role', String(args.role));
                    }
                    helperArgs.push(...disambig.args);
                    helperArgs.push(label);
                    const r = await runHelper(deps, helperArgs);
                    if (r.found) showActionAt(avatar, r);
                    return { result: formatFind(r), isError: !!r.error };
                }

                case 'agent_focus_element': {
                    const target = buildElementTargetArgs(args, 'agent_focus_element', { requireTarget: true });
                    if (target.error) return { result: target.error, isError: true };
                    const now = Date.now();
                    if (now - lastFocusAt < FOCUS_INTERVAL_MIN_MS) {
                        const wait = FOCUS_INTERVAL_MIN_MS - (now - lastFocusAt);
                        return { result: `Rate limited: focus allowed in ${wait}ms.`, isError: true };
                    }
                    const force = args.force === true;
                    const refused = refuseIfUserActive(force, 'Refused focus');
                    if (refused) return refused;
                    lastFocusAt = now;
                    releaseHostKeyboardFocus('agent_focus_element');
                    const r = await verifyFocusAfterReturn(
                        deps,
                        await runHelper(deps, ['focus-element', ...target.args]),
                    );
                    if (r.ok) {
                        bumpSelfActionAt();
                        rememberFocusLease(focusLeaseFromSelector(selectorFromArgs(args, 'window'), 'agent_focus_element', r));
                        showActionAt(avatar, r);
                    }
                    return { result: formatFocus(r), isError: !r.ok };
                }

                case 'agent_focus_at': {
                    const x = requireFiniteArg(args, 'x', 'agent_focus_at');
                    const y = requireFiniteArg(args, 'y', 'agent_focus_at');
                    if (x.error) return { result: x.error, isError: true };
                    if (y.error) return { result: y.error, isError: true };
                    const now = Date.now();
                    if (now - lastFocusAt < FOCUS_INTERVAL_MIN_MS) {
                        const wait = FOCUS_INTERVAL_MIN_MS - (now - lastFocusAt);
                        return { result: `Rate limited: focus allowed in ${wait}ms.`, isError: true };
                    }
                    const force = args.force === true;
                    const refused = refuseIfUserActive(force, 'Refused focus');
                    if (refused) return refused;
                    lastFocusAt = now;
                    releaseHostKeyboardFocus('agent_focus_at');
                    const r = await verifyFocusAfterReturn(
                        deps,
                        await runHelper(deps, ['focus-at', String(x.value), String(y.value)]),
                    );
                    if (r.ok) {
                        bumpSelfActionAt();
                        rememberFocusLease(focusLeaseFromSelector({ scope: 'system', x: x.value, y: y.value }, 'agent_focus_at', r));
                        showActionAt(avatar, r);
                    }
                    return { result: formatFocus(r), isError: !r.ok };
                }

                case 'agent_recent_events': {
                    if (typeof deps.getAgentEvents !== 'function') {
                        return { result: 'Agent events not wired.', isError: true };
                    }
                    const events = deps.getAgentEvents();
                    if (!events || typeof events.getEvents !== 'function') {
                        return { result: 'Agent events not running.', isError: true };
                    }
                    const count = Number(args.count);
                    const sinceMs = Number(args.since_ms);
                    const list = events.getEvents({
                        count: Number.isFinite(count) ? count : undefined,
                        since_ms: Number.isFinite(sinceMs) ? sinceMs : undefined,
                    });
                    return { result: formatEvents(list), isError: false };
                }

                case 'agent_run_chain': {
                    const steps = Array.isArray(args.steps) ? args.steps : null;
                    if (!steps || steps.length === 0) {
                        return { result: 'agent_run_chain requires a non-empty steps array.', isError: true };
                    }
                    if (steps.length > MAX_CHAIN_STEPS) {
                        return { result: `agent_run_chain refuses more than ${MAX_CHAIN_STEPS} steps.`, isError: true };
                    }
                    const payload = {
                        cursor_tolerance: args.cursor_tolerance,
                        steps,
                    };
                    const json = JSON.stringify(payload);
                    if (json.length > MAX_CHAIN_JSON_LENGTH) {
                        return {
                            result: `agent_run_chain payload length ${json.length} exceeds ${MAX_CHAIN_JSON_LENGTH}.`,
                            isError: true,
                        };
                    }
                    releaseHostKeyboardFocus('agent_run_chain');
                    const r = await runHelper(deps, ['run-chain', json]);
                    if (r.ok) {
                        bumpSelfActionAt();
                        scheduleActionSignals(avatar, r);
                    }
                    return { result: formatRunChainWithOutputs(r), isError: !r.ok };
                }

                case 'agent_act': {
                    const steps = Array.isArray(args.steps) ? args.steps : null;
                    if (!steps || steps.length === 0) {
                        return { result: 'agent_act requires a non-empty steps array.', isError: true };
                    }
                    if (steps.length > MAX_CHAIN_STEPS) {
                        return { result: `agent_act refuses more than ${MAX_CHAIN_STEPS} steps.`, isError: true };
                    }
                    const payload = {
                        cursor_tolerance: args.cursor_tolerance,
                        steps,
                    };
                    const json = JSON.stringify(payload);
                    if (json.length > MAX_CHAIN_JSON_LENGTH) {
                        return {
                            result: `agent_act payload length ${json.length} exceeds ${MAX_CHAIN_JSON_LENGTH}.`,
                            isError: true,
                        };
                    }
                    const force = args.force === true;
                    const refused = refuseIfUserActive(force, 'Refused generic action');
                    if (refused) return refused;
                    releaseHostKeyboardFocus('agent_act');
                    const r = await runHelper(deps, ['act', json]);
                    if (r.ok) {
                        bumpSelfActionAt();
                        const nextLease = focusLeaseFromActSteps(steps, r);
                        if (nextLease) {
                            rememberFocusLease(nextLease);
                        } else {
                            clearFocusLease();
                        }
                        scheduleActionSignals(avatar, r);
                    }
                    return { result: formatRunChainWithOutputs(r).replace(/^Run chain/, 'Generic action'), isError: !r.ok };
                }

                case 'agent_press_named': {
                    const label = String(args.label || '').trim();
                    if (!label) {
                        return { result: 'agent_press_named requires a non-empty label.', isError: true };
                    }
                    const now = Date.now();
                    if (now - lastPressAt < PRESS_INTERVAL_MIN_MS) {
                        const wait = PRESS_INTERVAL_MIN_MS - (now - lastPressAt);
                        return {
                            result: `Rate limited: another press is allowed in ${wait}ms.`,
                            isError: true,
                        };
                    }
                    const disambig = buildDisambiguationArgs(args, 'agent_press_named');
                    if (disambig.error) {
                        return { result: disambig.error, isError: true };
                    }
                    const force = args.force === true;
                    const refused = refuseIfUserActive(force, 'Refused press');
                    if (refused) return refused;
                    lastPressAt = now;
                    if (args.app || args.application || args.bundle_id || args.bundle) {
                        releaseHostKeyboardFocus('agent_press_named');
                        const steps = [
                            {
                                op: 'press_named',
                                app: args.app || args.application,
                                bundle_id: args.bundle_id || args.bundle,
                                label,
                                role: args.role,
                                index: args.index,
                                near_x: args.near_x,
                                near_y: args.near_y,
                            },
                        ];
                        const r = await runActSteps(steps, args.cursor_tolerance);
                        if (r.ok) {
                            bumpSelfActionAt();
                            scheduleActionSignals(avatar, r);
                        }
                        return { result: formatRunChain(r).replace(/^Run chain/, 'Press named'), isError: !r.ok };
                    }
                    const helperArgs = ['press-named'];
                    if (args.role) {
                        helperArgs.push('--role', String(args.role));
                    }
                    helperArgs.push(...disambig.args);
                    helperArgs.push(label);
                    const r = await runHelper(deps, helperArgs);
                    if (r.ok) { bumpSelfActionAt(); showActionAt(avatar, r); }
                    return { result: formatPress(r), isError: !r.ok };
                }

                case 'agent_press_at': {
                    const x = requireFiniteArg(args, 'x', 'agent_press_at');
                    const y = requireFiniteArg(args, 'y', 'agent_press_at');
                    if (x.error) return { result: x.error, isError: true };
                    if (y.error) return { result: y.error, isError: true };
                    const now = Date.now();
                    if (now - lastPressAt < PRESS_INTERVAL_MIN_MS) {
                        const wait = PRESS_INTERVAL_MIN_MS - (now - lastPressAt);
                        return { result: `Rate limited: another press is allowed in ${wait}ms.`, isError: true };
                    }
                    const force = args.force === true;
                    const refused = refuseIfUserActive(force, 'Refused press');
                    if (refused) return refused;
                    lastPressAt = now;
                    const r = await runHelper(deps, ['press-at', String(x.value), String(y.value)]);
                    if (r.ok) { bumpSelfActionAt(); showActionAt(avatar, r); }
                    return { result: formatPress(r), isError: !r.ok };
                }

                case 'agent_click_at': {
                    const x = requireFiniteArg(args, 'x', 'agent_click_at');
                    const y = requireFiniteArg(args, 'y', 'agent_click_at');
                    if (x.error) return { result: x.error, isError: true };
                    if (y.error) return { result: y.error, isError: true };
                    const button = normalizeButton(args.button);
                    if (button.error) return { result: button.error, isError: true };
                    const count = optionalClickCount(args.count);
                    if (count.error) return { result: count.error, isError: true };
                    const now = Date.now();
                    if (now - lastHidAt < HID_INTERVAL_MIN_MS) {
                        const wait = HID_INTERVAL_MIN_MS - (now - lastHidAt);
                        return { result: `Rate limited: HID action allowed in ${wait}ms.`, isError: true };
                    }
                    const force = args.force === true;
                    const refused = refuseIfUserActive(force, 'Refused click');
                    if (refused) return refused;
                    lastHidAt = now;
                    const r = await withDrivingAvatar(avatar, () => runHelper(deps, [
                        'click-at', String(x.value), String(y.value),
                        '--button', button.value,
                        '--count', String(count.value),
                    ]));
                    if (r.ok) { bumpSelfActionAt(); showActionAt(avatar, r); }
                    return { result: formatPointAction(r, 'Click'), isError: !r.ok };
                }

                case 'agent_hover_at': {
                    const x = requireFiniteArg(args, 'x', 'agent_hover_at');
                    const y = requireFiniteArg(args, 'y', 'agent_hover_at');
                    if (x.error) return { result: x.error, isError: true };
                    if (y.error) return { result: y.error, isError: true };
                    const duration = optionalDurationMs(args.duration_ms, 0, 0, 5000, 'agent_hover_at');
                    if (duration.error) return { result: duration.error, isError: true };
                    const now = Date.now();
                    if (now - lastHidAt < HID_INTERVAL_MIN_MS) {
                        const wait = HID_INTERVAL_MIN_MS - (now - lastHidAt);
                        return { result: `Rate limited: HID action allowed in ${wait}ms.`, isError: true };
                    }
                    const force = args.force === true;
                    const refused = refuseIfUserActive(force, 'Refused hover');
                    if (refused) return refused;
                    lastHidAt = now;
                    const helperArgs = ['hover-at', String(x.value), String(y.value)];
                    if (duration.value > 0) helperArgs.push('--duration-ms', String(duration.value));
                    const r = await withDrivingAvatar(avatar, () => runHelper(deps, helperArgs));
                    if (r.ok) { bumpSelfActionAt(); showActionAt(avatar, r); }
                    return { result: formatPointAction(r, 'Hover'), isError: !r.ok };
                }

                case 'agent_drag': {
                    const fx = requireFiniteArg(args, 'from_x', 'agent_drag');
                    const fy = requireFiniteArg(args, 'from_y', 'agent_drag');
                    const tx = requireFiniteArg(args, 'to_x', 'agent_drag');
                    const ty = requireFiniteArg(args, 'to_y', 'agent_drag');
                    for (const checked of [fx, fy, tx, ty]) {
                        if (checked.error) return { result: checked.error, isError: true };
                    }
                    const duration = optionalDurationMs(args.duration_ms, 450, 50, 5000, 'agent_drag');
                    if (duration.error) return { result: duration.error, isError: true };
                    const button = normalizeButton(args.button);
                    if (button.error) return { result: button.error, isError: true };
                    const now = Date.now();
                    if (now - lastHidAt < HID_INTERVAL_MIN_MS) {
                        const wait = HID_INTERVAL_MIN_MS - (now - lastHidAt);
                        return { result: `Rate limited: HID action allowed in ${wait}ms.`, isError: true };
                    }
                    const force = args.force === true;
                    const refused = refuseIfUserActive(force, 'Refused drag');
                    if (refused) return refused;
                    lastHidAt = now;
                    const r = await withDrivingAvatar(avatar, () => runHelper(deps, [
                        'drag',
                        String(fx.value), String(fy.value),
                        String(tx.value), String(ty.value),
                        '--duration-ms', String(duration.value),
                        '--button', button.value,
                    ]));
                    if (r.ok) { bumpSelfActionAt(); showActionAt(avatar, r); }
                    return { result: formatDrag(r), isError: !r.ok };
                }

                case 'agent_scroll_at': {
                    const x = requireFiniteArg(args, 'x', 'agent_scroll_at');
                    const y = requireFiniteArg(args, 'y', 'agent_scroll_at');
                    const dx = requireFiniteArg(args, 'dx', 'agent_scroll_at');
                    const dy = requireFiniteArg(args, 'dy', 'agent_scroll_at');
                    for (const checked of [x, y, dx, dy]) {
                        if (checked.error) return { result: checked.error, isError: true };
                    }
                    const now = Date.now();
                    if (now - lastHidAt < HID_INTERVAL_MIN_MS) {
                        const wait = HID_INTERVAL_MIN_MS - (now - lastHidAt);
                        return { result: `Rate limited: HID action allowed in ${wait}ms.`, isError: true };
                    }
                    const force = args.force === true;
                    const refused = refuseIfUserActive(force, 'Refused scroll');
                    if (refused) return refused;
                    lastHidAt = now;
                    const r = await withDrivingAvatar(avatar, () => runHelper(deps, [
                        'scroll-at', String(x.value), String(y.value), String(dx.value), String(dy.value),
                    ]));
                    if (r.ok) { bumpSelfActionAt(); showActionAt(avatar, r); }
                    return { result: formatPointAction(r, 'Scroll'), isError: !r.ok };
                }

                case 'agent_keystroke': {
                    const key = String(args.key || '').trim();
                    if (!key) {
                        return { result: 'agent_keystroke requires a non-empty key (e.g. "j", "return", "f5").', isError: true };
                    }
                    const mods = args.mods ? String(args.mods).trim() : '';
                    const force = args.force === true;

                    const now = Date.now();
                    if (now - lastKeystrokeAt < KEYSTROKE_INTERVAL_MIN_MS) {
                        const wait = KEYSTROKE_INTERVAL_MIN_MS - (now - lastKeystrokeAt);
                        return {
                            result: `Rate limited: another keystroke allowed in ${wait}ms.`,
                            isError: true,
                        };
                    }

                    if (!force) {
                        const offending = detectUserActivity();
                        if (offending) {
                            return {
                                result: `Refused: user activity detected (${offending.event}${offending.app ? ' in ' + offending.app : ''}). Pass force=true to override.`,
                                isError: true,
                            };
                        }
                    }
                    lastKeystrokeAt = now;
                    const helperArgs = ['keystroke'];
                    if (mods) helperArgs.push('--mods', mods);
                    helperArgs.push(key);
                    const r = await runHelper(deps, helperArgs);
                    if (r.ok) { bumpSelfActionAt(); showActionAt(avatar, r); }
                    if (r.error) {
                        return {
                            result: `Keystroke failed: ${r.error}${r.detail ? ` (${r.detail})` : ''}`,
                            isError: true,
                        };
                    }
                    return {
                        result: `Sent ${mods ? mods + '+' : ''}${key}.`,
                        isError: false,
                    };
                }

                case 'agent_keystroke_global': {
                    const key = String(args.key || '').trim();
                    if (!key) {
                        return { result: 'agent_keystroke_global requires a non-empty key.', isError: true };
                    }
                    const mods = args.mods ? String(args.mods).trim() : '';
                    const force = args.force === true;
                    const now = Date.now();
                    if (now - lastKeystrokeAt < KEYSTROKE_INTERVAL_MIN_MS) {
                        const wait = KEYSTROKE_INTERVAL_MIN_MS - (now - lastKeystrokeAt);
                        return { result: `Rate limited: another keystroke allowed in ${wait}ms.`, isError: true };
                    }
                    const refused = refuseIfUserActive(force, 'Refused global keystroke');
                    if (refused) return refused;
                    lastKeystrokeAt = now;
                    const helperArgs = ['keystroke', '--no-focus-check'];
                    if (mods) helperArgs.push('--mods', mods);
                    helperArgs.push(key);
                    const r = await runHelper(deps, helperArgs);
                    if (r.ok) bumpSelfActionAt();
                    if (r.error) {
                        return { result: `Global keystroke failed: ${r.error}${r.detail ? ` (${r.detail})` : ''}`, isError: true };
                    }
                    return { result: `Sent global ${mods ? mods + '+' : ''}${key}.`, isError: false };
                }

                case 'agent_key_hold': {
                    const key = String(args.key || '').trim();
                    if (!key) {
                        return { result: 'agent_key_hold requires a non-empty key.', isError: true };
                    }
                    const mods = args.mods ? String(args.mods).trim() : '';
                    const duration = optionalDurationMs(args.duration_ms, 250, 10, 5000, 'agent_key_hold');
                    if (duration.error) return { result: duration.error, isError: true };
                    const force = args.force === true;
                    const now = Date.now();
                    if (now - lastKeystrokeAt < KEYSTROKE_INTERVAL_MIN_MS) {
                        const wait = KEYSTROKE_INTERVAL_MIN_MS - (now - lastKeystrokeAt);
                        return { result: `Rate limited: another key action allowed in ${wait}ms.`, isError: true };
                    }
                    const refused = refuseIfUserActive(force, 'Refused key hold');
                    if (refused) return refused;
                    lastKeystrokeAt = now;
                    const helperArgs = ['key-hold'];
                    if (args.global === true) helperArgs.push('--no-focus-check');
                    if (mods) helperArgs.push('--mods', mods);
                    helperArgs.push('--duration-ms', String(duration.value), key);
                    const r = await runHelper(deps, helperArgs);
                    if (r.ok) { bumpSelfActionAt(); showActionAt(avatar, r); }
                    return { result: formatKeyboardAction(r, 'Key hold'), isError: !r.ok };
                }

                case 'agent_modifier_latch': {
                    const mods = String(args.mods || '').trim();
                    if (!mods) {
                        return { result: 'agent_modifier_latch requires mods (e.g. "cmd,shift").', isError: true };
                    }
                    const duration = optionalDurationMs(args.duration_ms, 250, 10, 5000, 'agent_modifier_latch');
                    if (duration.error) return { result: duration.error, isError: true };
                    const force = args.force === true;
                    const now = Date.now();
                    if (now - lastKeystrokeAt < KEYSTROKE_INTERVAL_MIN_MS) {
                        const wait = KEYSTROKE_INTERVAL_MIN_MS - (now - lastKeystrokeAt);
                        return { result: `Rate limited: another key action allowed in ${wait}ms.`, isError: true };
                    }
                    const refused = refuseIfUserActive(force, 'Refused modifier latch');
                    if (refused) return refused;
                    lastKeystrokeAt = now;
                    const r = await runHelper(deps, [
                        'modifier-latch', '--mods', mods, '--duration-ms', String(duration.value),
                    ]);
                    if (r.ok) bumpSelfActionAt();
                    return { result: formatKeyboardAction(r, 'Modifier latch'), isError: !r.ok };
                }

                case 'agent_type_text': {
                    const text = String(args.text || '');
                    if (!text) {
                        return { result: 'agent_type_text requires non-empty text.', isError: true };
                    }
                    if (text.length > MAX_TYPE_TEXT_LENGTH) {
                        return {
                            result: `Refusing type-text: length ${text.length} exceeds limit ${MAX_TYPE_TEXT_LENGTH}.`,
                            isError: true,
                        };
                    }
                    const force = args.force === true;
                    const now = Date.now();
                    if (now - lastTypeTextAt < TYPE_TEXT_INTERVAL_MIN_MS) {
                        const wait = TYPE_TEXT_INTERVAL_MIN_MS - (now - lastTypeTextAt);
                        return {
                            result: `Rate limited: type-text allowed in ${wait}ms.`,
                            isError: true,
                        };
                    }
                    if (!force) {
                        const offending = detectUserActivity();
                        if (offending) {
                            return {
                                result: `Refused: user activity detected (${offending.event}). Pass force=true to override.`,
                                isError: true,
                            };
                        }
                    }
                    lastTypeTextAt = now;
                    const r = await runHelper(deps, ['type-text', text]);
                    if (r.ok) { bumpSelfActionAt(); showActionAt(avatar, r); }
                    if (r.error) {
                        return {
                            result: `Type-text failed: ${r.error}${r.detail ? ` (${r.detail})` : ''}`,
                            isError: true,
                        };
                    }
                    return {
                        result: `Typed ${text.length} character${text.length === 1 ? '' : 's'}.`,
                        isError: false,
                    };
                }

                case 'agent_select_range': {
                    const location = Number(args.location);
                    const length = Number(args.length);
                    if (!Number.isInteger(location) || location < 0) {
                        return { result: 'agent_select_range requires a non-negative integer location.', isError: true };
                    }
                    if (!Number.isInteger(length) || length < 0) {
                        return { result: 'agent_select_range requires a non-negative integer length.', isError: true };
                    }
                    const force = args.force === true;
                    const target = selectorOrLease(args, force, 'window');
                    if (target.error) return { result: `Select range failed: ${target.error}`, isError: true };
                    const refused = refuseIfUserActive(force, 'Refused select range');
                    if (refused) return refused;
                    if (target.selector) {
                        const { result: chain, step } = await runSelectorAction(
                            target.selector,
                            { op: 'select_range', location, length },
                            args.cursor_tolerance,
                        );
                        if (chain.ok && step && !step.error) {
                            bumpSelfActionAt();
                            rememberFocusLease(focusLeaseFromSelector(target.selector, target.source === 'lease' ? 'agent_select_range:lease' : 'agent_select_range', step));
                            showActionAt(avatar, step);
                            return {
                                result: `Selected ${step.length} chars at offset ${step.location} (of ${step.total_chars}).`,
                                isError: false,
                            };
                        }
                        return {
                            result: formatRunChain(chain).replace(/^Run chain/, 'Select range chain'),
                            isError: true,
                        };
                    }
                    const r = await runHelper(deps, [
                        'select-range', '--location', String(location), '--length', String(length),
                    ]);
                    if (r.ok) { bumpSelfActionAt(); showActionAt(avatar, r); }
                    if (r.error) {
                        return {
                            result: `Select range failed: ${r.error}${r.detail ? ` (${r.detail})` : ''}`,
                            isError: true,
                        };
                    }
                    return {
                        result: `Selected ${r.length} chars at offset ${r.location} (of ${r.total_chars}).`,
                        isError: false,
                    };
                }

                case 'agent_select_all': {
                    const force = args.force === true;
                    const target = selectorOrLease(args, force, 'window');
                    if (target.error) return { result: `Select all failed: ${target.error}`, isError: true };
                    const refused = refuseIfUserActive(force, 'Refused select all');
                    if (refused) return refused;
                    if (target.selector) {
                        const { result: chain, step } = await runSelectorAction(
                            target.selector,
                            { op: 'select_all' },
                            args.cursor_tolerance,
                        );
                        if (chain.ok && step && !step.error) {
                            bumpSelfActionAt();
                            rememberFocusLease(focusLeaseFromSelector(target.selector, target.source === 'lease' ? 'agent_select_all:lease' : 'agent_select_all', step));
                            showActionAt(avatar, step);
                            return {
                                result: `Selected ${step.length} of ${step.total_chars} chars.`,
                                isError: false,
                            };
                        }
                        return {
                            result: formatRunChain(chain).replace(/^Run chain/, 'Select all chain'),
                            isError: true,
                        };
                    }
                    const r = await runHelper(deps, ['select-all']);
                    if (r.ok) { bumpSelfActionAt(); showActionAt(avatar, r); }
                    if (r.error) {
                        return {
                            result: `Select all failed: ${r.error}${r.detail ? ` (${r.detail})` : ''}`,
                            isError: true,
                        };
                    }
                    return {
                        result: `Selected ${r.length} of ${r.total_chars} chars.`,
                        isError: false,
                    };
                }

                case 'agent_select_substring': {
                    const needle = String(args.needle || '');
                    if (!needle) {
                        return { result: 'agent_select_substring requires non-empty needle.', isError: true };
                    }
                    const occurrence = Number.isInteger(Number(args.occurrence)) && Number(args.occurrence) >= 0
                        ? Number(args.occurrence)
                        : 0;
                    const force = args.force === true;
                    const target = selectorOrLease(args, force, 'window');
                    if (target.error) return { result: `Select substring failed: ${target.error}`, isError: true };
                    const refused = refuseIfUserActive(force, 'Refused select substring');
                    if (refused) return refused;
                    if (target.selector) {
                        const { result: chain, step } = await runSelectorAction(
                            target.selector,
                            { op: 'select_substring', needle, occurrence },
                            args.cursor_tolerance,
                        );
                        if (chain.ok && step && !step.error) {
                            bumpSelfActionAt();
                            rememberFocusLease(focusLeaseFromSelector(target.selector, target.source === 'lease' ? 'agent_select_substring:lease' : 'agent_select_substring', step));
                            showActionAt(avatar, step);
                            return {
                                result: `Selected "${needle}" (occurrence ${occurrence}) at offset ${step.location}.`,
                                isError: false,
                            };
                        }
                        return {
                            result: formatRunChain(chain).replace(/^Run chain/, 'Select substring chain'),
                            isError: true,
                        };
                    }
                    const helperArgs = ['select-substring', '--occurrence', String(occurrence), needle];
                    const r = await runHelper(deps, helperArgs);
                    if (r.ok) { bumpSelfActionAt(); showActionAt(avatar, r); }
                    if (r.error) {
                        return {
                            result: `Select substring failed: ${r.error}${r.detail ? ` (${r.detail})` : ''}`,
                            isError: true,
                        };
                    }
                    return {
                        result: `Selected "${needle}" (occurrence ${occurrence}) at offset ${r.location}.`,
                        isError: false,
                    };
                }

                case 'agent_menu_command': {
                    const path = Array.isArray(args.path) ? args.path : null;
                    if (!path || path.length === 0) {
                        return { result: 'agent_menu_command requires a non-empty path array (e.g. ["Format","Body"]).', isError: true };
                    }
                    if (path.some((s) => typeof s !== 'string' || !s.trim())) {
                        return { result: 'agent_menu_command path must be non-empty strings.', isError: true };
                    }
                    // Rate limit through the press window — menu invocations
                    // are press-equivalent in blast radius.
                    const now = Date.now();
                    if (now - lastPressAt < PRESS_INTERVAL_MIN_MS) {
                        const wait = PRESS_INTERVAL_MIN_MS - (now - lastPressAt);
                        return { result: `Rate limited: menu command allowed in ${wait}ms.`, isError: true };
                    }
                    // User-activity guard: a menu command in the frontmost
                    // app can trigger destructive or state-changing actions.
                    // If Tom switched apps or opened a menu just before this
                    // call, the path walks the WRONG app's menu bar. Same
                    // override semantics as keystroke / type-text.
                    const force = args.force === true;
                    if (!force) {
                        const offending = detectUserActivity();
                        if (offending) {
                            return {
                                result: `Refused menu command: user activity detected (${offending.event}${offending.app ? ' in ' + offending.app : ''}). Pass force=true to override.`,
                                isError: true,
                            };
                        }
                    }
                    lastPressAt = now;
                    if (args.app || args.application || args.bundle_id || args.bundle) {
                        releaseHostKeyboardFocus('agent_menu_command');
                        const steps = [
                            {
                                op: 'menu',
                                app: args.app || args.application,
                                bundle_id: args.bundle_id || args.bundle,
                                path,
                                activate: args.activate !== false,
                            },
                        ];
                        const r = await runActSteps(steps, args.cursor_tolerance);
                        if (r.ok) {
                            bumpSelfActionAt();
                            scheduleActionSignals(avatar, r);
                        }
                        return { result: formatRunChain(r).replace(/^Run chain/, 'Menu command'), isError: !r.ok };
                    }
                    const r = await runHelper(deps, ['menu-command', ...path]);
                    if (r.ok) { bumpSelfActionAt(); showActionAt(avatar, r); }
                    if (r.error) {
                        return {
                            result: `Menu command failed: ${r.error}${r.detail ? ` (${r.detail})` : ''}`,
                            isError: true,
                        };
                    }
                    return {
                        result: `Invoked menu: ${path.join(' → ')} (leaf: ${r.leaf || ''}).`,
                        isError: false,
                    };
                }

                default:
                    return { result: `Unknown agent tool: ${tool}`, isError: true };
            }
        } catch (err) {
            return { result: `Agent action error: ${err.message}`, isError: true };
        }
    }

    return { handle };
}

module.exports = {
    init,
    // Exposed for tests.
    __test: {
        resolveHelperPath,
        formatRead,
        formatWrite,
        formatReadWindow,
        formatReadSubtree,
        formatFind,
        formatPress,
        formatFocus,
        formatFocusDiagnostics,
        formatRunChain,
        formatRunChainWithOutputs,
        formatStepOutputs,
        formatDescribeOps,
        formatEventLine,
        formatEvents,
        runHelper,
        buildDisambiguationArgs,
        buildElementTargetArgs,
        selectorFromArgs,
        focusLeaseFromActSteps,
        requireFiniteArg,
        optionalDurationMs,
        normalizeButton,
        maybeTravelToFrame,
        computeFrameLanding,
        FRAME_LANDING_OFFSET_PX,
    },
};
