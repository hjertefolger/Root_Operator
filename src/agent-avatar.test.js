const { test } = require('node:test');
const assert = require('node:assert/strict');

const { init, __test } = require('./main/agent-avatar');

function createFakeBrowserWindow() {
    const events = new Map();
    const calls = {
        setAlwaysOnTop: [],
        setVisibleOnAllWorkspaces: [],
        setHiddenInMissionControl: [],
        setIgnoreMouseEvents: [],
        showInactive: 0,
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
            close: () => { calls.close += 1; destroyed = true; },
            once: (evt, cb) => {
                const list = events.get(evt) || [];
                list.push(cb);
                events.set(evt, list);
            },
            on: () => {},
            setBounds: (bounds) => { calls.lastBounds = bounds; },
            getBounds: () => ({ x: 20, y: 44, width: __test.WIN_WIDTH, height: __test.WIN_HEIGHT }),
        },
        emit: (evt, ...args) => {
            for (const cb of events.get(evt) || []) cb(...args);
        },
        calls,
    };
}

function createDeps({
    workArea = { x: 0, y: 24, width: 1440, height: 876 },
    cursor = { x: 500, y: 400 },
    initialNow = 1_000_000,
} = {}) {
    const fake = createFakeBrowserWindow();
    const screenListeners = new Map();
    const appListeners = new Map();
    const calls = { loadRendererWindow: [], constructorOpts: [] };
    const cursorRef = { value: { ...cursor } };
    const clockRef = { now: initialNow };
    const screen = {
        getPrimaryDisplay: () => ({ workArea }),
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
        deps: { BrowserWindow, screen, app, loadRendererWindow, logDebug: () => {}, clock },
        fake,
        screen,
        app,
        calls,
        cursorRef,
        advanceClock: (ms) => { clockRef.now += ms; },
        setCursor: (x, y) => { cursorRef.value = { x, y }; },
    };
}

test('init throws without required deps', () => {
    assert.throws(() => init({}));
});

test('start creates a window, loads agent-avatar view, sets overlay flags', () => {
    const { deps, fake, calls } = createDeps();
    const avatar = init(deps);
    avatar.start();

    // BrowserWindow constructor opts: hardened defaults
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
    assert.equal(opts.x, 0 + __test.ANCHOR_OFFSET_X);
    assert.equal(opts.y, 24 + __test.ANCHOR_OFFSET_Y);
    if (process.platform === 'darwin') {
        assert.equal(opts.type, 'panel');
    }
    assert.equal(opts.webPreferences.nodeIntegration, false);
    assert.equal(opts.webPreferences.contextIsolation, true);
    assert.equal(opts.webPreferences.sandbox, true);

    // Window is loaded with the right view query
    assert.equal(calls.loadRendererWindow.length, 1);
    assert.equal(calls.loadRendererWindow[0].search, '?view=agent-avatar');

    // Overlay flags applied
    assert.equal(fake.calls.setAlwaysOnTop.length, 1);
    assert.deepEqual(fake.calls.setAlwaysOnTop[0], [true, 'floating']);
    assert.equal(fake.calls.setVisibleOnAllWorkspaces.length, 1);
    const vow = fake.calls.setVisibleOnAllWorkspaces[0];
    assert.equal(vow[0], true);
    assert.equal(vow[1].visibleOnFullScreen, true);
    assert.equal(vow[1].skipTransformProcessType, true);

    // Click-through enabled (no event forwarding in v0)
    assert.equal(fake.calls.setIgnoreMouseEvents.length, 1);
    assert.equal(fake.calls.setIgnoreMouseEvents[0][0], true);
    assert.equal(fake.calls.setIgnoreMouseEvents[0][1].forward, false);

    // Mission Control hidden
    assert.equal(fake.calls.setHiddenInMissionControl.length, 1);
    assert.equal(fake.calls.setHiddenInMissionControl[0][0], true);
});

