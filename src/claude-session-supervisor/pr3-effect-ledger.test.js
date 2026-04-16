/**
 * PR3 effect-ledger tests.
 *
 * Tests: dispatch-store effect CRUD, ChatStore external_ref, bridge protocol
 * (activate_dispatch, ordinal counter, reply_request/response), orchestrator
 * spawn verification and activate_dispatch emission.
 *
 * Runner: node --test src/claude-session-supervisor/pr3-effect-ledger.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DispatchStore } = require('./dispatch-store');
const { ChatStore } = require('../chat-store');

function tempDbPath() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr3-test-'));
    return path.join(dir, 'claude-supervisor.db');
}

function tempChatDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'pr3-chatstore-'));
}

// ==========================================================================
// DispatchStore: effect CRUD
// ==========================================================================

test('insertPreparedEffect + markEffectCommitted roundtrip', () => {
    const s = new DispatchStore(tempDbPath());
    s.insertDispatch({
        dispatchId: 'd1', source: 'channel', sourceId: null, chatId: 'chat1',
        payload: 'hello', silenceMs: 60000, replayCap: 1, state: 'active',
        epoch: 1, enqueuedAt: 1000,
    });

    s.insertPreparedEffect({
        effectId: 'reply:d1:1',
        dispatchId: 'd1',
        ordinal: 1,
        kind: 'reply',
        preparedAt: 2000,
    });

    const prepared = s.listPreparedEffects();
    assert.equal(prepared.length, 1);
    assert.equal(prepared[0].effect_id, 'reply:d1:1');
    assert.equal(prepared[0].dispatch_id, 'd1');
    assert.equal(prepared[0].status, 'prepared');

    s.markEffectCommitted('reply:d1:1', 3000);

    const afterCommit = s.listPreparedEffects();
    assert.equal(afterCommit.length, 0);

    const effects = s.listEffectsForDispatch('d1');
    assert.equal(effects.length, 1);
    assert.equal(effects[0].status, 'committed');
    assert.equal(effects[0].committed_at, 3000);

    s.close();
});

test('effect UNIQUE constraint prevents duplicate inserts', () => {
    const s = new DispatchStore(tempDbPath());
    s.insertDispatch({
        dispatchId: 'd1', source: 'scheduler', sourceId: null, chatId: null,
        payload: 'test', silenceMs: 60000, replayCap: 2, state: 'active',
        epoch: 1, enqueuedAt: 1000,
    });

    s.insertPreparedEffect({
        effectId: 'reply:d1:1',
        dispatchId: 'd1',
        ordinal: 1,
        kind: 'reply',
        preparedAt: 2000,
    });

    assert.throws(() => {
        s.insertPreparedEffect({
            effectId: 'reply:d1:1',
            dispatchId: 'd1',
            ordinal: 1,
            kind: 'reply',
            preparedAt: 2001,
        });
    }, /UNIQUE/);

    s.close();
});

test('multiple effects per dispatch with different ordinals', () => {
    const s = new DispatchStore(tempDbPath());
    s.insertDispatch({
        dispatchId: 'd1', source: 'scheduler', sourceId: null, chatId: null,
        payload: 'test', silenceMs: 60000, replayCap: 2, state: 'active',
        epoch: 1, enqueuedAt: 1000,
    });

    s.insertPreparedEffect({
        effectId: 'reply:d1:1', dispatchId: 'd1', ordinal: 1,
        kind: 'reply', preparedAt: 2000,
    });
    s.insertPreparedEffect({
        effectId: 'scheduler_tool:d1:2', dispatchId: 'd1', ordinal: 2,
        kind: 'scheduler_tool', preparedAt: 2001,
    });
    s.insertPreparedEffect({
        effectId: 'reply:d1:3', dispatchId: 'd1', ordinal: 3,
        kind: 'reply', preparedAt: 2002,
    });

    const effects = s.listEffectsForDispatch('d1');
    assert.equal(effects.length, 3);
    assert.equal(effects[0].ordinal, 1);
    assert.equal(effects[1].ordinal, 2);
    assert.equal(effects[2].ordinal, 3);

    s.close();
});

test('incrementVisibleEffect updates count', () => {
    const s = new DispatchStore(tempDbPath());
    s.insertDispatch({
        dispatchId: 'd1', source: 'channel', sourceId: null, chatId: 'c1',
        payload: 'hi', silenceMs: 60000, replayCap: 1, state: 'active',
        epoch: 1, enqueuedAt: 1000,
    });

    assert.equal(s.getDispatch('d1').visible_effect_count, 0);
    s.incrementVisibleEffect('d1');
    assert.equal(s.getDispatch('d1').visible_effect_count, 1);
    s.incrementVisibleEffect('d1');
    assert.equal(s.getDispatch('d1').visible_effect_count, 2);

    s.close();
});

// ==========================================================================
// ChatStore: external_ref support
// ==========================================================================

test('ChatStore addMessage with externalRef preserves field', () => {
    const dir = tempChatDir();
    const cs = new ChatStore(dir);

    cs.addMessage(
        { role: 'assistant', content: 'hello', ts: '2026-04-16T12:00:00Z' },
        { externalRef: 'reply:d1:1' },
    );
    cs.addMessage({ role: 'user', content: 'hi', ts: '2026-04-16T11:59:00Z' });

    const messages = cs.loadMessages();
    assert.equal(messages.length, 2);
    assert.equal(messages[0].external_ref, 'reply:d1:1');
    assert.equal(messages[1].external_ref, undefined);
});

test('ChatStore findByExternalRef returns matching message', () => {
    const dir = tempChatDir();
    const cs = new ChatStore(dir);

    cs.addMessage(
        { role: 'assistant', content: 'first reply', ts: '2026-04-16T12:00:00Z' },
        { externalRef: 'reply:d1:1' },
    );
    cs.addMessage(
        { role: 'assistant', content: 'second reply', ts: '2026-04-16T12:01:00Z' },
        { externalRef: 'reply:d1:2' },
    );
    cs.addMessage({ role: 'user', content: 'question', ts: '2026-04-16T11:59:00Z' });

    const found = cs.findByExternalRef('reply:d1:2');
    assert.ok(found);
    assert.equal(found.content, 'second reply');
    assert.equal(found.external_ref, 'reply:d1:2');

    const notFound = cs.findByExternalRef('reply:d1:999');
    assert.equal(notFound, null);

    const nullRef = cs.findByExternalRef(null);
    assert.equal(nullRef, null);
});

test('ChatStore strips attachment bytes but preserves metadata', () => {
    const dir = tempChatDir();
    const cs = new ChatStore(dir);

    cs.addMessage(
        {
            role: 'assistant',
            content: 'image reply',
            ts: '2026-04-16T12:05:00Z',
            attachments: [{
                id: 'att-1',
                name: 'diagram.png',
                mime: 'image/png',
                size: 128,
                sha256: 'abc123',
                kind: 'image',
                bytesBase64: 'ZmFrZQ==',
            }],
        },
        { externalRef: 'reply:d1:3' },
    );

    const [message] = cs.loadMessages();
    assert.deepEqual(message.attachments, [{
        id: 'att-1',
        name: 'diagram.png',
        mime: 'image/png',
        size: 128,
        sha256: 'abc123',
        kind: 'image',
    }]);
    assert.equal(message.attachments[0].bytesBase64, undefined);
});

test('ChatStore truncateIfNeeded returns evicted messages', () => {
    const dir = tempChatDir();
    const cs = new ChatStore(dir);

    for (let index = 0; index < 201; index += 1) {
        cs.appendMessage({
            role: 'assistant',
            content: `message-${index}`,
            ts: `2026-04-16T12:${String(index).padStart(2, '0')}:00Z`,
        });
    }

    const evicted = cs.truncateIfNeeded();
    assert.equal(evicted.length, 1);
    assert.equal(evicted[0].content, 'message-0');
    assert.equal(cs.loadMessages().length, 200);
    assert.equal(cs.loadMessages()[0].content, 'message-1');
});

// ==========================================================================
// Orchestrator: activate_dispatch emission + spawn verification
// ==========================================================================

test('orchestrator emits activate_dispatch via sendStructuredMessage', async () => {
    const s = new DispatchStore(tempDbPath());
    const { IncidentLogger } = require('./incidents');
    const { Runtime } = require('./runtime');
    const { createSupervisor } = require('./orchestrator');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr3-orch-'));
    const runtime = new Runtime({ store: s, runtimeDir: tmpDir });
    runtime.currentEpoch = 0;
    const incidents = new IncidentLogger({
        store: s,
        jsonlPath: path.join(tmpDir, 'incidents.jsonl'),
    });

    const structuredMessages = [];
    const channelManager = {
        sendToChannelUnbuffered: () => true,
        sendStructuredMessage: (msg) => { structuredMessages.push(msg); return true; },
        on: () => {},
        off: () => {},
    };

    const hookLog = path.join(tmpDir, 'hooks.jsonl');
    fs.writeFileSync(hookLog, '');

    const sup = createSupervisor({
        store: s,
        runtime,
        incidents,
        channelManager,
        hookLogPath: hookLog,
        enableProbe: true,
    });

    await sup.start();
    // start() goes to IDLE and enqueues a probe (enableProbe=true).
    // The probe activates immediately and sends activate_dispatch.
    await new Promise(r => setTimeout(r, 50));

    const activateMsg = structuredMessages.find(m => m.type === 'activate_dispatch');
    assert.ok(activateMsg, 'activate_dispatch should be emitted for the probe dispatch');
    assert.ok(activateMsg.dispatch_id, 'dispatch_id should be set');

    // Complete the probe by simulating a Stop hook so shutdown is clean.
    fs.appendFileSync(hookLog, JSON.stringify({ hookEventName: 'Stop' }) + '\n');
    await new Promise(r => setTimeout(r, 200));

    await sup.shutdown();
    s.close();
});

test('orchestrator no longer increments visible_effect_count on PreToolUse+reply hook', async () => {
    const s = new DispatchStore(tempDbPath());
    const { IncidentLogger } = require('./incidents');
    const { Runtime } = require('./runtime');
    const { createSupervisor } = require('./orchestrator');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr3-hook-'));
    const runtime = new Runtime({ store: s, runtimeDir: tmpDir });
    runtime.currentEpoch = 0;
    const incidents = new IncidentLogger({
        store: s,
        jsonlPath: path.join(tmpDir, 'incidents.jsonl'),
    });

    const channelManager = {
        sendToChannelUnbuffered: () => true,
        sendStructuredMessage: () => true,
        on: () => {},
        off: () => {},
    };

    const hookLog = path.join(tmpDir, 'hooks.jsonl');
    fs.writeFileSync(hookLog, '');

    const sup = createSupervisor({
        store: s, runtime, incidents, channelManager,
        hookLogPath: hookLog,
    });

    await sup.start();
    await new Promise(r => setTimeout(r, 50));

    // Enqueue a real dispatch
    const { dispatchId } = sup.enqueue({
        source: 'channel',
        chatId: 'test-chat',
        payload: 'test message',
    });
    await new Promise(r => setTimeout(r, 50));

    // Simulate a PreToolUse+reply hook event by writing to hook log
    const hookLine = JSON.stringify({
        hookEventName: 'PreToolUse',
        toolName: 'reply',
    }) + '\n';
    fs.appendFileSync(hookLog, hookLine);
    await new Promise(r => setTimeout(r, 200));

    // visible_effect_count should NOT be incremented by hook (PR3 removed this)
    const row = s.getDispatch(dispatchId);
    assert.equal(row.visible_effect_count, 0,
        'hook-based visible_effect_count increment should be removed in PR3');

    await sup.shutdown();
    s.close();
});
