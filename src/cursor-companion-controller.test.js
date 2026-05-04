const { test } = require('node:test');
const assert = require('node:assert/strict');

const { init } = require('./main/cursor-companion-controller');

function createSubject({ initialStore = {}, exitMs = 0, withAgentAvatar = false } = {}) {
    const store = {
        data: { ...initialStore },
        get(key, fallback) {
            return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : fallback;
        },
        set(key, value) {
            this.data[key] = value;
        },
    };
    const calls = { start: 0, stop: 0, notify: [], avatarStart: 0, avatarStop: 0 };
    const broadcastCalls = [];

    const cursorCompanion = {
        start: () => { calls.start += 1; },
        stop: () => { calls.stop += 1; },
        notifyEnabledChanged: (enabled) => { calls.notify.push(enabled); },
    };
    let avatarWindow = null;
    const agentAvatar = withAgentAvatar ? {
        start: () => {
            calls.avatarStart += 1;
            avatarWindow = {};
        },
        stop: () => {
            calls.avatarStop += 1;
            avatarWindow = null;
        },
        getWindow: () => avatarWindow,
    } : null;

    const controller = init({
        getStore: () => store,
        cursorCompanion,
        getAgentAvatar: () => agentAvatar,
        logDebug: () => {},
        broadcastEnabled: (enabled) => broadcastCalls.push(enabled),
    });

    // Override exit animation delay so tests don't wait.
    if (exitMs === 0) {
        // The controller uses setTimeout(stop, EXIT_ANIMATION_MS). We can't
        // change the constant from outside without exposing internals;
        // instead, await the timer using a helper.
    }

    return { controller, store, calls, broadcastCalls };
}

function flushTimers(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

test('default missing cursorCompanionEnabled flag resolves to false', () => {
    const { controller } = createSubject();
    assert.equal(controller.bootstrap(), false);
    assert.equal(controller.isEnabled(), false);
});

test('bootstrap with persisted true starts the companion once', () => {
    const { controller, calls } = createSubject({ initialStore: { cursorCompanionEnabled: true } });
    controller.bootstrap();
    assert.equal(controller.isEnabled(), true);
    assert.equal(calls.start, 1);
});

test('setEnabled(true) starts the companion and persists the flag', () => {
    const { controller, store, calls, broadcastCalls } = createSubject();
    controller.bootstrap();

    const result = controller.setEnabled(true, 'test');
    assert.equal(result, true);
    assert.equal(controller.isEnabled(), true);
    assert.equal(calls.start, 1);
    assert.deepEqual(calls.notify, [true]);
    assert.equal(store.get('cursorCompanionEnabled'), true);
    assert.deepEqual(broadcastCalls, [true]);
});

test('setEnabled(false) plays exit animation then stops the companion', async () => {
    const { controller, store, calls, broadcastCalls } = createSubject({ initialStore: { cursorCompanionEnabled: true } });
    controller.bootstrap();
    assert.equal(calls.start, 1);
    // bootstrap() also fires notify(true) for the entrance animation;
    // the notify trail at this point should be [true].
    assert.deepEqual(calls.notify, [true]);

    controller.setEnabled(false, 'test');
    assert.equal(controller.isEnabled(), false);
    // notify(false) fires synchronously to start the exit animation.
    assert.deepEqual(calls.notify, [true, false]);
    // stop() fires after EXIT_ANIMATION_MS (220).
    assert.equal(calls.stop, 0);

    await flushTimers(controller.EXIT_ANIMATION_MS + 30);
    assert.equal(calls.stop, 1);
    assert.equal(store.get('cursorCompanionEnabled'), false);
    assert.deepEqual(broadcastCalls, [false]);
});

test('presence avatar follows the cursor companion enabled state', async () => {
    const { controller, calls } = createSubject({ withAgentAvatar: true });
    controller.bootstrap();

    controller.setEnabled(true, 'test');
    assert.equal(calls.avatarStart, 1);

    controller.setEnabled(false, 'test');
    assert.equal(calls.avatarStop, 1);

    await flushTimers(controller.EXIT_ANIMATION_MS + 30);
    assert.equal(calls.stop, 1);
});

test('toggle flips state and broadcasts', () => {
    const { controller, broadcastCalls } = createSubject();
    controller.bootstrap();
    const after1 = controller.toggle();
    assert.equal(after1, true);
    const after2 = controller.toggle();
    assert.equal(after2, false);
    assert.deepEqual(broadcastCalls, [true, false]);
});

test('setEnabled is idempotent: repeated same-value calls do not double-start or double-stop', async () => {
    const { controller, calls } = createSubject();
    controller.bootstrap();
    controller.setEnabled(true);
    controller.setEnabled(true);
    controller.setEnabled(true);
    assert.equal(calls.start, 1);
    controller.setEnabled(false);
    controller.setEnabled(false);
    await flushTimers(controller.EXIT_ANIMATION_MS + 30);
    assert.equal(calls.stop, 1);
});

test('shutdown stops the companion synchronously, skipping the exit animation', () => {
    const { controller, calls } = createSubject({ initialStore: { cursorCompanionEnabled: true } });
    controller.bootstrap();
    controller.shutdown();
    assert.equal(calls.stop, 1);
    assert.equal(controller.isEnabled(), false);
});

test('shutdown is safe even when companion is already disabled', () => {
    const { controller, calls } = createSubject();
    controller.bootstrap();
    controller.shutdown();
    assert.equal(calls.stop, 1);
});

test('toggling on→off→on while exit timer pending starts cleanly without leaving stop pending', async () => {
    const { controller, calls } = createSubject({ initialStore: { cursorCompanionEnabled: true } });
    controller.bootstrap();
    controller.setEnabled(false);
    // Before exit timer fires, re-enable.
    controller.setEnabled(true);
    await flushTimers(controller.EXIT_ANIMATION_MS + 30);
    // start was called twice: bootstrap + the re-enable; stop should
    // not have fired because the pending timer was cleared.
    assert.equal(calls.start, 2);
    assert.equal(calls.stop, 0);
    assert.equal(controller.isEnabled(), true);
});
