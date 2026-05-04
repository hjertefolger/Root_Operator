const { test } = require('node:test');
const assert = require('node:assert/strict');

const cursorCompanion = require('./main/cursor-companion');
const { __test } = cursorCompanion;

// init() requires Electron deps; these tests exercise only pure helpers
// exposed via __test.

function createFakeWindow({ visible = true, focused = false, minimized = false } = {}) {
    const sent = [];
    const ignoreCalls = [];
    const positions = [];
    const focusCalls = [];
    const blurCalls = [];
    const focusableCalls = [];
    let windowPosition = [0, 0];
    return {
        visible,
        focused,
        minimized,
        destroyed: false,
        showInactiveCalls: 0,
        sent,
        ignoreCalls,
        positions,
        focusCalls,
        blurCalls,
        focusableCalls,
        isDestroyed() { return this.destroyed; },
        isFocused() { return this.focused; },
        isVisible() { return this.visible; },
        isMinimized() { return this.minimized; },
        showInactive() {
            this.visible = true;
            this.showInactiveCalls += 1;
        },
        close() { this.destroyed = true; },
        focus() {
            this.focused = true;
            focusCalls.push(Date.now());
        },
        blur() {
            this.focused = false;
            blurCalls.push(Date.now());
        },
        setFocusable(next) {
            focusableCalls.push(Boolean(next));
        },
        setPosition(...args) {
            positions.push(args);
            windowPosition = [args[0], args[1]];
        },
        getPosition() { return windowPosition.slice(); },
        driftTo(x, y) { windowPosition = [x, y]; },
        setIgnoreMouseEvents(...args) { ignoreCalls.push(args); },
        webContents: {
            send(channel, payload) {
                sent.push({ channel, payload });
            },
        },
    };
}

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

test('passive cursor surface releases native keyboard focus', () => {
    const fake = createFakeWindow({ focused: true });
    __test.setWindowForTest(fake);
    __test.setInputOpenForTest(false);
    __test.setNativeWindowFocusableForTest(true);

    const released = __test.releaseKeyboardFocusForTest('test');

    assert.equal(released, true);
    assert.equal(fake.focused, false);
    assert.equal(fake.blurCalls.length, 1);
    assert.deepEqual(fake.focusableCalls, [false]);
});

test('cursor surface does not release focus while input is open', () => {
    const fake = createFakeWindow({ focused: true });
    __test.setWindowForTest(fake);
    __test.setInputOpenForTest(true);
    __test.setNativeWindowFocusableForTest(true);

    const released = __test.releaseKeyboardFocusForTest('test');

    assert.equal(released, false);
    assert.equal(fake.focused, true);
    assert.equal(fake.blurCalls.length, 0);
    assert.deepEqual(fake.focusableCalls, []);
    __test.setInputOpenForTest(false);
});

