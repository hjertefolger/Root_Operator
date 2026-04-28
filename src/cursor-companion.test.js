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

test('draft persists and respects 12h TTL', () => {
    __test.setDraftForTest('half-typed prompt');
    const draft = __test.getDraftForTest();
    assert.equal(draft.prompt, 'half-typed prompt');
    assert.ok(draft.updatedAt > 0, 'updatedAt is stamped');
    assert.equal(__test.getFreshDraftForTest(), 'half-typed prompt', 'fresh draft returned');

    // Forge an old timestamp — older than the TTL — and verify it's
    // discarded by getFreshDraft and the underlying state is cleared.
    const stale = Date.now() - __test.DRAFT_TTL_MS - 1000;
    __test.setDraftForTest('ancient draft', stale);
    assert.equal(__test.getFreshDraftForTest(), '', 'stale draft is dropped');
    assert.equal(__test.getDraftForTest().prompt, '', 'stale draft is cleared from state');

    // Reset for any subsequent tests.
    __test.setDraftForTest('');
});

test('empty draft assignment clears state', () => {
    __test.setDraftForTest('something');
    __test.setDraftForTest('');
    const after = __test.getDraftForTest();
    assert.equal(after.prompt, '');
    assert.equal(after.updatedAt, 0);
});

test('lastReply persists with TTL', () => {
    __test.setLastReplyForTest('hello world', '2026-04-28T08:00:00Z');
    const reply = __test.getLastReplyForTest();
    assert.equal(reply?.content, 'hello world');
    assert.equal(reply?.ts, '2026-04-28T08:00:00Z');
    assert.equal(__test.getFreshLastReplyForTest()?.content, 'hello world');

    const stale = Date.now() - __test.LAST_REPLY_TTL_MS - 1000;
    __test.setLastReplyForTest('aged reply', null, stale);
    assert.equal(__test.getFreshLastReplyForTest(), null, 'stale lastReply dropped');
    assert.equal(__test.getLastReplyForTest(), null, 'stale lastReply cleared');

    __test.setLastReplyForTest(null);
});

test('parked flag toggles independently of mode', () => {
    __test.setParkedForTest(false);
    assert.equal(__test.getParkedForTest(), false);
    __test.setParkedForTest(true);
    assert.equal(__test.getParkedForTest(), true);
    __test.setParkedForTest(false);
});

test('gesture lock window is non-zero', () => {
    assert.ok(__test.GESTURE_LOCK_MS >= 100, 'lock should be at least 100ms');
    assert.ok(__test.GESTURE_LOCK_MS <= 1000, 'lock should not exceed 1s');
});

test('stop() clears mode, parked flag, shift-held, and gesture lock', () => {
    // Pre-load all the derived state we expect stop() to clear.
    __test.setModeForTest('response');
    __test.setShiftHeldForTest(true);
    __test.setParkedForTest(true);
    __test.setGestureLockUntilForTest(Date.now() + 60_000);

    __test.runStopForTest();

    assert.equal(__test.getModeForTest(), 'dot');
    assert.equal(__test.getShiftHeldForTest(), false);
    assert.equal(__test.getParkedForTest(), false);
    assert.equal(__test.getGestureLockUntilForTest(), 0);
});
