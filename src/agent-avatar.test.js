const { test } = require('node:test');
const assert = require('node:assert/strict');

const { init, __test } = require('./main/agent-avatar');

function createFakeBrowserWindow() {
    const events = new Map();
    const sentMessages = [];
    const calls = {
        setAlwaysOnTop: [],
        setVisibleOnAllWorkspaces: [],
        setHiddenInMissionControl: [],
        setIgnoreMouseEvents: [],
        showInactive: 0,
        hide: 0,
        close: 0,
        loaded: null,
    };
    let destroyed = false;
    return {
        instance: {
            isDestroyed: () => destroyed,
            setAlwaysOnTop: (...args) => calls.setAlwaysOnTop.push(args),
            setVisibleOnAllWorkspaces: (...args) => calls.setVisibleOnAllWorkspaces.push(args),
            setHiddenInMissionControl: (...args) => calls.setHiddenInMissionControl.push(args),
            setIgnoreMouseEvents: (...args) => calls.setIgnoreMouseEvents.push(args),
            showInactive: () => { calls.showInactive += 1; },
            hide: () => { calls.hide += 1; },
            close: () => { calls.close += 1; destroyed = true; },
            once: (evt, cb) => {
                const list = events.get(evt) || [];
                list.push(cb);
                events.set(evt, list);
            },
            on: () => {},
            setBounds: (bounds) => { calls.lastBounds = bounds; },
            getBounds: () => ({ x: 0, y: 0, width: __test.WIN_WIDTH, height: __test.WIN_HEIGHT }),
            webContents: {
                send: (channel, payload) => {
                    sentMessages.push({ channel, payload });
                },
            },
        },
        emit: (evt, ...args) => {
            for (const cb of events.get(evt) || []) cb(...args);
        },
        sentMessages,
        calls,
    };
}

function defaultDisplay() {
    return {
        bounds: { x: 0, y: 0, width: 1440, height: 900 },
        workArea: { x: 0, y: 24, width: 1440, height: 796 },
    };
}

function createDeps({
    display = defaultDisplay(),
    cursor = { x: 500, y: 400 },
    initialNow = 1_000_000,
    travelDurationMs,
    ambientSpringK,
    loadingRef = null,
} = {}) {
    const fake = createFakeBrowserWindow();
    const screenListeners = new Map();
    const appListeners = new Map();
    const calls = { loadRendererWindow: [], constructorOpts: [] };
    const cursorRef = { value: { ...cursor } };
    const clockRef = { now: initialNow };
    const displayRef = { value: display };
    const screen = {
        getPrimaryDisplay: () => displayRef.value,
        getCursorScreenPoint: () => ({ ...cursorRef.value }),
        on: (evt, cb) => {
            const list = screenListeners.get(evt) || [];
            list.push(cb);
            screenListeners.set(evt, list);
        },
        off: (evt, cb) => {
            const list = (screenListeners.get(evt) || []).filter((x) => x !== cb);
            screenListeners.set(evt, list);
        },
        emit: (evt, ...args) => {
            for (const cb of screenListeners.get(evt) || []) cb(...args);
        },
    };
    const BrowserWindow = function (opts) {
        calls.constructorOpts.push(opts);
        return fake.instance;
    };
    const app = {
        getAppPath: () => '/fake/app',
        on: (evt, cb) => {
            const list = appListeners.get(evt) || [];
            list.push(cb);
            appListeners.set(evt, list);
        },
        off: (evt, cb) => {
            const list = (appListeners.get(evt) || []).filter((x) => x !== cb);
            appListeners.set(evt, list);
        },
        emit: (evt, ...args) => {
            for (const cb of appListeners.get(evt) || []) cb(...args);
        },
    };
    const loadRendererWindow = (win, search) => {
        calls.loadRendererWindow.push({ win, search });
    };
    const clock = { now: () => clockRef.now };
    return {
        deps: {
            BrowserWindow, screen, app, loadRendererWindow,
            logDebug: () => {}, clock,
            ...(travelDurationMs ? { travelDurationMs } : {}),
            ...(ambientSpringK !== undefined ? { ambientSpringK } : {}),
            ...(loadingRef ? { isCursorCompanionLoading: () => loadingRef.value } : {}),
        },
        fake, screen, app, calls, cursorRef, displayRef,
        advanceClock: (ms) => { clockRef.now += ms; },
        setCursor: (x, y) => { cursorRef.value = { x, y }; },
        setDisplay: (d) => { displayRef.value = d; },
    };
}