test('window appears at workArea + (20, 20) on the primary display', () => {
    const { deps, fake } = createDeps({
        workArea: { x: 0, y: 24, width: 1440, height: 876 },
    });
    const avatar = init(deps);
    avatar.start();

    // The fake's getBounds reflects the construction bounds in this test
    // setup, so assert against the constants instead. We just verify the
    // module computed the expected position in repositionForTest.
    avatar.repositionForTest();
    assert.equal(fake.calls.lastBounds.x, 0 + 20);
    assert.equal(fake.calls.lastBounds.y, 24 + 20);
    assert.equal(fake.calls.lastBounds.width, __test.WIN_WIDTH);
    assert.equal(fake.calls.lastBounds.height, __test.WIN_HEIGHT);
});

test('window repositions when display metrics change', () => {
    let workArea = { x: 0, y: 24, width: 1440, height: 876 };
    const { deps, fake, screen } = createDeps({ workArea });
    deps.screen.getPrimaryDisplay = () => ({ workArea });
    const avatar = init(deps);
    avatar.start();

    // Simulate a display change — e.g. resolution swap or dock side flip
    workArea = { x: 80, y: 24, width: 1360, height: 876 };
    screen.emit('display-metrics-changed');

    assert.equal(fake.calls.lastBounds.x, 80 + 20);
    assert.equal(fake.calls.lastBounds.y, 24 + 20);
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
    // The fake reports the window as currently hidden so restore fires.
    fake.instance.isVisible = () => false;
    const avatar = init(deps);
    avatar.start();
    // Baseline: ready-to-show not emitted, so no showInactive yet.
    assert.equal(fake.calls.showInactive, 0);

    avatar.triggerAppHideForTest();
    // The first restore is scheduled at 0ms; let the macrotask run.
    await new Promise((resolve) => setTimeout(resolve, 5));
    // At least one restore has fired by now (delay 0 timer).
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
    // Wait past all APP_HIDE_RESTORE_DELAYS_MS values (max 350ms).
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(fake.calls.showInactive, before);
});

// ─────────────────────────────────────────────────────────────────
// v0.5 — Motion engine
// ─────────────────────────────────────────────────────────────────

test('initial state is idle_parked', () => {
    const { deps } = createDeps();
    const avatar = init(deps);
    avatar.start();
    assert.equal(avatar.getStateForTest(), __test.STATE.IDLE_PARKED);
});

test('summon transitions to traveling_to_cursor and starts ticking', () => {
    const { deps } = createDeps();
    const avatar = init(deps);
    avatar.start();
    avatar.summon();
    assert.equal(avatar.getStateForTest(), __test.STATE.TRAVELING_TO_CURSOR);
});

test('summon → tick over TRAVEL_DURATION_MS reaches active state at cursor + offset', () => {
    const { deps, advanceClock } = createDeps({ cursor: { x: 500, y: 400 } });
    const avatar = init(deps);
    avatar.start();
    avatar.summon();

    // Advance past the travel duration.
    advanceClock(__test.TRAVEL_DURATION_MS + 1);
    avatar.tickForTest();

    assert.equal(avatar.getStateForTest(), __test.STATE.ACTIVE);
    const pos = avatar.getPositionForTest();
    // Eased cubic at t=1 lands exactly on target.
    assert.equal(Math.round(pos.x), 500 + __test.CURSOR_OFFSET_X);
    assert.equal(Math.round(pos.y), 400 + __test.CURSOR_OFFSET_Y);
});

test('travel midway is between from and to (eased)', () => {
    const { deps, advanceClock } = createDeps({ cursor: { x: 1000, y: 500 } });
    const avatar = init(deps);
    avatar.start();
    avatar.summon();

    advanceClock(Math.floor(__test.TRAVEL_DURATION_MS / 2));
    avatar.tickForTest();

    const pos = avatar.getPositionForTest();
    // Anchor was (20, 44). Target is (1030, 500). Eased halfway should
    // be PAST 50% of the way (cubic-out front-loads movement).
    assert.ok(pos.x > 20 + (1030 - 20) * 0.5, `x progressed past 50%: ${pos.x}`);
    assert.ok(pos.x < 1030, `x did not overshoot: ${pos.x}`);
    assert.equal(avatar.getStateForTest(), __test.STATE.TRAVELING_TO_CURSOR);
});