test('input interactivity makes cursor surface focusable again', () => {
    const fake = createFakeWindow({ focused: false });
    __test.setWindowForTest(fake);
    __test.setInputOpenForTest(true);
    __test.setNativeWindowFocusableForTest(false);

    __test.applyInteractivityForTest();

    assert.deepEqual(fake.focusableCalls, [true]);
    __test.setInputOpenForTest(false);
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

test('renderer draft updates are ignored after input has closed', () => {
    __test.setInputOpenForTest(true);
    __test.setDraftForTest('');
    assert.equal(__test.setDraftPromptFromRendererForTest('half typed'), true);
    assert.equal(__test.getDraftForTest().prompt, 'half typed');

    __test.setInputOpenForTest(false);
    __test.setDraftForTest('');
    assert.equal(__test.setDraftPromptFromRendererForTest('already sent'), false);
    assert.equal(__test.getDraftForTest().prompt, '');
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

test('reply and attachment layers leave left-click passthrough while pointer tap owns wheel/right-click', () => {
    const fakeWindow = createFakeWindow();
    const captureCalls = [];
    const fakeTap = {
        setCapture(next) { captureCalls.push({ ...next }); },
        stop() {},
    };
    __test.setWindowForTest(fakeWindow);
    __test.setPointerGestureTapForTest(fakeTap);
    __test.setInputOpenForTest(false);
    __test.setRepliesForTest([]);
    __test.setPendingAttachmentForTest(null);

    __test.setMousePassthroughForTest(false);
    __test.applyInteractivityForTest();
    assert.equal(__test.getMousePassthroughForTest(), true);
    assert.deepEqual(fakeWindow.ignoreCalls.at(-1), [true, { forward: true }]);

    fakeWindow.ignoreCalls.length = 0;
    __test.setRepliesForTest([{ id: 'r1', content: 'reply', ts: null, role: 'assistant' }]);
    __test.applyInteractivityForTest();
    assert.equal(__test.getMousePassthroughForTest(), true, 'left-click stays with the active app');
    assert.deepEqual(fakeWindow.ignoreCalls, []);
    assert.deepEqual(captureCalls.at(-1), { right: true, wheel: true });

    __test.setRepliesForTest([]);
    __test.setInputOpenForTest(true);
    __test.setInputScrollableForTest(true);
    __test.applyInteractivityForTest();
    assert.deepEqual(captureCalls.at(-1), { right: false, wheel: true });

    __test.setInputScrollableForTest(false);
    __test.applyInteractivityForTest();
    assert.deepEqual(captureCalls.at(-1), { right: false, wheel: false });

    __test.setInputOpenForTest(false);
    fakeWindow.ignoreCalls.length = 0;
    __test.setPendingAttachmentForTest({ name: 'pending.png', size: 1 });
    __test.applyInteractivityForTest();
    assert.equal(__test.getMousePassthroughForTest(), true, 'attachment also does not block left-click');
    assert.deepEqual(fakeWindow.ignoreCalls, []);
    assert.deepEqual(captureCalls.at(-1), { right: true, wheel: false });

    __test.setPendingAttachmentForTest(null);
    __test.applyInteractivityForTest();
    assert.deepEqual(captureCalls.at(-1), { right: false, wheel: false });

    __test.runStopForTest();
});

test('cursor poll keeps the window anchored to the cursor even with interactive layers', () => {
    const fakeWindow = createFakeWindow();
    let point = { x: 240, y: 360 };
    __test.setWindowForTest(fakeWindow);
    __test.setScreenForTest({ getCursorScreenPoint: () => point });
    __test.setInputOpenForTest(true);
    __test.setRepliesForTest([{ id: 'r1', content: 'reply', ts: null, role: 'assistant' }]);
    __test.setPendingAttachmentForTest({ name: 'pending.png', size: 1 });

    __test.updateWindowPositionForTest();
    assert.deepEqual(fakeWindow.positions.at(-1), [
        point.x - __test.ANCHOR_X,
        point.y - __test.ANCHOR_Y,
        false,
    ]);

    point = { x: 480, y: 540 };
    __test.updateWindowPositionForTest();
    assert.deepEqual(fakeWindow.positions.at(-1), [
        point.x - __test.ANCHOR_X,
        point.y - __test.ANCHOR_Y,
        false,
    ]);

    __test.runStopForTest();
});

test('cursor poll reanchors when the native panel drifts without cursor movement', () => {
    const fakeWindow = createFakeWindow();
    const point = { x: 240, y: 360 };
    __test.setWindowForTest(fakeWindow);
    __test.setScreenForTest({ getCursorScreenPoint: () => point });
    __test.setInputOpenForTest(false);
    __test.setRepliesForTest([]);
    __test.setPendingAttachmentForTest(null);

    __test.updateWindowPositionForTest();
    assert.equal(fakeWindow.positions.length, 1);

    fakeWindow.driftTo(900, 700);
    __test.updateWindowPositionForTest();

    assert.equal(fakeWindow.positions.length, 2);
    assert.deepEqual(fakeWindow.positions.at(-1), [
        point.x - __test.ANCHOR_X,
        point.y - __test.ANCHOR_Y,
        false,
    ]);

    __test.runStopForTest();
});

test('reported hit regions do not gate cursor-anchored reply capture', () => {
    const fakeWindow = createFakeWindow();
    let point = { x: 300, y: 420 };
    __test.setWindowForTest(fakeWindow);
    __test.setScreenForTest({ getCursorScreenPoint: () => point });
    __test.setInputOpenForTest(false);
    __test.setRepliesForTest([{ id: 'r1', content: 'reply', ts: null, role: 'assistant' }]);
    __test.setPendingAttachmentForTest(null);
    __test.setMousePassthroughForTest(true);
    __test.setHitRegionsForTest([{
        x: __test.ANCHOR_X + 200,
        y: __test.ANCHOR_Y + 200,
        w: 10,
        h: 10,
    }]);

    __test.updateWindowPositionForTest();
    assert.equal(__test.getMousePassthroughForTest(), true, 'left-click remains passthrough even when reply stack owns gestures');
    assert.deepEqual(__test.getPointerGestureCaptureForTest(), { right: true, wheel: true });

    __test.setRepliesForTest([]);
    __test.updateWindowPositionForTest();
    assert.equal(__test.getMousePassthroughForTest(), true, 'ambient dot releases events to the active app');
    assert.deepEqual(__test.getPointerGestureCaptureForTest(), { right: false, wheel: false });

    __test.runStopForTest();
});

test('pointer tap wheel routes only to the top reply scroller event', () => {
    const fakeWindow = createFakeWindow();
    __test.setWindowForTest(fakeWindow);
    __test.setRepliesForTest([
        { id: 'old', content: 'oldest', ts: null, role: 'assistant' },
        { id: 'new', content: 'newest', ts: null, role: 'assistant' },
    ]);

    __test.handlePointerTapWheelForTest({ deltaY: 48, deltaX: 0 });
    assert.deepEqual(fakeWindow.sent.at(-1), {
        channel: 'CURSOR_WHEEL',
        payload: { deltaX: 0, deltaY: 48, source: 'pointer-tap', target: 'reply' },
    });

    fakeWindow.sent.length = 0;
    __test.setRepliesForTest([]);
    __test.setInputOpenForTest(true);
    __test.setInputScrollableForTest(false);
    __test.handlePointerTapWheelForTest({ deltaY: 48, deltaX: 0 });
    assert.equal(fakeWindow.sent.length, 0, 'wheel is ignored when input does not overflow');

    __test.setInputScrollableForTest(true);
    __test.handlePointerTapWheelForTest({ deltaY: 48, deltaX: 0 });
    assert.deepEqual(fakeWindow.sent.at(-1), {
        channel: 'CURSOR_WHEEL',
        payload: { deltaX: 0, deltaY: 48, source: 'pointer-tap', target: 'input' },
    });

    __test.runStopForTest();
});

test('left click passthrough refocuses the prompt input after the app receives the click', async () => {
    const fakeWindow = createFakeWindow({ focused: false });
    __test.setWindowForTest(fakeWindow);
    __test.setInputOpenForTest(true);
    __test.setRepliesForTest([]);
    __test.setPendingAttachmentForTest(null);

    __test.handleGlobalMouseDownForTest({ button: 1 });
    await new Promise((resolve) => setTimeout(resolve, __test.INPUT_REFOCUS_AFTER_LEFT_CLICK_MS + 15));
    assert.equal(fakeWindow.focusCalls.length, 0, 'left mouse down does not steal focus before mouseup');

    __test.handleGlobalMouseUpForTest({ button: 1 });
    assert.equal(fakeWindow.focusCalls.length, 0, 'refocus is delayed until after the OS click');

    await new Promise((resolve) => setTimeout(resolve, __test.INPUT_REFOCUS_AFTER_LEFT_CLICK_MS + 15));

    assert.equal(fakeWindow.focusCalls.length, 1);
    assert.deepEqual(fakeWindow.sent.at(-1), {
        channel: 'CURSOR_FOCUS_INPUT',
        payload: { reason: 'left-click-passthrough' },
    });

    __test.runStopForTest();
});

test('right-click dismissal peels replies from top to bottom', () => {
    const fakeWindow = createFakeWindow();
    __test.setWindowForTest(fakeWindow);
    __test.setInputOpenForTest(false);
    __test.setPendingAttachmentForTest(null);
    __test.setRepliesForTest([
        { id: 'old', content: 'oldest', ts: null, role: 'assistant' },
        { id: 'mid', content: 'middle', ts: null, role: 'assistant' },
        { id: 'new', content: 'newest', ts: null, role: 'assistant' },
    ]);
    __test.setMousePassthroughForTest(false);

    __test.handleGlobalMouseDownForTest({ button: 2 });
    assert.deepEqual(__test.getRepliesForTest().map((reply) => reply.id), ['old', 'mid']);

    __test.handleGlobalMouseDownForTest({ button: 2 });
    assert.deepEqual(__test.getRepliesForTest().map((reply) => reply.id), ['old']);

    __test.handleGlobalMouseDownForTest({ button: 2 });
    assert.deepEqual(__test.getRepliesForTest().map((reply) => reply.id), []);
    assert.equal(__test.getMousePassthroughForTest(), true, 'last dismissal releases clicks to the active app');

    __test.runStopForTest();
});

test('desktop/mobile replies skip cursor stack while desktop chat is open', () => {
    const fakeWindow = createFakeWindow();
    __test.setWindowForTest(fakeWindow);
    __test.setLocalChatWindowForTest(createFakeWindow({ visible: true, focused: true }));
    __test.setInputOpenForTest(false);
    __test.setRepliesForTest([]);
    __test.clearTerminalGraceForTest();
    const cursorBaseline = __test.getCursorReplySequenceForTest();
    __test.setPendingForTest({
        turnId: 'cursor-turn',
        startedAt: Date.now(),
        attachmentPath: null,
        cursorReplySequenceAtSubmit: cursorBaseline,
    });

    __test.handleChannelActivityForTest({ phase: 'finished' });
    assert.equal(__test.getTerminalGraceActiveForTest(), true, 'cursor turn is waiting in grace');

    const handled = __test.handleChannelReplyForTest({
        content: 'reply from desktop chat',
        ts: '2026-04-29T10:00:00Z',
        role: 'assistant',
        chatId: 'desktop-chat',
    });

    assert.equal(handled, false);
    assert.equal(__test.getRepliesForTest().length, 0);
    assert.equal(__test.getPendingForTest()?.turnId, 'cursor-turn');
    assert.equal(__test.getTerminalGraceActiveForTest(), true, 'external reply does not cancel cursor grace');
    assert.equal(__test.getCursorReplySequenceForTest(), cursorBaseline);

    __test.runStopForTest();
    __test.setLocalChatWindowForTest(null);
});

test('cursor replies also skip cursor stack while desktop chat is open but still complete the pending turn', () => {
    const fakeWindow = createFakeWindow();
    __test.setWindowForTest(fakeWindow);
    __test.setLocalChatWindowForTest(createFakeWindow({ visible: true, focused: true }));
    __test.setInputOpenForTest(false);
    __test.setRepliesForTest([]);
    __test.clearTerminalGraceForTest();
    const cursorBaseline = __test.getCursorReplySequenceForTest();
    __test.setPendingForTest({
        turnId: 'cursor-turn',
        startedAt: Date.now(),
        attachmentPath: null,
        cursorReplySequenceAtSubmit: cursorBaseline,
    });

    __test.handleChannelActivityForTest({ phase: 'finished' });
    assert.equal(__test.getTerminalGraceActiveForTest(), true);

    const handled = __test.handleChannelReplyForTest({
        content: 'reply from cursor turn',
        ts: '2026-04-29T10:00:01Z',
        role: 'assistant',
        chatId: 'cursor-companion',
    });

    assert.equal(handled, false);
    assert.equal(__test.getRepliesForTest().length, 0);
    assert.equal(__test.getPendingForTest(), null);
    assert.equal(__test.getTerminalGraceActiveForTest(), false);
    assert.equal(__test.getCursorReplySequenceForTest(), cursorBaseline + 1);
    assert.equal(fakeWindow.sent.at(-1).payload.event, 'reply_suppressed_desktop_chat');

    __test.runStopForTest();
    __test.setLocalChatWindowForTest(null);
});

test('desktop/mobile replies append to cursor stack while desktop chat is hidden or minimized', () => {
    const fakeWindow = createFakeWindow();
    const desktopWindow = createFakeWindow({ visible: false, focused: false, minimized: false });
    __test.setWindowForTest(fakeWindow);
    __test.setLocalChatWindowForTest(desktopWindow);
    __test.setRepliesForTest([]);

    const handled = __test.handleChannelReplyForTest({
        content: 'reply while desktop chat is hidden',
        ts: '2026-04-29T10:00:00Z',
        role: 'assistant',
        chatId: 'desktop-chat',
    });

    assert.equal(handled, true);
    assert.equal(__test.getRepliesForTest().at(-1).content, 'reply while desktop chat is hidden');

    desktopWindow.visible = true;
    desktopWindow.minimized = true;
    assert.equal(__test.handleChannelReplyForTest({
        content: 'reply while desktop chat is minimized',
        ts: '2026-04-29T10:00:01Z',
        role: 'assistant',
        chatId: 'desktop-chat',
    }), true);
    assert.equal(__test.getRepliesForTest().at(-1).content, 'reply while desktop chat is minimized');

    desktopWindow.minimized = false;
    assert.equal(__test.handleChannelReplyForTest({
        content: 'reply once desktop chat is open',
        ts: '2026-04-29T10:00:02Z',
        role: 'assistant',
        chatId: 'desktop-chat',
    }), false);
    assert.notEqual(__test.getRepliesForTest().at(-1).content, 'reply once desktop chat is open');

    __test.runStopForTest();
    __test.setLocalChatWindowForTest(null);
});

test('global channel activity drives cursor loader even without cursor pending turn', () => {
    const fakeWindow = createFakeWindow();
    __test.setWindowForTest(fakeWindow);
    __test.setInputOpenForTest(false);
    __test.setRepliesForTest([]);
    __test.setPendingForTest(null);
    __test.setChannelActiveForTest(false);

    __test.handleChannelActivityForTest({
        phase: 'tool',
        active: true,
        label: 'Operator is editing',
    });
    assert.equal(__test.getChannelActiveForTest(), true);
    assert.equal(__test.getModeForTest(), 'loading');

    __test.handleChannelActivityForTest({
        phase: 'tool_complete',
        active: false,
        label: 'Operator finished editing',
    });
    assert.equal(__test.getChannelActiveForTest(), true, 'non-terminal activity keeps loader in sync with pending desktop work');

    __test.handleChannelActivityForTest({ phase: 'idle', active: false });
    assert.equal(__test.getChannelActiveForTest(), false);
    assert.equal(__test.getModeForTest(), 'dot');

    __test.runStopForTest();
});

test('cursor replies still cancel terminal grace and complete the cursor pending turn', () => {
    const fakeWindow = createFakeWindow();
    const desktopWindow = createFakeWindow({ visible: false, focused: false, minimized: false });
    __test.setWindowForTest(fakeWindow);
    __test.setLocalChatWindowForTest(desktopWindow);
    __test.setInputOpenForTest(false);
    __test.setRepliesForTest([]);
    __test.clearTerminalGraceForTest();
    const cursorBaseline = __test.getCursorReplySequenceForTest();
    __test.setPendingForTest({
        turnId: 'cursor-turn',
        startedAt: Date.now(),
        attachmentPath: null,
        cursorReplySequenceAtSubmit: cursorBaseline,
    });

    __test.handleChannelActivityForTest({ phase: 'finished' });
    assert.equal(__test.getTerminalGraceActiveForTest(), true);

    const handled = __test.handleChannelReplyForTest({
        content: 'reply from cursor turn',
        ts: '2026-04-29T10:00:01Z',
        role: 'assistant',
        chatId: 'cursor-companion',
    });

    assert.equal(handled, true);
    assert.equal(__test.getPendingForTest(), null);
    assert.equal(__test.getTerminalGraceActiveForTest(), false);
    assert.equal(__test.getCursorReplySequenceForTest(), cursorBaseline + 1);

    __test.runStopForTest();
    __test.setLocalChatWindowForTest(null);
});

test('hide restoration retries show a hidden cursor window', async () => {
    const fakeWindow = createFakeWindow({ visible: false });
    __test.setWindowForTest(fakeWindow);

    __test.scheduleCursorVisibilityRestoreForTest('test-hide');
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(fakeWindow.visible, true);
    assert.ok(fakeWindow.showInactiveCalls >= 1);

    __test.runStopForTest();
});

test('stop() clears mode, layers, channel activity, shift-held, gesture lock, and replies', () => {
    __test.setInputOpenForTest(true);
    __test.setRepliesForTest([{ id: 'r1', content: 'x', ts: null, role: 'assistant' }]);
    __test.setPendingForTest({ turnId: 't1', startedAt: Date.now(), attachmentPath: null });
    __test.setChannelActiveForTest(true);
    __test.setShiftHeldForTest(true);
    __test.setGestureLockUntilForTest(Date.now() + 60_000);

    __test.runStopForTest();

    assert.equal(__test.getModeForTest(), 'dot');
    assert.equal(__test.getInputOpenForTest(), false);
    assert.equal(__test.getRepliesForTest().length, 0);
    assert.equal(__test.getChannelActiveForTest(), false);
    assert.equal(__test.getShiftHeldForTest(), false);
    assert.equal(__test.getGestureLockUntilForTest(), 0);
});
