const { test } = require('node:test');
const assert = require('node:assert/strict');

const { init, __test } = require('./main/agent-actions');

function fakeAvatar() {
    const calls = { moveTo: [], moveToCursor: [], park: 0 };
    return {
        instance: {
            moveTo: (x, y) => { calls.moveTo.push({ x, y }); return { to: { x, y } }; },
            moveToCursor: (ox, oy) => {
                calls.moveToCursor.push({ ox, oy });
                return { to: { x: 500 + (ox || 30), y: 400 + (oy || 0) } };
            },
            park: () => { calls.park += 1; return { to: { x: 16, y: 800 } }; },
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
        getAgentAvatar: () => avatar,
        logDebug: () => {},
    };
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
        appPath: '/nope',
        getAgentAvatar: () => null,
        logDebug: () => {},
    });
    const r = await handler.handle({ tool: 'agent_move_to_cursor', args: {} });
    assert.equal(r.isError, true);
    assert.match(r.result, /Agent avatar not available/);
});

test('agent_check_ax returns either trusted state or helper-missing', async () => {
    // The handler's helper resolver looks in resourcesPath, appPath/build/native,
    // and finally the source tree. In CI we may or may not have a built binary,
    // so we accept either outcome here — what matters is that the response is
    // structured (no thrown errors) and reports a reasonable shape.
    const handler = init({
        screen: fakeScreen(),
        appPath: '/definitely-not-here',
        resourcesPath: '/also-not-here',
        getAgentAvatar: () => null,
        logDebug: () => {},
    });
    const r = await handler.handle({ tool: 'agent_check_ax', args: {} });
    assert.match(
        r.result,
        /helper_missing|AX permission (?:granted|NOT granted)/,
        `unexpected result: ${r.result}`,
    );
});

test('agent_write_selection rejects empty text', async () => {
    const handler = init({
        screen: fakeScreen(),
        appPath: '/nope',
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
        appPath: '/nope',
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
        appPath: '/nope',
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
        appPath: '/nope',
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
        appPath: '/nope',
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
        appPath: '/nope',
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
        appPath: '/nope',
        getAgentAvatar: () => null,
        logDebug: () => {},
    });
    const r = await handler.handle({ tool: 'agent_recent_events', args: {} });
    assert.equal(r.isError, true);
    assert.match(r.result, /not wired/);
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

test('maybeTravelToFrame moves avatar to frame center', () => {
    const calls = [];
    const avatar = { moveTo: (x, y) => calls.push({ x, y }) };
    __test.maybeTravelToFrame(avatar, { frame: { x: 100, y: 200, w: 60, h: 24 } });
    assert.deepEqual(calls, [{ x: 130, y: 212 }]);
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
    // Must not throw — purely decorative.
    __test.maybeTravelToFrame(avatar, { frame: { x: 1, y: 1, w: 1, h: 1 } });
    assert.ok(true);
});
