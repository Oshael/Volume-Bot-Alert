'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { parseArgs, queryFamily, summarize, run } = require(
  '../src/utils/diagnose-robinhood-deployment-delay'
);

function sample(at, overrides = {}) {
  return {
    at, deployment: null, activity: { families: {}, waits: {}, longest: [],
      idleInTransaction: 0, truncated: false }, mints: null, errors: [], ...overrides,
  };
}

function lease(at, poolAt, waiting, counters = {}, owner = 'same') {
  return {
    owner_id: owner, acquired_at: '2026-09-25T09:00:00.000Z', heartbeat_at: at,
    telemetry: { databasePool: { sampledAt: poolAt, waiting, phase: 'process' },
      firstAttemptQueueWaitSamples: 10, firstAttemptQueueWaitTotalMs: 20_000,
      firstAttemptHeadBeyondLookback: 2, firstAttemptLiveResolved: 8,
      firstAttemptArchiveResolved: 1, ...counters },
  };
}

describe('Robinhood deployment delay diagnostic', () => {
  it('bounds the sampling window and rejects unknown arguments', () => {
    assert.deepEqual(parseArgs(['--duration=2m', '--interval=3s']), {
      durationMs: 120_000, intervalMs: 3000,
    });
    assert.throws(() => parseArgs(['--duration=20s']), /between 30s and 30m/);
    assert.throws(() => parseArgs(['--interval=11s']), /between 1s and 10s/);
    assert.throws(() => parseArgs(['--output=x']), /invalid or repeated argument/);
  });

  it('distinguishes evidence queries from redistribution claims and other first buys', () => {
    assert.equal(queryFamily({ query: 'FROM robinhood_wallet_token_first_buys b '
      + 'JOIN robinhood_wallet_transfer_edges e' }), 'redistribution_evidence');
    assert.equal(queryFamily({ query: 'SELECT buy.wallet_address AS source_wallet, '
      + 'buy.block_number AS buy_block' }), 'redistribution_evidence');
    assert.equal(queryFamily({ query: 'FROM robinhood_wallet_token_first_buys b' }),
      'first_buy_other_or_truncated');
    assert.equal(queryFamily({ query: 'UPDATE robinhood_bundle_redistribution_queue' }),
      'redistribution_queue');
  });

  it('uses window deltas and only fresh, distinct pool samples for coincidence', () => {
    const firstAt = '2026-09-25T09:00:02.000Z';
    const secondAt = '2026-09-25T09:00:04.000Z';
    const samples = [
      sample(firstAt, {
        deployment: lease(firstAt, '2026-09-25T09:00:01.000Z', 4),
        redistribution: { owner_id: 'same', acquired_at: firstAt,
          telemetry: { totalClaimed: 100, totalDeferred: 20 } },
        activity: { families: { redistribution_evidence: 2 }, waits: { IO: 1 },
          longest: [], idleInTransaction: 1, truncated: false },
        mints: { unattempted: 3, due: 2, beyond_96: 1,
          max_distance_blocks: 120, max_queue_age_s: 15 },
      }),
      sample(secondAt, {
        deployment: lease(secondAt, '2026-09-25T09:00:03.000Z', 6, {
          firstAttemptQueueWaitSamples: 12, firstAttemptQueueWaitTotalMs: 26_000,
          firstAttemptHeadBeyondLookback: 3, firstAttemptLiveResolved: 9,
          databasePoolPeakWaitingSample: { sampledAt: secondAt, waiting: 9 },
        }),
        redistribution: { owner_id: 'same', acquired_at: firstAt,
          telemetry: { totalClaimed: 106, totalDeferred: 22 } },
        activity: { families: { other: 3 }, waits: {}, longest: [],
          idleInTransaction: 0, truncated: false },
      }),
      sample('2026-09-25T09:00:06.000Z', {
        deployment: lease(secondAt, '2026-09-25T09:00:03.000Z', 6, {
          firstAttemptQueueWaitSamples: 12, firstAttemptQueueWaitTotalMs: 26_000,
          firstAttemptHeadBeyondLookback: 3, firstAttemptLiveResolved: 9,
        }),
      }),
    ];
    const report = summarize(samples, { durationMs: 10_000, intervalMs: 2000 });
    assert.equal(report.worker.firstAttempts, 2);
    assert.equal(report.worker.meanFirstAttemptQueueWaitMs, 3000);
    assert.equal(report.worker.firstAttemptsBeyond96, 1);
    assert.equal(report.redistribution.sameProcessAsDeployment, true);
    assert.equal(report.redistribution.claimed, 6);
    assert.equal(report.redistribution.deferred, 2);
    assert.equal(report.pool.freshSamples, 2);
    assert.equal(report.pool.maxWaiting, 9);
    assert.equal(report.pool.recordedPeakEvents, 1);
    assert.equal(report.pool.waitingWithRedistribution, 1);
    assert.equal(report.pool.waitingWithoutRedistribution, 1);
    assert.equal(report.mint.maxBeyond96, 1);
    assert.equal(report.activity.maxIdleInTransaction, 1);
  });

  it('summarizes the connections occupying the pool at a recorded queue peak', () => {
    const at = '2026-09-25T09:24:05.781Z';
    const holders = [{ pid: 101, heldMs: 48000, origin: 'query redistribution',
      activeSql: 'SELECT buy.wallet_address AS source_wallet' },
    { pid: 102, heldMs: 3000, origin: 'getClient models/other.js:12', activeSql: null }];
    const report = summarize([sample('2026-09-25T09:24:05.000Z'),
      sample('2026-09-25T09:24:06.000Z', {
        deployment: lease(at, at, 18, {
          databasePoolPeakWaitingSample: { sampledAt: at, waiting: 18, busy: 10,
            unattributedBusy: 8, holders },
        }),
      })], { durationMs: 1000, intervalMs: 2000 });
    assert.equal(report.pool.holderSnapshots, 1);
    assert.equal(report.pool.maxUnattributedBusy, 8);
    assert.equal(report.pool.peakHolders.holders.length, 2);
    assert.equal(report.pool.holderOperations['SELECT buy.wallet_address AS source_wallet']
      .maxHeldMs, 48000);
  });

  it('does not compute deltas when the worker lease changes during the window', () => {
    const firstAt = '2026-09-25T09:00:02.000Z';
    const samples = [
      sample(firstAt, { deployment: lease(firstAt, firstAt, 0) }),
      sample('2026-09-25T09:00:04.000Z', {
        deployment: lease(firstAt, firstAt, 0, {}, 'restarted'),
      }),
    ];
    const report = summarize(samples, { durationMs: 10_000, intervalMs: 2000 });
    assert.equal(report.worker.sameLease, false);
    assert.equal(report.worker.firstAttempts, null);
    assert.equal(report.worker.meanFirstAttemptQueueWaitMs, null);
  });

  it('collects with a read-only session and closes its dedicated client', async () => {
    const statements = [];
    let stopping = false;
    let released = false;
    const client = { async query(sql) {
      statements.push(sql);
      if (sql.includes('FROM worker_leases')) return { rows: [] };
      if (sql.includes('FROM pg_stat_activity')) return { rows: [] };
      if (sql.includes('FROM head CROSS JOIN')) {
        stopping = true;
        return { rows: [{ unattempted: 0, due: 0, beyond_96: 0 }] };
      }
      return { rows: [] };
    }, release() { released = true; } };
    const report = await run({ durationMs: 30_000, intervalMs: 2000 }, {
      database: { getClient: async () => client }, now: () => 0,
      shouldStop: () => stopping, sleep: async () => {},
    });
    assert.equal(report.window.samples, 1);
    assert.equal(report.mint.samples, 1);
    assert.equal(released, true);
    assert.ok(statements.indexOf('SET default_transaction_read_only = on')
      < statements.findIndex((sql) => sql.includes('FROM worker_leases')));
    assert.ok(statements.every((sql) => !/^\s*(UPDATE|DELETE|INSERT)\b/i.test(sql)));
  });
});