test('init throws without required deps', () => {
    assert.throws(() => init({}));
});

test('start creates a window, loads agent-avatar view, sets overlay flags', () => {
    const { deps, fake, calls } = createDeps();
    const avatar = init(deps);
    avatar.start();

    assert.equal(calls.constructorOpts.length, 1);
    const opts = calls.constructorOpts[0];
    assert.equal(opts.transparent, true);
    assert.equal(opts.frame, false);
    assert.equal(opts.focusable, false);
    assert.equal(opts.skipTaskbar, true);
    assert.equal(opts.fullscreenable, false);
    assert.equal(opts.movable, false);
    assert.equal(opts.minimizable, false);
    assert.equal(opts.maximizable, false);
    assert.equal(opts.resizable, false);
    assert.equal(opts.hasShadow, false);
    assert.equal(opts.show, false);
    assert.equal(opts.width, __test.WIN_WIDTH);
    assert.equal(opts.height, __test.WIN_HEIGHT);
    if (process.platform === 'darwin') {
        assert.equal(opts.type, 'panel');
    }
    assert.equal(opts.webPreferences.nodeIntegration, false);
    assert.equal(opts.webPreferences.contextIsolation, true);
    assert.equal(opts.webPreferences.sandbox, true);

    assert.equal(calls.loadRendererWindow.length, 1);
    assert.equal(calls.loadRendererWindow[0].search, '?view=agent-avatar');

    assert.equal(fake.calls.setAlwaysOnTop.length, 1);
    assert.deepEqual(fake.calls.setAlwaysOnTop[0], [true, 'floating']);
    assert.equal(fake.calls.setVisibleOnAllWorkspaces.length, 1);
    const vow = fake.calls.setVisibleOnAllWorkspaces[0];
    assert.equal(vow[0], true);
    assert.equal(vow[1].visibleOnFullScreen, true);
    assert.equal(vow[1].skipTransformProcessType, true);

    assert.equal(fake.calls.setIgnoreMouseEvents.length, 1);
    assert.equal(fake.calls.setIgnoreMouseEvents[0][0], true);
    assert.equal(fake.calls.setIgnoreMouseEvents[0][1].forward, false);

    assert.equal(fake.calls.setHiddenInMissionControl.length, 1);
    assert.equal(fake.calls.setHiddenInMissionControl[0][0], true);
});

test('initial state is AMBIENT', () => {
    const { deps } = createDeps();
    const avatar = init(deps);
    avatar.start();
    assert.equal(avatar.getStateForTest(), __test.STATE.AMBIENT);
});

test('spawn position is at the user\'s cursor + default offset', () => {
    const { deps } = createDeps({ cursor: { x: 500, y: 400 } });
    const avatar = init(deps);
    avatar.start();
    const pos = avatar.getPositionForTest();
    assert.equal(pos.x, 500 + __test.DEFAULT_CURSOR_OFFSET_X);
    assert.equal(pos.y, 400 + __test.DEFAULT_CURSOR_OFFSET_Y);
});

test('ambient tick spring-follows the cursor toward target', () => {
    const { deps, setCursor, advanceClock } = createDeps({
        cursor: { x: 500, y: 400 },
        ambientSpringK: 0.5,
    });
    const avatar = init(deps);
    avatar.start();
    const before = avatar.getPositionForTest();

    setCursor(900, 600);
    advanceClock(20);
    avatar.tickForTest();
    const after = avatar.getPositionForTest();

    // With springK=0.5 the dot should move ~halfway toward the new
    // target on a single tick (target = 900+30, 600).
    const targetX = 930;
    const targetY = 600;
    assert.ok(after.x > before.x && after.x < targetX, `x mid-spring: ${after.x}`);
    assert.ok(after.y > before.y && after.y < targetY, `y mid-spring: ${after.y}`);
});

