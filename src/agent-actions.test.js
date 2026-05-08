const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { init, __test } = require('./main/agent-actions');

function fakeAvatar() {
    const calls = { moveTo: [], moveToCursor: [], park: 0, beginDriving: 0, endDriving: 0 };
    return {
        instance: {
            moveTo: (x, y) => { calls.moveTo.push({ x, y }); return { to: { x, y } }; },
            moveToCursor: (ox, oy) => {
                calls.moveToCursor.push({ ox, oy });
                return { to: { x: 500 + (ox || 30), y: 400 + (oy || 0) } };
            },
            park: () => { calls.park += 1; return { to: { x: 16, y: 800 } }; },
            beginDriving: () => { calls.beginDriving += 1; },
            endDriving: () => { calls.endDriving += 1; },
        },
        calls,
    };
}

function fakeHalo() {
    const calls = { show: [] };
    return {
        instance: {
            show: (frame, options) => { calls.show.push({ frame, options }); },
        },
        calls,
    };
}

function fakeScreen(cursor = { x: 500, y: 400 }) {
    return { getCursorScreenPoint: () => ({ ...cursor }) };
}

function makeDeps(avatar, opts = {}) {
    return {
        screen: fakeScreen(opts.cursor),
        appPath: opts.appPath || '/nonexistent/app',
        helperPath: Object.prototype.hasOwnProperty.call(opts, 'helperPath') ? opts.helperPath : null,
        getAgentAvatar: () => avatar,
        getAgentHalo: opts.halo ? () => opts.halo : undefined,
        releaseKeyboardFocus: opts.releaseKeyboardFocus,
        setTimeout: opts.setTimeout,
        logDebug: () => {},
    };
}

function makeFakeHelper(handlerSource) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-actions-helper-'));
    const helperPath = path.join(dir, 'helper.js');
    fs.writeFileSync(helperPath, `#!/usr/bin/env node\n${handlerSource}\n`, 'utf8');
    fs.chmodSync(helperPath, 0o755);
    return helperPath;
}

test('agent_move_to_cursor calls avatar.moveToCursor and returns target', async () => {
    const avatar = fakeAvatar();
    const handler = init(makeDeps(avatar.instance));
    const r = await handler.handle({ tool: 'agent_move_to_cursor', args: {} });
    assert.equal(r.isError, false);
    assert.match(r.result, /Moving to cursor → \(530, 400\)/);
    assert.equal(avatar.calls.moveToCursor.length, 1);
});

test('agent_move_to_cursor honors offset_x / offset_y', async () => {
    const avatar = fakeAvatar();
    const handler = init(makeDeps(avatar.instance));
    await handler.handle({ tool: 'agent_move_to_cursor', args: { offset_x: 50, offset_y: -10 } });
    const last = avatar.calls.moveToCursor[avatar.calls.moveToCursor.length - 1];
    assert.equal(last.ox, 50);
    assert.equal(last.oy, -10);
});

test('agent_move_to requires numeric x and y', async () => {
    const avatar = fakeAvatar();
    const handler = init(makeDeps(avatar.instance));
    const bad = await handler.handle({ tool: 'agent_move_to', args: { x: 'foo', y: 200 } });
    assert.equal(bad.isError, true);
    assert.match(bad.result, /numeric x and y/);

    const good = await handler.handle({ tool: 'agent_move_to', args: { x: 100, y: 200 } });
    assert.equal(good.isError, false);
    assert.equal(avatar.calls.moveTo.length, 1);
    assert.deepEqual(avatar.calls.moveTo[0], { x: 100, y: 200 });
});

test('agent_park calls avatar.park', async () => {
    const avatar = fakeAvatar();
    const handler = init(makeDeps(avatar.instance));
    const r = await handler.handle({ tool: 'agent_park', args: {} });
    assert.equal(r.isError, false);
    assert.match(r.result, /Parking at \(16, 800\)/);
    assert.equal(avatar.calls.park, 1);
});

test('motion calls without an avatar return a soft error', async () => {
    const handler = init({
        screen: fakeScreen(),
        helperPath: null,
        getAgentAvatar: () => null,
        logDebug: () => {},
    });
    const r = await handler.handle({ tool: 'agent_move_to_cursor', args: {} });
    assert.equal(r.isError, true);
    assert.match(r.result, /Agent avatar not available/);
});

test('agent_check_ax returns helper-missing when helperPath override is null', async () => {
    const handler = init({
        screen: fakeScreen(),
        helperPath: null,
        resourcesPath: '/also-not-here',
        getAgentAvatar: () => null,
        logDebug: () => {},
    });
    const r = await handler.handle({ tool: 'agent_check_ax', args: {} });
    assert.match(r.result, /helper_missing/);
});

test('agent_write_selection rejects empty text', async () => {
    const handler = init({
        screen: fakeScreen(),
        helperPath: null,
        getAgentAvatar: () => null,
        logDebug: () => {},
    });
    const r = await handler.handle({ tool: 'agent_write_selection', args: { text: '' } });
    assert.equal(r.isError, true);
    assert.match(r.result, /non-empty text/);
});

test('unknown agent tool returns a structured error', async () => {
    const handler = init({
        screen: fakeScreen(),
        helperPath: null,
        getAgentAvatar: () => null,
        logDebug: () => {},
    });
    const r = await handler.handle({ tool: 'agent_nonsense', args: {} });
    assert.equal(r.isError, true);
    assert.match(r.result, /Unknown agent tool/);
});

