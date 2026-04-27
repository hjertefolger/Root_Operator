const { test } = require('node:test');
const assert = require('node:assert/strict');

const cursorCompanion = require('./main/cursor-companion');
const { __test } = cursorCompanion;

// init() requires Electron deps; tests exercise only pure helpers exposed
// via __test (the double-Option detector and the anchor clamper). State
// is explicitly reset between tests via resetTapStateForTest.

test('noteOptionTap: first tap arms the pair, returns false', () => {
    __test.resetTapStateForTest();
    const armed = __test.noteOptionTap();
    assert.equal(armed, false, 'first tap should arm but not fire');
});

test('noteOptionTap: second tap inside the window fires, returns true', () => {
    __test.resetTapStateForTest();
    __test.noteOptionTap(); // first tap, arms
    const fired = __test.noteOptionTap(); // second tap, immediate
    assert.equal(fired, true, 'second tap inside window should fire');
});

test('noteOptionTap: pair fires once, then state resets for a new pair', () => {
    __test.resetTapStateForTest();
    __test.noteOptionTap(); // arms
    __test.noteOptionTap(); // fires
    const next = __test.noteOptionTap();
    assert.equal(next, false, 'tap after a fired pair should arm a fresh pair');
});

test('noteOptionTap: window is sensible (200..600 ms)', () => {
    assert.ok(__test.DOUBLE_OPTION_WINDOW_MS >= 200);
    assert.ok(__test.DOUBLE_OPTION_WINDOW_MS <= 600);
});

test('CURSOR_LENS_CROP constants are sensible', () => {
    assert.ok(__test.CURSOR_LENS_CROP_W >= 320, 'crop width should be at least 320px');
    assert.ok(__test.CURSOR_LENS_CROP_H >= 240, 'crop height should be at least 240px');
    assert.ok(__test.CURSOR_LENS_CROP_W <= 1920);
    assert.ok(__test.CURSOR_LENS_CROP_H <= 1200);
});

test('clampAnchor: in-bounds anchor is unchanged', () => {
    __test.setScreenForTest({
        getDisplayNearestPoint: () => ({
            workArea: { x: 0, y: 0, width: 1920, height: 1080 },
        }),
    });
    const anchor = __test.clampAnchorForTest({ x: 500, y: 500 });
    assert.equal(anchor.x, 500);
    assert.equal(anchor.y, 500);
});

test('clampAnchor: anchor too close to right edge flips to the left', () => {
    __test.setScreenForTest({
        getDisplayNearestPoint: () => ({
            workArea: { x: 0, y: 0, width: 1920, height: 1080 },
        }),
    });
    // Bubble width is 360. Anchor at 1900 would land off-screen; clamp pulls
    // it back to fit (1920 - 360 - 8 = 1552).
    const anchor = __test.clampAnchorForTest({ x: 1900, y: 100 });
    assert.ok(anchor.x <= 1920 - 360);
});

test('clampAnchor: respects multi-display origin offset', () => {
    // Second display at x=1920..3840.
    __test.setScreenForTest({
        getDisplayNearestPoint: () => ({
            workArea: { x: 1920, y: 0, width: 1920, height: 1080 },
        }),
    });
    const anchor = __test.clampAnchorForTest({ x: 2500, y: 400 });
    assert.ok(anchor.x >= 1920, 'anchor must stay on the secondary display');
    assert.ok(anchor.x + 360 <= 3840 + 8, 'anchor must not slide off right edge');
});
