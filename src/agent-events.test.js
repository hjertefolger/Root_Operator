const { test } = require('node:test');
const assert = require('node:assert/strict');

const { init } = require('./main/agent-events');

function makeDeps(overrides = {}) {
    return {
        // Explicit null helperPath bypasses the resolver entirely so
        // tests never accidentally spawn the real ax-helper.
        helperPath: null,
        bufferSize: 5,
        logDebug: () => {},
        ...overrides,
    };
}

test('init throws without deps', () => {
    assert.throws(() => init());
});

test('start with missing helper records subscribe_helper_missing event and does not crash', () => {
    const events = init(makeDeps());
    events.start();
    const ring = events.__ringForTest();
    assert.equal(ring.length, 1);
    assert.equal(ring[0].event, 'subscribe_helper_missing');
    events.stop();
});

test('ring buffer enforces bufferSize cap (5)', () => {
    const events = init(makeDeps({ bufferSize: 3 }));
    for (let i = 0; i < 10; i++) {
        events.__pushForTest({ event: 'tick', n: i, ts: i });
    }
    const ring = events.__ringForTest();
    assert.equal(ring.length, 3);
    assert.equal(ring[0].n, 7);
    assert.equal(ring[2].n, 9);
});

test('consumeLine parses valid JSON and ignores garbage', () => {
    const events = init(makeDeps());
    events.__consumeLineForTest('{"event":"app_activated","ts":1234,"app":"Notes"}');
    events.__consumeLineForTest('not json');
    events.__consumeLineForTest('   ');
    events.__consumeLineForTest('{"event":"selected_text_changed","ts":1235}');

    const ring = events.__ringForTest();
    assert.equal(ring.length, 2);
    assert.equal(ring[0].event, 'app_activated');
    assert.equal(ring[1].event, 'selected_text_changed');
});

test('getEvents respects count filter (last N)', () => {
    const events = init(makeDeps({ bufferSize: 10 }));
    for (let i = 0; i < 6; i++) {
        events.__pushForTest({ event: 'e', n: i, ts: i });
    }
    const last3 = events.getEvents({ count: 3 });
    assert.equal(last3.length, 3);
    assert.equal(last3[0].n, 3);
    assert.equal(last3[2].n, 5);
});

test('getEvents respects since_ms filter', () => {
    const events = init(makeDeps({ bufferSize: 10 }));
    const now = Date.now() / 1000;
    events.__pushForTest({ event: 'old', ts: now - 60 });   // 60s ago
    events.__pushForTest({ event: 'recent', ts: now - 1 }); // 1s ago
    events.__pushForTest({ event: 'newer', ts: now });

    const recent = events.getEvents({ since_ms: 5000 });
    const eventsKinds = recent.map((e) => e.event);
    assert.deepEqual(eventsKinds, ['recent', 'newer']);
});

test('stop is idempotent', () => {
    const events = init(makeDeps());
    events.stop();
    events.stop();
    // No assertion needed beyond not throwing.
    assert.ok(true);
});