test('moveToCursor transitions to TRAVELING and returns target', () => {
    const { deps } = createDeps({ cursor: { x: 500, y: 400 } });
    const avatar = init(deps);
    avatar.start();
    const r = avatar.moveToCursor();
    assert.equal(avatar.getStateForTest(), __test.STATE.TRAVELING);
    assert.equal(r.to.x, 500 + __test.DEFAULT_CURSOR_OFFSET_X);
    assert.equal(r.to.y, 400 + __test.DEFAULT_CURSOR_OFFSET_Y);
});

test('travel completes and settles in ACTIVE at target', () => {
    const { deps, advanceClock } = createDeps({ cursor: { x: 500, y: 400 } });
    const avatar = init(deps);
    avatar.start();
    avatar.moveTo(800, 600);

    advanceClock(__test.DEFAULT_TRAVEL_DURATION_MS + 1);
    avatar.tickForTest();

    assert.equal(avatar.getStateForTest(), __test.STATE.ACTIVE);
    const pos = avatar.getPositionForTest();
    assert.equal(Math.round(pos.x), 800);
    assert.equal(Math.round(pos.y), 600);
});

test('ACTIVE does NOT spring-follow the cursor', () => {
    const { deps, advanceClock, setCursor } = createDeps({ cursor: { x: 500, y: 400 } });
    const avatar = init(deps);
    avatar.start();
    avatar.moveTo(800, 600);
    advanceClock(__test.DEFAULT_TRAVEL_DURATION_MS + 1);
    avatar.tickForTest();
    assert.equal(avatar.getStateForTest(), __test.STATE.ACTIVE);
    const before = avatar.getPositionForTest();

    setCursor(100, 100);
    advanceClock(50);
    avatar.tickForTest();
    const after = avatar.getPositionForTest();
    assert.equal(Math.round(after.x), Math.round(before.x), 'x should not follow cursor in ACTIVE');
});

test('moveTo throws on non-numeric coordinates', () => {
    const { deps } = createDeps();
    const avatar = init(deps);
    avatar.start();
    assert.throws(() => avatar.moveTo('abc', 100));
    assert.throws(() => avatar.moveTo(100, NaN));
});

test('moveToCursor while ACTIVE re-targets to new cursor position', () => {
    const { deps, advanceClock, setCursor } = createDeps({ cursor: { x: 500, y: 400 } });
    const avatar = init(deps);
    avatar.start();
    avatar.moveTo(800, 600);
    advanceClock(__test.DEFAULT_TRAVEL_DURATION_MS + 1);
    avatar.tickForTest();
    assert.equal(avatar.getStateForTest(), __test.STATE.ACTIVE);

    setCursor(900, 500);
    avatar.moveToCursor();
    assert.equal(avatar.getStateForTest(), __test.STATE.TRAVELING);

    advanceClock(__test.DEFAULT_TRAVEL_DURATION_MS + 1);
    avatar.tickForTest();
    assert.equal(avatar.getStateForTest(), __test.STATE.ACTIVE);
    const pos = avatar.getPositionForTest();
    assert.equal(Math.round(pos.x), 900 + __test.DEFAULT_CURSOR_OFFSET_X);
});

