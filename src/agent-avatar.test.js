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
            getBounds: () => ({ x: 16, y: 0, width: __test.WIN_WIDTH, height: __test.WIN_HEIGHT }),
        },
        emit: (evt, ...args) => {
            for (const cb of events.get(evt) || []) cb(...args);
        },
        calls,
    };
}

// Default geometry: 1440x900 display with menu bar (24px) and Dock at
// bottom (~80px). The Dock-on-bottom anchor is bottom-left of workArea.
function defaultDisplay() {
    return {
        bounds: { x: 0, y: 0, width: 1440, height: 900 },
        workArea: { x: 0, y: 24, width: 1440, height: 796 }, // 900 - 24 (menu) - 80 (dock)
    };
}

function createDeps({
    display = defaultDisplay(),
    cursor = { x: 500, y: 400 },
    initialNow = 1_000_000,
    travelDurationMs,
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
        },
        fake, screen, app, calls, cursorRef, displayRef,
        advanceClock: (ms) => { clockRef.now += ms; },
        setCursor: (x, y) => { cursorRef.value = { x, y }; },
        setDisplay: (d) => { displayRef.value = d; },
    };
}

// Bottom-dock anchor with default geometry.
function expectedBottomAnchor(display) {
    return {
        x: display.workArea.x + __test.ANCHOR_EDGE_MARGIN,
        y: display.workArea.y + display.workArea.height - __test.WIN_HEIGHT - __test.ANCHOR_EDGE_MARGIN,
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

test('parks at bottom-left of workArea when Dock is on bottom', () => {
    const display = {
        bounds: { x: 0, y: 0, width: 1440, height: 900 },
        workArea: { x: 0, y: 24, width: 1440, height: 796 },
    };
    const { deps, fake } = createDeps({ display });
    const avatar = init(deps);
    avatar.start();

    const expected = expectedBottomAnchor(display);
    avatar.repositionForTest();
    assert.equal(fake.calls.lastBounds.x, expected.x);
    assert.equal(fake.calls.lastBounds.y, expected.y);
});

test('parks at top-left of workArea when Dock is on left (just to the right of the Dock)', () => {
    const display = {
        bounds: { x: 0, y: 0, width: 1440, height: 900 },
        workArea: { x: 80, y: 24, width: 1360, height: 876 },
    };
    const { deps, fake } = createDeps({ display });
    const avatar = init(deps);
    avatar.start();

    avatar.repositionForTest();
    assert.equal(fake.calls.lastBounds.x, 80 + __test.ANCHOR_EDGE_MARGIN);
    assert.equal(fake.calls.lastBounds.y, 24 + __test.ANCHOR_EDGE_MARGIN);
});

test('parks at top-right of workArea when Dock is on right (just to the left of the Dock)', () => {
    const display = {
        bounds: { x: 0, y: 0, width: 1440, height: 900 },
        workArea: { x: 0, y: 24, width: 1360, height: 876 },
    };
    const { deps, fake } = createDeps({ display });
    const avatar = init(deps);
    avatar.start();

    avatar.repositionForTest();
    assert.equal(fake.calls.lastBounds.x, 1360 - __test.WIN_WIDTH - __test.ANCHOR_EDGE_MARGIN);
    assert.equal(fake.calls.lastBounds.y, 24 + __test.ANCHOR_EDGE_MARGIN);
});

test('window repositions when display metrics change', () => {
    const initial = defaultDisplay();
    const { deps, fake, screen, setDisplay } = createDeps({ display: initial });
    const avatar = init(deps);
    avatar.start();

    const next = {
        bounds: { x: 0, y: 0, width: 2560, height: 1440 },
        workArea: { x: 0, y: 24, width: 2560, height: 1336 },
    };
    setDisplay(next);
    screen.emit('display-metrics-changed');

    const expected = expectedBottomAnchor(next);
    assert.equal(fake.calls.lastBounds.x, expected.x);
    assert.equal(fake.calls.lastBounds.y, expected.y);
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

// ─────────────────────────────────────────────────────────────────
// v1.5 — Intentional motion engine
// ─────────────────────────────────────────────────────────────────

test('initial state is idle_parked', () => {
    const { deps } = createDeps();
    const avatar = init(deps);
    avatar.start();
    assert.equal(avatar.getStateForTest(), __test.STATE.IDLE_PARKED);
});

test('moveToCursor transitions to traveling and returns target', () => {
    const { deps } = createDeps({ cursor: { x: 500, y: 400 } });
    const avatar = init(deps);
    avatar.start();
    const r = avatar.moveToCursor();
    assert.equal(avatar.getStateForTest(), __test.STATE.TRAVELING);
    assert.equal(r.to.x, 500 + __test.DEFAULT_CURSOR_OFFSET_X);
    assert.equal(r.to.y, 400 + __test.DEFAULT_CURSOR_OFFSET_Y);
});

test('moveToCursor → tick over default duration reaches active state at cursor + offset', () => {
    const { deps, advanceClock } = createDeps({ cursor: { x: 500, y: 400 } });
    const avatar = init(deps);
    avatar.start();
    avatar.moveToCursor();

    advanceClock(__test.DEFAULT_TRAVEL_DURATION_MS + 1);
    avatar.tickForTest();

    assert.equal(avatar.getStateForTest(), __test.STATE.ACTIVE);
    const pos = avatar.getPositionForTest();
    assert.equal(Math.round(pos.x), 500 + __test.DEFAULT_CURSOR_OFFSET_X);
    assert.equal(Math.round(pos.y), 400 + __test.DEFAULT_CURSOR_OFFSET_Y);
});

test('travel midway is between from and to (eased)', () => {
    const display = defaultDisplay();
    const anchor = expectedBottomAnchor(display);
    const { deps, advanceClock } = createDeps({ display, cursor: { x: 1000, y: 500 } });
    const avatar = init(deps);
    avatar.start();
    avatar.moveToCursor();

    advanceClock(Math.floor(__test.DEFAULT_TRAVEL_DURATION_MS / 2));
    avatar.tickForTest();

    const pos = avatar.getPositionForTest();
    const target = 1000 + __test.DEFAULT_CURSOR_OFFSET_X;
    // Eased cubic-out: at t=0.5 progress is roughly 0.875, so x should
    // be > 50% of the way and < target.
    assert.ok(pos.x > anchor.x + (target - anchor.x) * 0.5, `x past 50%: ${pos.x}`);
    assert.ok(pos.x < target, `x < target: ${pos.x}`);
    assert.equal(avatar.getStateForTest(), __test.STATE.TRAVELING);
});

test('moveTo(x,y) goes to explicit point and dwells there', () => {
    const { deps, advanceClock } = createDeps();
    const avatar = init(deps);
    avatar.start();
    avatar.moveTo(800, 600);
    assert.equal(avatar.getStateForTest(), __test.STATE.TRAVELING);

    advanceClock(__test.DEFAULT_TRAVEL_DURATION_MS + 1);
    avatar.tickForTest();
    assert.equal(avatar.getStateForTest(), __test.STATE.ACTIVE);
    const pos = avatar.getPositionForTest();
    assert.equal(Math.round(pos.x), 800);
    assert.equal(Math.round(pos.y), 600);
});

test('moveTo throws on non-numeric coordinates', () => {
    const { deps } = createDeps();
    const avatar = init(deps);
    avatar.start();
    assert.throws(() => avatar.moveTo('abc', 100));
    assert.throws(() => avatar.moveTo(100, NaN));
});

test('ACTIVE state does NOT spring-follow the cursor (intentional, no anchor to user)', () => {
    const { deps, advanceClock, setCursor } = createDeps({ cursor: { x: 500, y: 400 } });
    const avatar = init(deps);
    avatar.start();
    avatar.moveToCursor();
    advanceClock(__test.DEFAULT_TRAVEL_DURATION_MS + 1);
    avatar.tickForTest();
    assert.equal(avatar.getStateForTest(), __test.STATE.ACTIVE);
    const before = avatar.getPositionForTest();

    // Move the cursor far away — the agent must NOT follow.
    setCursor(1200, 800);
    advanceClock(50);
    avatar.tickForTest();
    const after = avatar.getPositionForTest();
    assert.equal(Math.round(after.x), Math.round(before.x), 'x should not follow cursor');
});

test('moveToCursor while ACTIVE re-targets to new cursor position', () => {
    const { deps, advanceClock, setCursor } = createDeps({ cursor: { x: 500, y: 400 } });
    const avatar = init(deps);
    avatar.start();
    avatar.moveToCursor();
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

test('park transitions through traveling back to idle_parked at the anchor', () => {
    const display = defaultDisplay();
    const anchor = expectedBottomAnchor(display);
    const { deps, advanceClock } = createDeps({ display, cursor: { x: 500, y: 400 } });
    const avatar = init(deps);
    avatar.start();
    avatar.moveToCursor();
    advanceClock(__test.DEFAULT_TRAVEL_DURATION_MS + 1);
    avatar.tickForTest();
    assert.equal(avatar.getStateForTest(), __test.STATE.ACTIVE);

    avatar.park();
    assert.equal(avatar.getStateForTest(), __test.STATE.TRAVELING);

    advanceClock(__test.DEFAULT_TRAVEL_DURATION_MS + 1);
    avatar.tickForTest();
    assert.equal(avatar.getStateForTest(), __test.STATE.IDLE_PARKED);

    const pos = avatar.getPositionForTest();
    assert.equal(Math.round(pos.x), anchor.x);
    assert.equal(Math.round(pos.y), anchor.y);
});

test('park when already parked refreshes anchor and stays IDLE_PARKED', () => {
    const display = defaultDisplay();
    const anchor = expectedBottomAnchor(display);
    const { deps, fake } = createDeps({ display });
    const avatar = init(deps);
    avatar.start();
    assert.equal(avatar.getStateForTest(), __test.STATE.IDLE_PARKED);

    const r = avatar.park();
    assert.equal(avatar.getStateForTest(), __test.STATE.IDLE_PARKED);
    assert.equal(Math.round(r.to.x), anchor.x);
    assert.equal(Math.round(r.to.y), anchor.y);
});

test('display-metrics-changed while traveling does NOT pull the dot to the anchor', () => {
    const { deps, advanceClock, screen } = createDeps({ cursor: { x: 500, y: 400 } });
    const avatar = init(deps);
    avatar.start();
    avatar.moveToCursor();
    advanceClock(__test.DEFAULT_TRAVEL_DURATION_MS + 1);
    avatar.tickForTest();
    assert.equal(avatar.getStateForTest(), __test.STATE.ACTIVE);

    screen.emit('display-metrics-changed');
    const pos = avatar.getPositionForTest();
    assert.ok(pos.x > 100, `position not snapped to anchor: ${pos.x}`);
});

test('travelDurationMs override is honored', () => {
    const { deps, advanceClock } = createDeps({
        cursor: { x: 500, y: 400 },
        travelDurationMs: 200,
    });
    const avatar = init(deps);
    avatar.start();
    avatar.moveToCursor();

    advanceClock(199);
    avatar.tickForTest();
    assert.equal(avatar.getStateForTest(), __test.STATE.TRAVELING);

    advanceClock(2);
    avatar.tickForTest();
    assert.equal(avatar.getStateForTest(), __test.STATE.ACTIVE);
});
