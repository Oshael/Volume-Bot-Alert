const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodHolderJournalPruneWorker,
} = require('../src/services/robinhood-holder-journal-prune-worker');

function scheduler() {
  const scheduled = [];
  const cancelled = [];
  return {
    scheduled, cancelled,
    schedule(callback, delayMs) {
      const timer = { callback, delayMs, unref() {} };
      scheduled.push(timer);
      return timer;
    },
    cancelSchedule(timer) { cancelled.push(timer); },
  };
}

describe('Robinhood holder journal prune worker', () => {
  it('stays opt-in and drains only bounded batches per scheduled tick', async () => {
    const clock = scheduler();
    const calls = [];
    const results = [
      { status: 'draining', deletedEvents: 5, cutoffBlock: '100', journalFloorBlock: '50' },
      { status: 'pruned', deletedEvents: 2, cutoffBlock: '100', journalFloorBlock: '100' },
    ];
    const worker = createRobinhoodHolderJournalPruneWorker({
      ...clock,
      retention: {
        pruneOnce: async (input) => { calls.push(input); return results.shift(); },
      },
    });

    assert.equal(worker.start(), false);
    assert.equal(clock.scheduled.length, 0);
    assert.equal(worker.start({
      enabled: true, intervalMs: 90_000, retentionBlocks: 20_000,
      batchLimit: 5000, maxBatches: 3,
    }), true);
    await clock.scheduled[0].callback();

    assert.deepEqual(calls, [
      { retentionBlocks: 20_000, batchLimit: 5000 },
      { retentionBlocks: 20_000, batchLimit: 5000 },
    ]);
    assert.equal(clock.scheduled[1].delayMs, 90_000);
    assert.deepEqual(worker.getStatus().lastResult, {
      status: 'pruned', batches: 2, deletedEvents: 7, reason: null,
      cutoffBlock: '100', journalFloorBlock: '100', batchBudgetExhausted: false,
    });
    assert.equal(worker.getStatus().totalDeletedEvents, 7);
    await worker.stop();
    assert.equal(clock.cancelled.length, 1);
  });

  it('stops a tick immediately when pending work blocks the cutoff', async () => {
    const calls = [];
    const worker = createRobinhoodHolderJournalPruneWorker({
      retention: { pruneOnce: async () => {
        calls.push('prune');
        return {
          status: 'blocked', reason: 'pending_event_before_cutoff', deletedEvents: 0,
          cutoffBlock: '100', journalFloorBlock: '50',
        };
      } },
    });

    const result = await worker.runOnce();

    assert.equal(calls.length, 1);
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'pending_event_before_cutoff');
    assert.equal(worker.getStatus().totalBlockedRuns, 1);
  });

  it('reports budget exhaustion without starting an unbounded third batch', async () => {
    let calls = 0;
    const worker = createRobinhoodHolderJournalPruneWorker({
      retention: { pruneOnce: async () => {
        calls += 1;
        return {
          status: 'draining', deletedEvents: 5,
          cutoffBlock: '100', journalFloorBlock: '50',
        };
      } },
    });
    worker.start({ enabled: true, maxBatches: 2 });

    const result = await worker.runOnce();

    assert.equal(calls, 2);
    assert.equal(result.deletedEvents, 10);
    assert.equal(result.batchBudgetExhausted, true);
    await worker.stop();
  });

  it('backs off a transient database failure and resumes the normal interval', async () => {
    const clock = scheduler();
    let attempts = 0;
    const worker = createRobinhoodHolderJournalPruneWorker({
      ...clock, logger: { warn() {}, error() {} },
      retention: { pruneOnce: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('temporary database failure');
        return {
          status: 'idle', deletedEvents: 0,
          cutoffBlock: '50', journalFloorBlock: '50',
        };
      } },
    });
    worker.start({ enabled: true, intervalMs: 10_000, maxErrorBackoffMs: 100_000 });

    await clock.scheduled[0].callback();
    assert.equal(clock.scheduled[1].delayMs, 20_000);
    assert.equal(worker.getStatus().halted, false);
    await clock.scheduled[1].callback();
    assert.equal(clock.scheduled[2].delayMs, 10_000);
    assert.equal(worker.getStatus().consecutiveErrors, 0);
    await worker.stop();
  });

  it('halts and propagates an invalid repository contract', async () => {
    const clock = scheduler();
    const fatals = [];
    const worker = createRobinhoodHolderJournalPruneWorker({
      ...clock,
      retention: { pruneOnce: async () => ({ status: 'mystery' }) },
    });
    worker.start({ enabled: true, onFatal: (error) => fatals.push(error) });

    await clock.scheduled[0].callback();

    assert.equal(worker.getStatus().halted, true);
    assert.equal(worker.getStatus().lastError.code, 'holder_journal_prune_contract_error');
    assert.equal(fatals[0].code, 'holder_journal_prune_contract_error');
    assert.equal(clock.scheduled.length, 1);
  });
});
