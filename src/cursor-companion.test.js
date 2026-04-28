const { test } = require('node:test');
const assert = require('node:assert/strict');

const cursorCompanion = require('./main/cursor-companion');
const { __test } = cursorCompanion;

// init() requires Electron deps; these tests exercise only pure helpers
// exposed via __test (the constants and the shift-state hook).

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

test('shift held state can be toggled and read', () => {
    __test.setShiftHeldForTest(false);
    assert.equal(__test.getShiftHeldForTest(), false, 'shift starts unheld');
    __test.setShiftHeldForTest(true);
    assert.equal(__test.getShiftHeldForTest(), true, 'shift can be marked held');
    __test.setShiftHeldForTest(false);
    assert.equal(__test.getShiftHeldForTest(), false, 'shift can be released');
});
