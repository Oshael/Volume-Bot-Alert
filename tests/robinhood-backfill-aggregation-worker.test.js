const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  createRobinhoodBackfillAggregationWorker,
} = require('../src/services/robinhood-backfill-aggregation-worker');

const HOUR = '2026-07-24T12:00:00.000Z';

describe('Robinhood backfill aggregation worker', () => {
  it('paginates fine, hourly and coarse writers before acknowledging the lease', async () => {
    const events = [];
    let finePage = 0;
    const outboxRepository = {
      async claim(options) {
        events.push(['claim', options.owner]);
        return [{ bucketTs: HOUR, targetCount: 7 }];
      },
      async completeHour(input) {
        events.push(['complete', input.bucketTs]);
        return 7;
      },
      async failOwner() {
        assert.fail('successful work must not release the lease as failed');
      },
    };
    const aggregateRepository = {
      async refreshAggregateRange(input) {
        events.push(['aggregate', input.granularities, input.afterToken]);
        if (input.granularities[0] === 5 && finePage++ === 0) {
          return {
            sourceBuckets: 3,
            targetBuckets: 4,
            writtenBuckets: 4,
            tokenCount: 1,
            lastToken: '0x0000000000000000000000000000000000000001',
            hasMoreTokens: true,
          };
        }
        return {
          sourceBuckets: 2,
          targetBuckets: 3,
          writtenBuckets: 3,
          tokenCount: 1,
          lastToken: null,
          hasMoreTokens: false,
        };
      },
      async refreshHourlyRange(input) {
        events.push(['hourly', input.afterToken]);
        return {
          sourceBuckets: 2,
          writtenBuckets: 1,
          tokenCount: 1,
          lastToken: null,
          hasMoreTokens: false,
        };
      },
    };
    const worker = createRobinhoodBackfillAggregationWorker({
      outboxRepository,
      aggregateRepository,
    });

    const result = await worker.runOnce({ owner: 'test-worker', tokenLimit: 2 });

    assert.equal(result.status, 'completed');
    assert.equal(result.claimedTargets, 7);
    assert.equal(result.completedTargets, 7);
    assert.deepEqual(events.map(([event]) => event), [
      'claim', 'aggregate', 'aggregate', 'hourly', 'aggregate', 'complete',
    ]);
    assert.deepEqual(events[1][1], [5, 15, 30]);
    assert.deepEqual(events[4][1], [60, 240, 1440]);
    assert.equal(events[2][2], '0x0000000000000000000000000000000000000001');
  });

  it('releases every uncompleted lease for retry when a writer fails', async () => {
    const failures = [];
    const worker = createRobinhoodBackfillAggregationWorker({
      outboxRepository: {
        async claim() {
          return [{ bucketTs: HOUR, targetCount: 2 }];
        },
        async completeHour() {
          assert.fail('a failed aggregate must not be acknowledged');
        },
        async failOwner(input) {
          failures.push(input);
          return { pending: 2, blocked: 0 };
        },
      },
      aggregateRepository: {
        async refreshAggregateRange() {
          throw new Error('database overloaded');
        },
        async refreshHourlyRange() {
          assert.fail('later phases must not run after failure');
        },
      },
    });

    await assert.rejects(
      worker.runOnce({ owner: 'test-worker', retryDelayMs: 1234, maxAttempts: 4 }),
      /database overloaded/
    );
    assert.equal(failures.length, 1);
    assert.equal(failures[0].owner, 'test-worker');
    assert.equal(failures[0].retryDelayMs, 1234);
    assert.equal(failures[0].maxAttempts, 4);
  });

  it('does not invoke aggregate writers when the outbox is empty', async () => {
    const worker = createRobinhoodBackfillAggregationWorker({
      outboxRepository: {
        async claim() { return []; },
      },
      aggregateRepository: {
        async refreshAggregateRange() { assert.fail('unexpected aggregate write'); },
      },
    });

    assert.deepEqual(await worker.runOnce({ owner: 'test-worker' }), {
      status: 'idle',
      claimedTargets: 0,
      completedTargets: 0,
      hours: [],
    });
  });
});
