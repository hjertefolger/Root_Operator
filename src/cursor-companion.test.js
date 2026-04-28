const { test } = require('node:test');
const assert = require('node:assert/strict');

const cursorCompanion = require('./main/cursor-companion');
const { __test } = cursorCompanion;

// init() requires Electron deps; these tests exercise only pure helpers
// exposed via __test.

test('CURSOR_LENS_CROP constants are sensible', () => {
    assert.ok(__test.CURSOR_LENS_CROP_W >= 320, 'crop width should be at least 320px');
    assert.ok(__test.CURSOR_LENS_CROP_H >= 240, 'crop height should be at least 240px');
    assert.ok(__test.CURSOR_LENS_CROP_W <= 1920);
    assert.ok(__test.CURSOR_LENS_CROP_H <= 1200);
});

test('window canvas is large enough to host every state', () => {
    assert.ok(__test.WIN_WIDTH >= 600, 'window must fit max pill width');
    assert.ok(__test.WIN_HEIGHT >= 400, 'window must fit stacked layers');
});

test('cursor anchor leaves room for the pill on left and top', () => {
    assert.ok(__test.ANCHOR_X >= 8, 'anchor offset must reserve some left margin');
    assert.ok(__test.ANCHOR_Y >= 8, 'anchor offset must reserve some top margin');
    assert.ok(__test.ANCHOR_X < __test.WIN_WIDTH / 2, 'anchor must sit in the left half');
});

test('initial mode is dot before any layers are visible', () => {
    __test.setInputOpenForTest(false);
    __test.setRepliesForTest([]);
    __test.setPendingForTest(null);
    assert.equal(__test.getModeForTest(), 'dot');
});

test('mode reflects layer priority: input > response > loading > dot', () => {
    __test.setPendingForTest({ turnId: 't1', startedAt: Date.now(), attachmentPath: null });
    __test.setRepliesForTest([]);
    __test.setInputOpenForTest(false);
    assert.equal(__test.getModeForTest(), 'loading');

    __test.setRepliesForTest([{ id: 'r1', content: 'hi', ts: null, role: 'assistant' }]);
    assert.equal(__test.getModeForTest(), 'response', 'replies override loading in mode display');

    __test.setInputOpenForTest(true);
    assert.equal(__test.getModeForTest(), 'input', 'open input wins over everything');

    __test.setInputOpenForTest(false);
    __test.setRepliesForTest([]);
    __test.setPendingForTest(null);
});

test('shift held state can be toggled and read', () => {
    __test.setShiftHeldForTest(false);
    assert.equal(__test.getShiftHeldForTest(), false);
    __test.setShiftHeldForTest(true);
    assert.equal(__test.getShiftHeldForTest(), true);
    __test.setShiftHeldForTest(false);
});

test('draft persists and respects 12h TTL', () => {
    __test.setDraftForTest('half-typed prompt');
    const draft = __test.getDraftForTest();
    assert.equal(draft.prompt, 'half-typed prompt');
    assert.ok(draft.updatedAt > 0);
    assert.equal(__test.getFreshDraftForTest(), 'half-typed prompt');

    const stale = Date.now() - __test.DRAFT_TTL_MS - 1000;
    __test.setDraftForTest('ancient draft', stale);
    assert.equal(__test.getFreshDraftForTest(), '');
    assert.equal(__test.getDraftForTest().prompt, '');

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
    assert.equal(__test.getFreshLastReplyForTest(), null);
    assert.equal(__test.getLastReplyForTest(), null);

    __test.setLastReplyForTest(null);
});

test('parked flag toggles independently', () => {
    __test.setParkedForTest(false);
    assert.equal(__test.getParkedForTest(), false);
    __test.setParkedForTest(true);
    assert.equal(__test.getParkedForTest(), true);
    __test.setParkedForTest(false);
});

test('gesture lock window is non-zero', () => {
    assert.ok(__test.GESTURE_LOCK_MS >= 100);
    assert.ok(__test.GESTURE_LOCK_MS <= 1000);
});

test('terminal grace window is configured', () => {
    assert.ok(__test.TERMINAL_GRACE_MS >= 250, 'grace must allow socket reply to land');
    assert.ok(__test.TERMINAL_GRACE_MS <= 5000, 'grace should not stall on truly silent turns');
});

test('reply stack cap is set', () => {
    assert.ok(__test.REPLY_STACK_CAP >= 2);
    assert.ok(__test.REPLY_STACK_CAP <= 10);
});

test('attachment TTL is configured', () => {
    assert.ok(__test.CURSOR_ATTACHMENT_TTL_MS >= 60_000, 'TTL must outlast a single in-flight turn');
});

test('reply stack appends and caps at REPLY_STACK_CAP, evicting oldest', () => {
    __test.setRepliesForTest([]);
    const cap = __test.REPLY_STACK_CAP;
    for (let i = 0; i < cap + 2; i++) {
        __test.pushReplyForTest({ content: `msg ${i}`, ts: null, role: 'assistant' });
    }
    const stack = __test.getRepliesForTest();
    assert.equal(stack.length, cap, 'stack does not exceed cap');
    assert.equal(stack[0].content, `msg 2`, 'oldest evicted (FIFO)');
    assert.equal(stack[stack.length - 1].content, `msg ${cap + 1}`, 'newest at top');
    __test.setRepliesForTest([]);
});

test('input open and replies are independent layers', () => {
    __test.setInputOpenForTest(true);
    __test.setRepliesForTest([{ id: 'r1', content: 'reply', ts: null, role: 'assistant' }]);
    assert.equal(__test.getInputOpenForTest(), true, 'input open');
    assert.equal(__test.getRepliesForTest().length, 1, 'reply present alongside open input');
    // Mode reflects input as foreground but loading/response layers can co-exist.
    __test.setInputOpenForTest(false);
    __test.setRepliesForTest([]);
});

test('stop() clears mode, layers, parked, shift-held, gesture lock, and replies', () => {
    __test.setInputOpenForTest(true);
    __test.setRepliesForTest([{ id: 'r1', content: 'x', ts: null, role: 'assistant' }]);
    __test.setPendingForTest({ turnId: 't1', startedAt: Date.now(), attachmentPath: null });
    __test.setShiftHeldForTest(true);
    __test.setParkedForTest(true);
    __test.setGestureLockUntilForTest(Date.now() + 60_000);

    __test.runStopForTest();

    assert.equal(__test.getModeForTest(), 'dot');
    assert.equal(__test.getInputOpenForTest(), false);
    assert.equal(__test.getRepliesForTest().length, 0);
    assert.equal(__test.getShiftHeldForTest(), false);
    assert.equal(__test.getParkedForTest(), false);
    assert.equal(__test.getGestureLockUntilForTest(), 0);
});