test('park() from ACTIVE travels back to cursor and resumes AMBIENT', () => {
    const { deps, advanceClock } = createDeps({ cursor: { x: 500, y: 400 } });
    const avatar = init(deps);
    avatar.start();
    avatar.moveTo(800, 600);
    advanceClock(__test.DEFAULT_TRAVEL_DURATION_MS + 1);
    avatar.tickForTest();
    assert.equal(avatar.getStateForTest(), __test.STATE.ACTIVE);

    avatar.park();
    assert.equal(avatar.getStateForTest(), __test.STATE.TRAVELING);

    advanceClock(__test.DEFAULT_TRAVEL_DURATION_MS + 1);
    avatar.tickForTest();
    assert.equal(avatar.getStateForTest(), __test.STATE.AMBIENT);
});

test('park() while AMBIENT refreshes position but stays AMBIENT', () => {
    const { deps } = createDeps({ cursor: { x: 500, y: 400 } });
    const avatar = init(deps);
    avatar.start();
    assert.equal(avatar.getStateForTest(), __test.STATE.AMBIENT);
    const r = avatar.park();
    assert.equal(avatar.getStateForTest(), __test.STATE.AMBIENT);
    assert.equal(r.to.x, 500 + __test.DEFAULT_CURSOR_OFFSET_X);
});

test('travel midway is between from and to (eased)', () => {
    const { deps, advanceClock } = createDeps({ cursor: { x: 500, y: 400 } });
    const avatar = init(deps);
    avatar.start();
    const startPos = avatar.getPositionForTest();
    avatar.moveTo(1200, 800);

    advanceClock(Math.floor(__test.DEFAULT_TRAVEL_DURATION_MS / 2));
    avatar.tickForTest();

    const pos = avatar.getPositionForTest();
    // Eased cubic-out: at t=0.5 progress is roughly 0.875.
    assert.ok(pos.x > startPos.x + (1200 - startPos.x) * 0.5, `x past 50%: ${pos.x}`);
    assert.ok(pos.x < 1200, `x < target: ${pos.x}`);
    assert.equal(avatar.getStateForTest(), __test.STATE.TRAVELING);
});

test('travelDurationMs override is honored', () => {
    const { deps, advanceClock } = createDeps({
        cursor: { x: 500, y: 400 },
        travelDurationMs: 200,
    });
    const avatar = init(deps);
    avatar.start();
    avatar.moveTo(800, 600);

    advanceClock(199);
    avatar.tickForTest();
    assert.equal(avatar.getStateForTest(), __test.STATE.TRAVELING);

    advanceClock(2);
    avatar.tickForTest();
    assert.equal(avatar.getStateForTest(), __test.STATE.ACTIVE);
});

test('AGENT_AVATAR_STATE is broadcast on transitions', () => {
    const { deps, advanceClock, fake } = createDeps({ cursor: { x: 500, y: 400 } });
    const avatar = init(deps);
    avatar.start();
    fake.emit('ready-to-show');

    avatar.moveTo(800, 600);
    advanceClock(__test.DEFAULT_TRAVEL_DURATION_MS + 1);
    avatar.tickForTest();

    const channels = fake.sentMessages.map((m) => m.channel);
    assert.ok(channels.includes('AGENT_AVATAR_STATE'), 'state broadcast');
    const states = fake.sentMessages
        .filter((m) => m.channel === 'AGENT_AVATAR_STATE')
        .map((m) => m.payload.state);
    assert.ok(states.includes('traveling'));
    assert.ok(states.includes('active'));
});

test('stop closes the window', () => {
    const { deps, fake } = createDeps();
    const avatar = init(deps);
    avatar.start();
    avatar.stop();
    assert.equal(fake.calls.close, 1);
    assert.equal(avatar.getWindow(), null);
});

test('start is idempotent — second call does not create a second window', () => {
    const { deps, calls } = createDeps();
    const avatar = init(deps);
    avatar.start();
    avatar.start();
    assert.equal(calls.loadRendererWindow.length, 1);
});

test('ready-to-show triggers showInactive', () => {
    const { deps, fake } = createDeps();
    const avatar = init(deps);
    avatar.start();
    fake.emit('ready-to-show');
    assert.equal(fake.calls.showInactive, 1);
});

