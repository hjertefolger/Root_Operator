const { test } = require('node:test');
const assert = require('node:assert/strict');

const cursorCompanion = require('./main/cursor-companion');
const { __test } = cursorCompanion;

// init() requires Electron deps; tests exercise only pure helpers exposed
// via __test (the double-Option detector and the constants). State is
// explicitly reset between tests via resetTapStateForTest.

test('noteOptionTap: first tap arms the pair, returns false', () => {
    __test.resetTapStateForTest();
    const armed = __test.noteOptionTap();
    assert.equal(armed, false, 'first tap should arm but not fire');
});

test('noteOptionTap: second tap inside the window fires, returns true', () => {
    __test.resetTapStateForTest();
    __test.noteOptionTap();
    const fired = __test.noteOptionTap();
    assert.equal(fired, true, 'second tap inside window should fire');
});

test('noteOptionTap: pair fires once, then state resets for a new pair', () => {
    __test.resetTapStateForTest();
    __test.noteOptionTap();
    __test.noteOptionTap();
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

test('window canvas is large enough to host every state', () => {
    assert.ok(__test.WIN_WIDTH >= 600, 'window must fit max pill width');
    assert.ok(__test.WIN_HEIGHT >= 200, 'window must fit response state');
});

test('cursor anchor leaves room for the pill on left and top', () => {
    assert.ok(__test.ANCHOR_X >= 8, 'anchor offset must reserve some left margin');
    assert.ok(__test.ANCHOR_Y >= 8, 'anchor offset must reserve some top margin');
    assert.ok(__test.ANCHOR_X < __test.WIN_WIDTH / 2, 'anchor must sit in the left half');
});

test('initial mode is dot before any state changes', () => {
    assert.equal(__test.getModeForTest(), 'dot');
});