test('summon while already traveling/active is a no-op', () => {
    const { deps, advanceClock } = createDeps({ cursor: { x: 600, y: 400 } });
    const avatar = init(deps);
    avatar.start();
    avatar.summon();
    advanceClock(__test.TRAVEL_DURATION_MS + 1);
    avatar.tickForTest();
    assert.equal(avatar.getStateForTest(), __test.STATE.ACTIVE);

    // Move cursor and summon again — should not reset state.
    avatar.summon();
    assert.equal(avatar.getStateForTest(), __test.STATE.ACTIVE);
});

test('active state spring-follows the cursor', () => {
    const { deps, advanceClock, setCursor } = createDeps({ cursor: { x: 500, y: 400 } });
    const avatar = init(deps);
    avatar.start();
    avatar.summon();
    advanceClock(__test.TRAVEL_DURATION_MS + 1);
    avatar.tickForTest();
    // Now active at (530, 400)
    const startPos = avatar.getPositionForTest();
    assert.equal(Math.round(startPos.x), 530);

    // Move the cursor and tick — position should move toward the new
    // target but not arrive instantly (spring-K applies).
    setCursor(800, 400);
    avatar.tickForTest();
    const afterPos = avatar.getPositionForTest();
    assert.ok(afterPos.x > startPos.x, 'x moved toward new target');
    assert.ok(afterPos.x < 800 + __test.CURSOR_OFFSET_X, 'x did not snap to target instantly');
});

test('dismiss transitions through traveling_to_anchor back to idle_parked', () => {
    const { deps, advanceClock } = createDeps({ cursor: { x: 500, y: 400 } });
    const avatar = init(deps);
    avatar.start();
    avatar.summon();
    advanceClock(__test.TRAVEL_DURATION_MS + 1);
    avatar.tickForTest();
    assert.equal(avatar.getStateForTest(), __test.STATE.ACTIVE);

    avatar.dismiss();
    assert.equal(avatar.getStateForTest(), __test.STATE.TRAVELING_TO_ANCHOR);

    advanceClock(__test.TRAVEL_DURATION_MS + 1);
    avatar.tickForTest();
    assert.equal(avatar.getStateForTest(), __test.STATE.IDLE_PARKED);

    const pos = avatar.getPositionForTest();
    assert.equal(Math.round(pos.x), __test.ANCHOR_OFFSET_X);
    assert.equal(Math.round(pos.y), 24 + __test.ANCHOR_OFFSET_Y);
});

test('dismiss when already parked is a no-op', () => {
    const { deps } = createDeps();
    const avatar = init(deps);
    avatar.start();
    assert.equal(avatar.getStateForTest(), __test.STATE.IDLE_PARKED);
    avatar.dismiss();
    assert.equal(avatar.getStateForTest(), __test.STATE.IDLE_PARKED);
});

test('display-metrics-changed while active does NOT pull the dot to the anchor', () => {
    const { deps, advanceClock, screen } = createDeps({ cursor: { x: 500, y: 400 } });
    const avatar = init(deps);
    avatar.start();
    avatar.summon();
    advanceClock(__test.TRAVEL_DURATION_MS + 1);
    avatar.tickForTest();
    assert.equal(avatar.getStateForTest(), __test.STATE.ACTIVE);

    // Simulate a display change. While active, the motion engine owns
    // position — the change must not snap us to the anchor.
    screen.emit('display-metrics-changed');
    const pos = avatar.getPositionForTest();
    // Still near the cursor, not at anchor.
    assert.ok(pos.x > 100, `position not snapped to anchor: ${pos.x}`);
});
