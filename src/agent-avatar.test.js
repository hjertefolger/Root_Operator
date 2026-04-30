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

function createDeps({ workArea = { x: 0, y: 24, width: 1440, height: 876 } } = {}) {
    const fake = createFakeBrowserWindow();
    const screenListeners = new Map();
    const appListeners = new Map();
    const calls = { loadRendererWindow: [], constructorOpts: [] };
    const screen = {
        getPrimaryDisplay: () => ({ workArea }),
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
    return {
        deps: { BrowserWindow, screen, app, loadRendererWindow, logDebug: () => {} },
        fake,
        screen,
        app,
        calls,
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
