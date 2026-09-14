const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  createRobinhoodBackfillAggregationWorker,
  __private: { createOutboxRepository },
} = require('../src/services/robinhood-backfill-aggregation-worker');

const HOUR = '2026-07-24T12:00:00.000Z';
const TOKEN = '0x0000000000000000000000000000000000000001';

describe('Robinhood backfill aggregation worker', () => {
  it('resolves only the affected token identities while claiming outbox rows', async () => {
    let query;
    const repository = createOutboxRepository({
      async query(sql, params) {
        query = { sql, params };
        return { rows: [{
          bucket_ts: HOUR, target_count: 2,
          token_addresses: [TOKEN], missing_catalog_targets: 0,
        }] };
      },
    });

    const claimed = await repository.claim({ owner: 'test-worker', leaseMs: 900000, claimLimit: 500 });

    assert.deepEqual(claimed, [{
      bucketTs: HOUR, targetCount: 2,
      tokenAddresses: [TOKEN], missingCatalogTargets: 0,
    }]);
    assert.match(query.sql, /RETURNING target\.bucket_ts, target\.protocol, target\.market_key/);
    assert.match(query.sql, /LEFT JOIN robinhood_pool_registry registry/);
    assert.match(query.sql, /ARRAY_AGG\(DISTINCT registry\.token_address/);
  });

  it('paginates fine, hourly and coarse writers before acknowledging the lease', async () => {
    const events = [];
    let finePage = 0;
    const outboxRepository = {
      async claim(options) {
        events.push(['claim', options.owner]);
        return [{
          bucketTs: HOUR, targetCount: 7, tokenAddresses: [TOKEN], missingCatalogTargets: 0,
        }];
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
        events.push(['aggregate', input.granularities, input.afterToken, input.tokenAddresses]);
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
        events.push(['hourly', input.afterToken, input.tokenAddresses]);
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
    assert.deepEqual(events[1][3], [TOKEN]);
    assert.deepEqual(events[3][2], [TOKEN]);
  });

  it('releases every uncompleted lease for retry when a writer fails', async () => {
    const failures = [];
    const worker = createRobinhoodBackfillAggregationWorker({
      outboxRepository: {
        async claim() {
          return [{
            bucketTs: HOUR, targetCount: 2,
            tokenAddresses: [TOKEN], missingCatalogTargets: 0,
          }];
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

  it('fails the claim closed when an outbox market is absent from the catalog', async () => {
    let failure;
    const worker = createRobinhoodBackfillAggregationWorker({
      outboxRepository: {
        async claim() {
          return [{
            bucketTs: HOUR, targetCount: 1,
            tokenAddresses: [], missingCatalogTargets: 1,
          }];
        },
        async failOwner(input) { failure = input; return { pending: 1, blocked: 0 }; },
      },
      aggregateRepository: {
        async refreshAggregateRange() { assert.fail('unexpected aggregate write'); },
      },
    });

    await assert.rejects(
      worker.runOnce({ owner: 'test-worker' }),
      /missing its pool catalog identity/
    );
    assert.equal(failure.owner, 'test-worker');
  });
});