test('agent_find_element rejects empty label', async () => {
    const handler = init({
        screen: fakeScreen(),
        helperPath: null,
        getAgentAvatar: () => null,
        logDebug: () => {},
    });
    const r = await handler.handle({ tool: 'agent_find_element', args: { label: '' } });
    assert.equal(r.isError, true);
    assert.match(r.result, /non-empty label/);
});

test('agent_press_named rejects empty label', async () => {
    const handler = init({
        screen: fakeScreen(),
        helperPath: null,
        getAgentAvatar: () => null,
        logDebug: () => {},
    });
    const r = await handler.handle({ tool: 'agent_press_named', args: { label: '' } });
    assert.equal(r.isError, true);
    assert.match(r.result, /non-empty label/);
});

test('formatReadWindow renders the tree as indented role/label/frame lines', () => {
    const result = {
        app: 'Notes',
        bundle_id: 'com.apple.Notes',
        node_count: 4,
        tree: {
            role: 'AXWindow',
            label: 'My note',
            frame: { x: 100, y: 100, w: 800, h: 600 },
            children: [
                {
                    role: 'AXButton',
                    label: 'Send',
                    frame: { x: 700, y: 700, w: 60, h: 24 },
                },
            ],
        },
    };
    const out = __test.formatReadWindow(result);
    assert.match(out, /Active app: Notes/);
    assert.match(out, /AXWindow/);
    assert.match(out, /AXButton "Send"/);
    assert.match(out, /\[700,700 60x24\]/);
});

test('formatFind handles found and not-found cases', () => {
    const found = __test.formatFind({
        found: true,
        role: 'AXButton',
        label: 'Send',
        frame: { x: 100, y: 100, w: 60, h: 24 },
    });
    assert.match(found, /Found AXButton labeled "Send"/);
    assert.match(found, /\[100,100 60x24\]/);

    const missing = __test.formatFind({ error: 'not_found', searched: 87 });
    assert.match(missing, /Find failed: not_found/);
    assert.match(missing, /searched 87 nodes/);
});

test('formatPress handles success and failure', () => {
    const ok = __test.formatPress({
        ok: true,
        role: 'AXButton',
        label: 'Send',
    });
    assert.match(ok, /Pressed AXButton "Send"/);

    const fail = __test.formatPress({
        error: 'press_failed',
        role: 'AXButton',
        detail: 'ax_status=-25204',
    });
    assert.match(fail, /Press failed: press_failed/);
});

test('buildDisambiguationArgs accepts valid index and near pair', () => {
    const ok = __test.buildDisambiguationArgs({ index: 2, near_x: 100, near_y: 200 }, 'find');
    assert.equal(ok.error, undefined);
    assert.deepEqual(ok.args, ['--index', '2', '--near', '100,200']);
});

test('buildDisambiguationArgs rejects fractional or negative index', () => {
    const frac = __test.buildDisambiguationArgs({ index: 1.5 }, 'find');
    assert.match(frac.error, /non-negative integer/);
    const neg = __test.buildDisambiguationArgs({ index: -1 }, 'find');
    assert.match(neg.error, /non-negative integer/);
});

test('buildDisambiguationArgs rejects half-specified near pair', () => {
    const halfX = __test.buildDisambiguationArgs({ near_x: 100 }, 'find');
    assert.match(halfX.error, /near_x and near_y must be provided together/);
    const halfY = __test.buildDisambiguationArgs({ near_y: 200 }, 'find');
    assert.match(halfY.error, /near_x and near_y must be provided together/);
});

test('buildDisambiguationArgs rejects non-finite near coordinates', () => {
    const bad = __test.buildDisambiguationArgs({ near_x: 'abc', near_y: 200 }, 'find');
    assert.match(bad.error, /finite numbers/);
});

test('buildDisambiguationArgs returns empty argv when no disambiguation provided', () => {
    const empty = __test.buildDisambiguationArgs({}, 'find');
    assert.equal(empty.error, undefined);
    assert.deepEqual(empty.args, []);
});

test('agent_find_element returns structured error on malformed index', async () => {
    const handler = init({
        screen: fakeScreen(),
        helperPath: null,
        getAgentAvatar: () => null,
        logDebug: () => {},
    });
    const r = await handler.handle({
        tool: 'agent_find_element',
        args: { label: 'Send', index: 1.5 },
    });
    assert.equal(r.isError, true);
    assert.match(r.result, /agent_find_element: index/);
});

