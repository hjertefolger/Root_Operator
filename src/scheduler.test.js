const { test } = require('node:test');
const assert = require('node:assert/strict');

const { Scheduler } = require('./scheduler');

class MemoryStore {
    constructor(initial = {}) {
        this.data = { ...initial };
    }

    get(key, fallback) {
        return Object.prototype.hasOwnProperty.call(this.data, key)
            ? this.data[key]
            : fallback;
    }

    set(key, value) {
        this.data[key] = value;
    }
}

function createJob(overrides = {}) {
    return {
        id: 'job-1',
        name: 'Night Lab',
        cron: '0 3 * * *',
        prompt: 'Run the nightly build.',
        chatId: null,
        enabled: true,
        createdAt: '2026-04-20T00:00:00.000Z',
        lastRun: null,
        lastResult: null,
        lastError: null,
        lastDurationMs: null,
        consecutiveErrors: 0,
        runningAt: null,
        ...overrides,
    };
}

function createScheduler(jobOverrides = {}, channelManager = { sendToChannel: () => true }) {
    const store = new MemoryStore({
        'scheduler-jobs': [createJob(jobOverrides)],
    });
    const scheduler = new Scheduler(store, channelManager);
    scheduler._startTimer = () => {};
    scheduler._stopTimer = () => {};
    return { store, scheduler };
}

test('runNow sends the scheduled prompt through the channel and marks success', async () => {
    const calls = [];
    const channelManager = {
        sendToChannel: (...args) => {
            calls.push(args);
            return true;
        },
    };
    const { store, scheduler } = createScheduler({}, channelManager);

    const result = await scheduler.runNow('job-1');
    const [job] = store.get('scheduler-jobs');

    assert.equal(result, true);
    assert.deepEqual(calls, [[
        '__scheduler__',
        '[Scheduled: Night Lab]\n\nRun the nightly build.',
        '__scheduler__',
    ]]);
    assert.equal(job.lastResult, 'success');
    assert.equal(job.lastError, null);
    assert.equal(job.runningAt, null);
    assert.equal(job.consecutiveErrors, 0);
    assert.match(job.lastRun, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(typeof job.lastDurationMs, 'number');
});

test('runNow records an error when the bridge is disconnected', async () => {
    const channelManager = { sendToChannel: () => false };
    const { store, scheduler } = createScheduler({}, channelManager);

    await scheduler.runNow('job-1');
    const [job] = store.get('scheduler-jobs');

    assert.equal(job.lastResult, 'error');
    assert.equal(job.lastError, 'Bridge not connected');
    assert.equal(job.runningAt, null);
    assert.equal(job.consecutiveErrors, 1);
});

test('fireJob respects the error backoff window and skips sending', async () => {
    let sendCount = 0;
    const channelManager = {
        sendToChannel: () => {
            sendCount += 1;
            return true;
        },
    };
    const lastRun = new Date().toISOString();
    const { store, scheduler } = createScheduler({
        lastRun,
        consecutiveErrors: 1,
    }, channelManager);
    const [job] = store.get('scheduler-jobs');

    await scheduler._fireJob(job);
    const [storedJob] = store.get('scheduler-jobs');

    assert.equal(sendCount, 0);
    assert.equal(storedJob.lastRun, lastRun);
    assert.equal(storedJob.lastResult, null);
    assert.equal(storedJob.runningAt, null);
    assert.equal(storedJob.consecutiveErrors, 1);
});

test('start clears stale running state before starting enabled jobs', () => {
    const staleRun = new Date(Date.now() - (3 * 60 * 60 * 1000)).toISOString();
    const store = new MemoryStore({
        'scheduler-jobs': [
            createJob({ id: 'enabled-job', runningAt: staleRun }),
            createJob({ id: 'disabled-job', enabled: false, runningAt: staleRun }),
        ],
    });
    const scheduler = new Scheduler(store, { sendToChannel: () => true });
    const started = [];
    scheduler._startTimer = (job) => started.push(job.id);

    scheduler.start();

    const [enabledJob, disabledJob] = store.get('scheduler-jobs');
    assert.deepEqual(started, ['enabled-job']);
    assert.equal(enabledJob.runningAt, null);
    assert.equal(disabledJob.runningAt, null);
});

test('fireJob auto-disables jobs after too many consecutive errors', async () => {
    let sendCount = 0;
    const channelManager = {
        sendToChannel: () => {
            sendCount += 1;
            return true;
        },
    };
    const oldRun = new Date(Date.now() - (2 * 60 * 60 * 1000)).toISOString();
    const { store, scheduler } = createScheduler({
        consecutiveErrors: 10,
        lastRun: oldRun,
    }, channelManager);
    let stopCalls = 0;
    scheduler._stopTimer = () => {
        stopCalls += 1;
    };
    const [job] = store.get('scheduler-jobs');

    await scheduler._fireJob(job);
    const [storedJob] = store.get('scheduler-jobs');

    assert.equal(sendCount, 0);
    assert.equal(stopCalls, 1);
    assert.equal(storedJob.enabled, false);
    assert.equal(storedJob.consecutiveErrors, 10);
});