test('app-hide schedules visibility restore via showInactive', async () => {
    const { deps, fake } = createDeps();
    fake.instance.isVisible = () => false;
    const avatar = init(deps);
    avatar.start();
    assert.equal(fake.calls.showInactive, 0);

    avatar.triggerAppHideForTest();
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(fake.calls.showInactive >= 1);

    avatar.stop();
});

test('stop clears restore timers so they do not fire later', async () => {
    const { deps, fake } = createDeps();
    fake.instance.isVisible = () => false;
    const avatar = init(deps);
    avatar.start();
    avatar.triggerAppHideForTest();
    avatar.stop();
    const before = fake.calls.showInactive;
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(fake.calls.showInactive, before);
});

// ─── Loader coordination ────────────────────────────────────────────────
//
// When cursor-companion's two-dot loader is showing, the ambient dot
// should yield the cursor slot. On the next intentional motion call the
// avatar reappears at the cursor anchor and travels from there.

test('ambient hides while cursor-companion loader is active', () => {
    const loadingRef = { value: false };
    const { deps, fake, advanceClock } = createDeps({
        cursor: { x: 500, y: 400 },
        loadingRef,
    });
    const avatar = init(deps);
    avatar.start();
    fake.emit('ready-to-show');
    const showsBefore = fake.calls.showInactive;
    const hidesBefore = fake.calls.hide;

    loadingRef.value = true;
    advanceClock(20);
    avatar.tickForTest();
    assert.ok(fake.calls.hide > hidesBefore, 'window.hide should be called when loader becomes active');
    assert.equal(avatar.getStateForTest(), __test.STATE.AMBIENT);

    loadingRef.value = false;
    advanceClock(20);
    avatar.tickForTest();
    assert.ok(fake.calls.showInactive > showsBefore, 'showInactive should be called once loader clears');
});

test('moveTo while hiddenForLoader starts travel from cursor anchor (not stale position)', () => {
    const loadingRef = { value: false };
    const { deps, fake, advanceClock, setCursor } = createDeps({
        cursor: { x: 500, y: 400 },
        loadingRef,
    });
    const avatar = init(deps);
    avatar.start();
    fake.emit('ready-to-show');

    // Loader starts → ambient hides at cursor anchor.
    loadingRef.value = true;
    advanceClock(20);
    avatar.tickForTest();

    // Cursor moves while we're hidden.
    setCursor(900, 600);
    advanceClock(20);
    avatar.tickForTest();

    // Now move to an explicit point. Travel should start from the
    // current cursor anchor (around 900,600 + offsets), not the
    // pre-loader position (~500,400).
    avatar.moveTo(1200, 800);
    assert.equal(avatar.getStateForTest(), __test.STATE.TRAVELING);

    // After a tiny bit of travel, position should still be near the
    // anchor (just left it), nowhere near the stale pre-loader spot.
    advanceClock(10);
    avatar.tickForTest();
    const pos = avatar.getPositionForTest();
    const anchorX = 900 + __test.DEFAULT_CURSOR_OFFSET_X;
    const anchorY = 600 + __test.DEFAULT_CURSOR_OFFSET_Y;
    assert.ok(Math.abs(pos.x - anchorX) < 200, `started near anchor x: ${pos.x} vs ${anchorX}`);
    assert.ok(Math.abs(pos.y - anchorY) < 200, `started near anchor y: ${pos.y} vs ${anchorY}`);

    // And it should have re-shown the window for travel.
    assert.ok(fake.calls.showInactive >= 1);
});

test('isCursorCompanionLoading missing or throwing is treated as not-loading', () => {
    // Throwing impl
    const { deps, fake, advanceClock } = createDeps({
        cursor: { x: 500, y: 400 },
    });
    deps.isCursorCompanionLoading = () => { throw new Error('boom'); };
    const avatar = init(deps);
    avatar.start();
    fake.emit('ready-to-show');
    advanceClock(20);
    avatar.tickForTest();
    // Should not have hidden; ambient continues normally.
    assert.equal(fake.calls.hide, 0);
});