test('agent_focus_element sends target args and travels to focused frame', async () => {
    const argvPath = path.join(os.tmpdir(), `focus-argv-${process.pid}-${Date.now()}.json`);
    const helperPath = makeFakeHelper(`
const fs = require('fs');
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argvPath)}, JSON.stringify(argv) + '\\n');
if (argv[0] === 'focused-snapshot') {
  console.log(JSON.stringify({ role: 'AXTextArea', pid: 123, frame: { x: 100, y: 200, w: 300, h: 80 } }));
} else {
  console.log(JSON.stringify({
    ok: true,
    action: 'focus',
    role: 'AXTextArea',
    pid: 123,
    frame: { x: 100, y: 200, w: 300, h: 80 },
    fresh_verified: true,
    fresh_focused: { role: 'AXTextArea', pid: 123, frame: { x: 100, y: 200, w: 300, h: 80 } }
  }));
}
`);
    const avatar = fakeAvatar();
    const releaseCalls = [];
    const handler = init(makeDeps(avatar.instance, {
        helperPath,
        releaseKeyboardFocus: (reason) => releaseCalls.push(reason),
    }));
    const r = await handler.handle({
        tool: 'agent_focus_element',
        args: { role: 'AXTextArea', near_x: 900, near_y: 300, prefer_roles: ['AXTextArea'] },
    });
    assert.equal(r.isError, false);
    assert.match(r.result, /Focused AXTextArea/);
    const calls = fs.readFileSync(argvPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(calls[0], [
        'focus-element', '--role', 'AXTextArea', '--prefer-role', 'AXTextArea', '--near', '900,300',
    ]);
    assert.deepEqual(calls[1], ['focused-snapshot', '--pid', '123']);
    assert.deepEqual(releaseCalls, ['agent_focus_element']);
    assert.equal(avatar.calls.moveTo.length, 1);
    assert.equal(avatar.calls.moveTo[0].x, 100 + 300 + __test.FRAME_LANDING_OFFSET_PX);
});

test('agent_focus_element treats non-sticky native focus as failure', async () => {
    const helperPath = makeFakeHelper(`
console.log(JSON.stringify({
  error: 'focus_not_sticky',
  role: 'AXTextArea',
  detail: 'AXFocused setter succeeded, but system AXFocusedUIElement did not match the target within the settle window.',
  frame: { x: 100, y: 200, w: 300, h: 80 },
  focused_role: null
}));
`);
    const avatar = fakeAvatar();
    const handler = init(makeDeps(avatar.instance, { helperPath }));
    const r = await handler.handle({
        tool: 'agent_focus_element',
        args: { role: 'AXTextArea' },
    });
    assert.equal(r.isError, true);
    assert.match(r.result, /focus_not_sticky/);
    assert.equal(avatar.calls.moveTo.length, 0);
});

test('agent_focus_element augments non-sticky focus with diagnostics', async () => {
    const argvPath = path.join(os.tmpdir(), `focus-diag-argv-${process.pid}-${Date.now()}.json`);
    const helperPath = makeFakeHelper(`
const fs = require('fs');
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argvPath)}, JSON.stringify(argv) + '\\n');
if (argv[0] === 'diagnostics') {
  console.log(JSON.stringify({
    frontmost_application: { name: 'Notes', pid: 42, bundle_id: 'com.apple.Notes' },
    system_focused_application: {
      name: 'Notes',
      pid: 42,
      bundle_id: 'com.apple.Notes',
      focused_window: { role: 'AXWindow', title: 'Work', frame: { x: 10, y: 20, w: 800, h: 600 }, is_key: false, is_main: true },
      focused_ui_element: { role: 'AXWindow', pid: 42, frame: { x: 10, y: 20, w: 800, h: 600 } }
    },
    system_focused_ui_element: { role: 'AXWindow', pid: 42, frame: { x: 10, y: 20, w: 800, h: 600 } },
    root_operator_focused_windows: [
      { app: 'Root_Operator', bundle_id: 'com.hjertefolger.rootoperator', role: 'AXWindow', title: 'Cursor Presence', is_key: true, is_main: false }
    ],
    running_applications: [
      { name: 'Notes', pid: 42, windows: [{ role: 'AXWindow', title: 'Work', is_key: false, is_main: true }] }
    ]
  }));
} else {
  console.log(JSON.stringify({
    error: 'focus_not_sticky',
    role: 'AXTextArea',
    pid: 42,
    detail: 'AXFocused setter succeeded, but system AXFocusedUIElement did not match the target within the settle window.',
    frame: { x: 100, y: 200, w: 300, h: 80 }
  }));
}
`);
    const avatar = fakeAvatar();
    const handler = init(makeDeps(avatar.instance, { helperPath }));
    const r = await handler.handle({
        tool: 'agent_focus_element',
        args: { role: 'AXTextArea' },
    });
    assert.equal(r.isError, true);
    assert.match(r.result, /Focus diagnostics:/);
    assert.match(r.result, /system_focused_app=Notes pid=42 com\.apple\.Notes/);
    assert.match(r.result, /root_operator_focused_windows=AXWindow "Cursor Presence"/);
    const calls = fs.readFileSync(argvPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(calls[0], ['focus-element', '--role', 'AXTextArea']);
    assert.deepEqual(calls[1], ['diagnostics']);
});

test('agent_focus_element rejects ok result when fresh post-return focus is empty', async () => {
    const helperPath = makeFakeHelper(`
const argv = process.argv.slice(2);
if (argv[0] === 'focused-snapshot') {
  console.log(JSON.stringify({ error: 'no_focused_element' }));
} else {
  console.log(JSON.stringify({
    ok: true,
    action: 'focus',
    role: 'AXTextArea',
    pid: 123,
    frame: { x: 100, y: 200, w: 300, h: 80 },
    fresh_verified: true,
    fresh_focused: { role: 'AXTextArea', pid: 123, frame: { x: 100, y: 200, w: 300, h: 80 } }
  }));
}
`);
    const avatar = fakeAvatar();
    const handler = init(makeDeps(avatar.instance, { helperPath }));
    const r = await handler.handle({
        tool: 'agent_focus_element',
        args: { role: 'AXTextArea' },
    });
    assert.equal(r.isError, true);
    assert.match(r.result, /focus_not_sticky/);
    assert.match(r.result, /no_focused_element/);
    assert.equal(avatar.calls.moveTo.length, 0);
});

test('agent_click_at borrows driving state and passes HID args to helper', async () => {
    const argvPath = path.join(os.tmpdir(), `click-argv-${process.pid}-${Date.now()}.json`);
    const helperPath = makeFakeHelper(`
const fs = require('fs');
const argv = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(argv));
console.log(JSON.stringify({ ok: true, action: 'click', x: 10, y: 20, frame: { x: 4, y: 14, w: 12, h: 12 } }));
`);
    const avatar = fakeAvatar();
    const handler = init(makeDeps(avatar.instance, { helperPath }));
    const r = await handler.handle({
        tool: 'agent_click_at',
        args: { x: 10, y: 20, button: 'right', count: 2 },
    });
    assert.equal(r.isError, false);
    assert.match(r.result, /Click succeeded/);
    assert.deepEqual(JSON.parse(fs.readFileSync(argvPath, 'utf8')), [
        'click-at', '10', '20', '--button', 'right', '--count', '2',
    ]);
    assert.equal(avatar.calls.beginDriving, 1);
    assert.equal(avatar.calls.endDriving, 1);
    assert.equal(avatar.calls.moveTo.length, 1);
});

test('agent_click_at refuses recent user activity before driving', async () => {
    const avatar = fakeAvatar();
    const handler = init({
        screen: fakeScreen(),
        helperPath: null,
        getAgentAvatar: () => avatar.instance,
        getAgentEvents: () => ({
            getEvents: () => [
                { event: 'app_activated', ts: Date.now() / 1000 - 0.1, app: 'Notes' },
            ],
        }),
        logDebug: () => {},
    });
    const r = await handler.handle({ tool: 'agent_click_at', args: { x: 10, y: 20 } });
    assert.equal(r.isError, true);
    assert.match(r.result, /Refused click/);
    assert.equal(avatar.calls.beginDriving, 0);
});

test('formatFind / formatPress include disambiguation hint when match_count > 1', () => {
    const out = __test.formatFind({
        found: true,
        role: 'AXButton',
        label: 'More',
        frame: { x: 1010, y: 160, w: 28, h: 28 },
        match_count: 3,
        match_index: 0,
    });
    assert.match(out, /match 1 of 3/);
    assert.match(out, /near_x\/near_y/);

    const single = __test.formatFind({
        found: true,
        role: 'AXButton',
        label: 'Send',
        frame: { x: 100, y: 100, w: 60, h: 24 },
        match_count: 1,
    });
    assert.doesNotMatch(single, /match \d of/);
});

test('agent_recent_events returns formatted lines from getAgentEvents', async () => {
    const ts = 1717800000;
    const handler = init({
        screen: fakeScreen(),
        helperPath: null,
        getAgentAvatar: () => null,
        getAgentEvents: () => ({
            getEvents: () => [
                { event: 'app_activated', ts, app: 'Notes' },
                { event: 'AXSelectedTextChanged', ts: ts + 1, app: 'Notes', role: 'AXTextArea', selected_text: 'hello' },
            ],
        }),
        logDebug: () => {},
    });
    const r = await handler.handle({ tool: 'agent_recent_events', args: {} });
    assert.equal(r.isError, false);
    assert.match(r.result, /app_activated/);
    assert.match(r.result, /AXSelectedTextChanged/);
    assert.match(r.result, /selected="hello"/);
});

test('agent_recent_events surfaces when events not wired', async () => {
    const handler = init({
        screen: fakeScreen(),
        helperPath: null,
        getAgentAvatar: () => null,
        logDebug: () => {},
    });
    const r = await handler.handle({ tool: 'agent_recent_events', args: {} });
    assert.equal(r.isError, true);
    assert.match(r.result, /not wired/);
});

test('agent_run_chain sends JSON payload to helper and reports cursor invariant', async () => {
    const argvPath = path.join(os.tmpdir(), `chain-argv-${process.pid}-${Date.now()}.json`);
    const helperPath = makeFakeHelper(`
const fs = require('fs');
const argv = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(argv));
const payload = JSON.parse(argv[1]);
console.log(JSON.stringify({
  ok: true,
  cursor_unchanged: true,
  cursor_delta: 0,
  steps: payload.steps.map((step, index) => ({ ok: true, index, op: step.op, frame: index === payload.steps.length - 1 ? { x: 10, y: 20, w: 30, h: 40 } : undefined }))
}));
`);
    const avatar = fakeAvatar();
    const releaseCalls = [];
    const handler = init(makeDeps(avatar.instance, {
        helperPath,
        releaseKeyboardFocus: (reason) => releaseCalls.push(reason),
    }));
    const r = await handler.handle({
        tool: 'agent_run_chain',
        args: {
            cursor_tolerance: 1,
            steps: [
                { op: 'launch_app', bundle_id: 'com.apple.Notes' },
                { op: 'read', target: 'editor' },
            ],
        },
    });
    assert.equal(r.isError, false);
    assert.match(r.result, /Run chain completed 2 steps/);
    assert.match(r.result, /Cursor unchanged/);
    assert.deepEqual(releaseCalls, ['agent_run_chain']);
    assert.equal(avatar.calls.moveTo.length, 1);
    const argv = JSON.parse(fs.readFileSync(argvPath, 'utf8'));
    assert.equal(argv[0], 'run-chain');
    const payload = JSON.parse(argv[1]);
    assert.equal(payload.cursor_tolerance, 1);
    assert.equal(payload.steps[0].op, 'launch_app');
});

test('agent_run_chain validates step array before spawning helper', async () => {
    const handler = init({
        screen: fakeScreen(),
        helperPath: null,
        getAgentAvatar: () => null,
        logDebug: () => {},
    });
    const r = await handler.handle({ tool: 'agent_run_chain', args: { steps: [] } });
    assert.equal(r.isError, true);
    assert.match(r.result, /non-empty steps array/);
});

test('agent_act sends generic steps through act helper command', async () => {
    const argvPath = path.join(os.tmpdir(), `act-argv-${process.pid}-${Date.now()}.json`);
    const helperPath = makeFakeHelper(`
const fs = require('fs');
const argv = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(argv));
const payload = JSON.parse(argv[1]);
console.log(JSON.stringify({
  ok: true,
  cursor_unchanged: true,
  cursor_delta: 0,
  steps: payload.steps.map((step, index) => ({ ok: true, index, op: step.op, frame: index === 1 ? { x: 10, y: 20, w: 30, h: 40 } : undefined }))
}));
`);
    const avatar = fakeAvatar();
    const releaseCalls = [];
    const handler = init(makeDeps(avatar.instance, {
        helperPath,
        releaseKeyboardFocus: (reason) => releaseCalls.push(reason),
    }));
    const r = await handler.handle({
        tool: 'agent_act',
        args: {
            cursor_tolerance: 1,
            force: true,
            steps: [
                { op: 'resolve', as: 'delete_item', scope: 'system', role: 'AXMenuItem', label: 'Delete' },
                { op: 'perform_action', target: 'delete_item', action: 'AXPress' },
            ],
        },
    });
    assert.equal(r.isError, false);
    assert.match(r.result, /Generic action completed 2 steps/);
    assert.deepEqual(releaseCalls, ['agent_act']);
    assert.equal(avatar.calls.moveTo.length, 1);
    const argv = JSON.parse(fs.readFileSync(argvPath, 'utf8'));
    assert.equal(argv[0], 'act');
    const payload = JSON.parse(argv[1]);
    assert.equal(payload.steps[0].scope, 'system');
    assert.equal(payload.steps[1].action, 'AXPress');
});

test('agent_describe_ops returns generic op registry', async () => {
    const handler = init({
        screen: fakeScreen(),
        helperPath: null,
        getAgentAvatar: () => null,
        logDebug: () => {},
    });
    const r = await handler.handle({ tool: 'agent_describe_ops', args: {} });
    assert.equal(r.isError, false);
    assert.match(r.result, /wait_for_role/);
    assert.match(r.result, /write_selection/);
    assert.match(r.result, /Selector fields/);
});

test('agent_describe_ops documents production verification and scoped fallbacks', async () => {
    const handler = init({
        screen: fakeScreen(),
        helperPath: null,
        getAgentAvatar: () => null,
        logDebug: () => {},
    });
    const r = await handler.handle({ tool: 'agent_describe_ops', args: {} });
    assert.equal(r.isError, false);
    assert.match(r.result, /menu: aliases=menu_command,menu-command/);
    assert.match(r.result, /verify_font_size/);
    assert.match(r.result, /Do not treat an intermediate control AXValue as proof/);
    assert.match(r.result, /AXUIElementCopyAttributeValue/);
    assert.match(r.result, /require_focus=false/);
    assert.match(r.result, /Workflow-first rule/);
    assert.match(r.result, /Known native pattern for font-size combo boxes/);
    assert.match(r.result, /Geometry attribute rule/);
    assert.match(r.result, /AXPosition expects an object \{x:int, y:int\}/);
    assert.match(r.result, /AXSize expects \{width:int, height:int\}/);
});

test('channel bridge describes semantic verification for agent_act', () => {
    const bridgeSource = fs.readFileSync(path.join(__dirname, '..', 'channel-bridge.cjs'), 'utf8');
    assert.match(bridgeSource, /verify the requested app-state postcondition/);
    assert.match(bridgeSource, /alias menu_command/);
    assert.match(bridgeSource, /scoped keystroke\/type_text CGEvents/);
    assert.match(bridgeSource, /verify_font_size/);
    assert.match(bridgeSource, /not just the font-size control value/);
    assert.match(bridgeSource, /Geometry attribute rule/);
    assert.match(bridgeSource, /AXPosition expects \{x,y\}/);
    assert.match(bridgeSource, /AXSize expects \{width,height\}/);
    assert.match(bridgeSource, /Do not use this for multi-step targeted app workflows/);
    assert.match(bridgeSource, /Workflow-first rule/);
    assert.match(bridgeSource, /before composing new primitive agent_act steps/);
});

test('agent_act surfaces read step outputs', async () => {
    const helperPath = makeFakeHelper(`
const payload = JSON.parse(process.argv[3]);
console.log(JSON.stringify({
  ok: true,
  cursor_unchanged: true,
  cursor_delta: 0,
  steps: payload.steps.map((step, index) => ({
    ok: true,
    index,
    op: step.op,
    role: 'AXTextArea',
    value: step.op === 'read' ? 'hello from read' : undefined,
    frame: { x: 10, y: 20, w: 30, h: 40 }
  }))
}));
`);
    const handler = init(makeDeps(fakeAvatar().instance, { helperPath }));
    const r = await handler.handle({
        tool: 'agent_act',
        args: {
            force: true,
            steps: [
                { op: 'resolve', app: 'Notes', scope: 'app', role: 'AXTextArea', as: 'editor' },
                { op: 'read', target: 'editor' },
            ],
        },
    });
    assert.equal(r.isError, false);
    assert.match(r.result, /Step outputs:/);
    assert.match(r.result, /hello from read/);
});

test('focus lease from agent_act lets select_substring run without restating selector', async () => {
    const callsPath = path.join(os.tmpdir(), `lease-calls-${process.pid}-${Date.now()}.json`);
    const helperPath = makeFakeHelper(`
const fs = require('fs');
const callsPath = ${JSON.stringify(callsPath)};
const argv = process.argv.slice(2);
const calls = fs.existsSync(callsPath) ? JSON.parse(fs.readFileSync(callsPath, 'utf8')) : [];
calls.push(argv);
fs.writeFileSync(callsPath, JSON.stringify(calls));
const payload = JSON.parse(argv[1]);
const steps = payload.steps.map((step, index) => {
  const base = { ok: true, index, op: step.op, role: step.role || 'AXTextArea', frame: { x: 10, y: 20, w: 30, h: 40 } };
  if (step.op === 'resolve') return { ...base, found: true, as: step.as, label: 'Body' };
  if (step.op === 'focus') return { ...base, action: 'focus', fresh_verified: true };
  if (step.op === 'select_substring') return { ...base, action: 'select_range', location: 6, length: String(step.needle || '').length, total_chars: 30 };
  return base;
});
console.log(JSON.stringify({ ok: true, cursor_unchanged: true, cursor_delta: 0, steps }));
`);
    const handler = init(makeDeps(fakeAvatar().instance, { helperPath }));
    const focused = await handler.handle({
        tool: 'agent_act',
        args: {
            force: true,
            steps: [
                { op: 'resolve', app: 'Notes', scope: 'app', role: 'AXTextArea', as: 'editor' },
                { op: 'focus', target: 'editor' },
            ],
        },
    });
    assert.equal(focused.isError, false);

    const selected = await handler.handle({
        tool: 'agent_select_substring',
        args: { needle: 'demo', force: true },
    });
    assert.equal(selected.isError, false);
    assert.match(selected.result, /Selected "demo"/);

    const calls = JSON.parse(fs.readFileSync(callsPath, 'utf8'));
    assert.equal(calls.length, 2);
    const secondPayload = JSON.parse(calls[1][1]);
    assert.deepEqual(secondPayload.steps.map((step) => step.op), ['resolve', 'focus', 'select_substring']);
    assert.equal(secondPayload.steps[0].app, 'Notes');
    assert.equal(secondPayload.steps[0].role, 'AXTextArea');
});

test('focus lease invalidates on user activity without force', async () => {
    const helperPath = makeFakeHelper(`
const payload = JSON.parse(process.argv[3]);
console.log(JSON.stringify({
  ok: true,
  cursor_unchanged: true,
  cursor_delta: 0,
  steps: payload.steps.map((step, index) => ({ ok: true, index, op: step.op, role: step.role || 'AXTextArea', found: step.op === 'resolve', frame: { x: 1, y: 2, w: 3, h: 4 } }))
}));
`);
    let exposeUserActivity = false;
    const handler = init({
        ...makeDeps(fakeAvatar().instance, { helperPath }),
        getAgentEvents: () => ({
            getEvents: () => (exposeUserActivity
                ? [{ event: 'app_activated', app: 'Safari', ts: (Date.now() + 2000) / 1000 }]
                : []),
        }),
    });
    const focused = await handler.handle({
        tool: 'agent_act',
        args: {
            force: true,
            steps: [
                { op: 'resolve', app: 'Notes', scope: 'app', role: 'AXTextArea', as: 'editor' },
                { op: 'focus', target: 'editor' },
            ],
        },
    });
    assert.equal(focused.isError, false);
    exposeUserActivity = true;
    const selected = await handler.handle({
        tool: 'agent_select_substring',
        args: { needle: 'demo' },
    });
    assert.equal(selected.isError, true);
    assert.match(selected.result, /focus_invalidated_by_user_activity/);
});

test('agent_act triggers visual feedback for every successful framed bridge step', async () => {
    const helperPath = makeFakeHelper(`
const steps = [
  { ok: true, index: 0, op: 'perform_action', action: 'perform_action', frame: { x: 10, y: 10, w: 20, h: 20 } },
  { ok: true, index: 1, op: 'set_attribute', action: 'set_attribute', frame: { x: 40, y: 10, w: 20, h: 20 } },
  { ok: true, index: 2, op: 'hid', action: 'hid_click', frame: { x: 70, y: 10, w: 12, h: 12 } },
  { ok: true, index: 3, op: 'set_attribute', action: 'set_attribute', frame: { x: 100, y: 10, w: 20, h: 20 } },
  { ok: true, index: 4, op: 'perform_action', action: 'perform_action', frame: { x: 130, y: 10, w: 20, h: 20 } }
];
console.log(JSON.stringify({ ok: true, cursor_unchanged: true, cursor_delta: 0, steps }));
`);
    const avatar = fakeAvatar();
    const halo = fakeHalo();
    const scheduledDelays = [];
    const handler = init(makeDeps(avatar.instance, {
        helperPath,
        halo: halo.instance,
        setTimeout: (fn, delay) => {
            scheduledDelays.push(delay);
            fn();
            return { unref: () => {} };
        },
    }));
    const r = await handler.handle({
        tool: 'agent_act',
        args: {
            force: true,
            steps: [
                { op: 'perform_action', target: 'a', action: 'AXPress' },
                { op: 'set_attribute', target: 'a', attribute: 'AXValue', value: 'one' },
                { op: 'hid', kind: 'click', x: 1, y: 1 },
                { op: 'set_attribute', target: 'a', attribute: 'AXValue', value: 'two' },
                { op: 'perform_action', target: 'a', action: 'AXPress' },
            ],
        },
    });
    assert.equal(r.isError, false);
    assert.equal(avatar.calls.moveTo.length, 5);
    assert.equal(halo.calls.show.length, 5);
    assert.deepEqual(scheduledDelays, [620, 1240, 1860, 2480]);
});

test('agent_act validates step array before spawning helper', async () => {
    const handler = init({
        screen: fakeScreen(),
        helperPath: null,
        getAgentAvatar: () => null,
        logDebug: () => {},
    });
    const r = await handler.handle({ tool: 'agent_act', args: { steps: [] } });
    assert.equal(r.isError, true);
    assert.match(r.result, /non-empty steps array/);
});

test('formatEventLine renders ts/event/app/role/value compactly', () => {
    const out = __test.formatEventLine({
        event: 'AXValueChanged',
        ts: 1717800000,
        app: 'Notes',
        role: 'AXTextArea',
        value: 'Hello world',
    });
    assert.match(out, /AXValueChanged/);
    assert.match(out, /app=Notes/);
    assert.match(out, /role=AXTextArea/);
    assert.match(out, /value="Hello world"/);
});

test('computeFrameLanding lands at right edge + offset, vertically centered', () => {
    // No screen helper → defaults to right side.
    const landing = __test.computeFrameLanding({ x: 100, y: 200, w: 60, h: 24 });
    assert.deepEqual(landing, { x: 100 + 60 + __test.FRAME_LANDING_OFFSET_PX, y: 212 });
});

test('computeFrameLanding falls back to left edge when right would overflow display', () => {
    // Frame near the right edge of a 1440-wide display; right landing
    // would push past 1440. Should fall back to left side.
    const screen = {
        getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
    };
    const landing = __test.computeFrameLanding({ x: 1400, y: 200, w: 30, h: 24 }, screen);
    assert.equal(landing.x, 1400 - __test.FRAME_LANDING_OFFSET_PX); // left edge
    assert.equal(landing.y, 212);
});

test('computeFrameLanding stays on right when display has room', () => {
    const screen = {
        getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
    };
    const landing = __test.computeFrameLanding({ x: 100, y: 200, w: 60, h: 24 }, screen);
    assert.equal(landing.x, 100 + 60 + __test.FRAME_LANDING_OFFSET_PX);
});

test('computeFrameLanding returns null on bad input', () => {
    assert.equal(__test.computeFrameLanding(null), null);
    assert.equal(__test.computeFrameLanding({ x: NaN, y: 1, w: 1, h: 1 }), null);
});

test('maybeTravelToFrame calls avatar.moveTo with edge landing', () => {
    const calls = [];
    const avatar = { moveTo: (x, y) => calls.push({ x, y }) };
    __test.maybeTravelToFrame(avatar, { frame: { x: 100, y: 200, w: 60, h: 24 } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].x, 100 + 60 + __test.FRAME_LANDING_OFFSET_PX);
    assert.equal(calls[0].y, 212);
});

test('maybeTravelToFrame is a no-op without an avatar or frame', () => {
    const calls = [];
    const avatar = { moveTo: (x, y) => calls.push({ x, y }) };
    __test.maybeTravelToFrame(null, { frame: { x: 100, y: 200, w: 60, h: 24 } });
    __test.maybeTravelToFrame(avatar, null);
    __test.maybeTravelToFrame(avatar, {}); // no frame
    __test.maybeTravelToFrame(avatar, { frame: { x: NaN, y: 1, w: 1, h: 1 } });
    assert.equal(calls.length, 0);
});

test('maybeTravelToFrame swallows avatar.moveTo errors (best-effort)', () => {
    const avatar = { moveTo: () => { throw new Error('boom'); } };
    __test.maybeTravelToFrame(avatar, { frame: { x: 1, y: 1, w: 1, h: 1 } });
    assert.ok(true);
});

test('agent_keystroke rejects empty key', async () => {
    const handler = init({
        screen: fakeScreen(),
        helperPath: null,
        getAgentAvatar: () => null,
        logDebug: () => {},
    });
    const r = await handler.handle({ tool: 'agent_keystroke', args: { key: '' } });
    assert.equal(r.isError, true);
    assert.match(r.result, /non-empty key/);
});

test('agent_type_text rejects empty text and over-cap text', async () => {
    const handler = init({
        screen: fakeScreen(),
        helperPath: null,
        getAgentAvatar: () => null,
        logDebug: () => {},
    });
    const empty = await handler.handle({ tool: 'agent_type_text', args: { text: '' } });
    assert.equal(empty.isError, true);
    assert.match(empty.result, /non-empty/);

    const tooLong = await handler.handle({ tool: 'agent_type_text', args: { text: 'a'.repeat(2500) } });
    assert.equal(tooLong.isError, true);
    assert.match(tooLong.result, /exceeds limit/);
});

test('agent_menu_command refuses on user activity (no force)', async () => {
    const recentTs = Date.now() / 1000 - 0.2;
    const handler = init({
        screen: fakeScreen(),
        helperPath: null,
        getAgentAvatar: () => null,
        getAgentEvents: () => ({
            getEvents: () => [
                { event: 'AXFocusedUIElementChanged', ts: recentTs, app: 'Safari' },
            ],
        }),
        logDebug: () => {},
    });
    const r = await handler.handle({
        tool: 'agent_menu_command',
        args: { path: ['Format', 'Body'] },
    });
    assert.equal(r.isError, true);
    assert.match(r.result, /Refused menu command/);
});

test('agent_select_range rejects non-integer or negative bounds', async () => {
    const handler = init({
        screen: fakeScreen(),
        helperPath: null,
        getAgentAvatar: () => null,
        logDebug: () => {},
    });
    const fractional = await handler.handle({
        tool: 'agent_select_range',
        args: { location: 1.5, length: 10 },
    });
    assert.equal(fractional.isError, true);
    assert.match(fractional.result, /non-negative integer location/);

    const negative = await handler.handle({
        tool: 'agent_select_range',
        args: { location: 0, length: -3 },
    });
    assert.equal(negative.isError, true);
    assert.match(negative.result, /non-negative integer length/);
});

test('agent_select_substring rejects empty needle', async () => {
    const handler = init({
        screen: fakeScreen(),
        helperPath: null,
        getAgentAvatar: () => null,
        logDebug: () => {},
    });
    const r = await handler.handle({ tool: 'agent_select_substring', args: { needle: '' } });
    assert.equal(r.isError, true);
    assert.match(r.result, /non-empty needle/);
});

test('agent_menu_command rejects empty or non-string path', async () => {
    const handler = init({
        screen: fakeScreen(),
        helperPath: null,
        getAgentAvatar: () => null,
        logDebug: () => {},
    });
    const empty = await handler.handle({ tool: 'agent_menu_command', args: {} });
    assert.equal(empty.isError, true);
    assert.match(empty.result, /non-empty path array/);

    const bad = await handler.handle({
        tool: 'agent_menu_command',
        args: { path: ['Format', '', 'Body'] },
    });
    assert.equal(bad.isError, true);
    assert.match(bad.result, /must be non-empty strings/);
});

test('agent_menu_command targets named app through atomic AX chain', async () => {
    const argvPath = path.join(os.tmpdir(), `menu-app-chain-${process.pid}-${Date.now()}.json`);
    const helperPath = makeFakeHelper(`
const fs = require('fs');
const argv = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(argv));
const payload = JSON.parse(argv[1]);
console.log(JSON.stringify({
  ok: true,
  cursor_unchanged: true,
  cursor_delta: 0,
  steps: payload.steps.map((step, index) => ({ ok: true, index, op: step.op, action: 'menu', frame: { x: 10, y: 20, w: 30, h: 40 } }))
}));
`);
    const handler = init(makeDeps(fakeAvatar().instance, { helperPath }));
    const r = await handler.handle({
        tool: 'agent_menu_command',
        args: { app: 'Finder', path: ['File', 'New Finder Window'], force: true },
    });
    assert.equal(r.isError, false);
    assert.match(r.result, /Menu command completed 1 step/);
    const argv = JSON.parse(fs.readFileSync(argvPath, 'utf8'));
    assert.equal(argv[0], 'act');
    const payload = JSON.parse(argv[1]);
    assert.deepEqual(payload.steps[0], {
        op: 'menu',
        app: 'Finder',
        path: ['File', 'New Finder Window'],
        activate: true,
    });
});

test('agent_press_named targets named app through atomic AX chain', async () => {
    const argvPath = path.join(os.tmpdir(), `press-app-chain-${process.pid}-${Date.now()}.json`);
    const helperPath = makeFakeHelper(`
const fs = require('fs');
const argv = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(argv));
const payload = JSON.parse(argv[1]);
console.log(JSON.stringify({
  ok: true,
  cursor_unchanged: true,
  cursor_delta: 0,
  steps: payload.steps.map((step, index) => ({ ok: true, index, op: step.op, action: 'press', label: step.label, role: 'AXButton', frame: { x: 10, y: 20, w: 30, h: 40 } }))
}));
`);
    const handler = init(makeDeps(fakeAvatar().instance, { helperPath }));
    const r = await handler.handle({
        tool: 'agent_press_named',
        args: { app: 'Calculator', label: '1', role: 'AXButton', force: true },
    });
    assert.equal(r.isError, false);
    assert.match(r.result, /Press named completed 1 step/);
    const argv = JSON.parse(fs.readFileSync(argvPath, 'utf8'));
    assert.equal(argv[0], 'act');
    const payload = JSON.parse(argv[1]);
    assert.equal(payload.steps[0].op, 'press_named');
    assert.equal(payload.steps[0].app, 'Calculator');
    assert.equal(payload.steps[0].label, '1');
    assert.equal(payload.steps[0].role, 'AXButton');
});

test('agent_keystroke refuses while user activity is detected (no force)', async () => {
    // getAgentEvents returns an event that should look like user activity:
    // recent (within window) and outside our self-action window.
    const recentTs = Date.now() / 1000 - 0.2; // 200ms ago
    const handler = init({
        screen: fakeScreen(),
        helperPath: null,
        getAgentAvatar: () => null,
        getAgentEvents: () => ({
            getEvents: () => [
                { event: 'AXValueChanged', ts: recentTs, app: 'Notes' },
            ],
        }),
        logDebug: () => {},
    });
    const r = await handler.handle({
        tool: 'agent_keystroke',
        args: { key: 'j', mods: 'cmd,shift' },
    });
    assert.equal(r.isError, true);
    assert.match(r.result, /user activity detected/);
    assert.match(r.result, /AXValueChanged/);
});
