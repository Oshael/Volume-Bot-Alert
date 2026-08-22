process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const {
  createRobinhoodFirstBuyBackfillRepository,
} = require('../src/models/robinhood-first-buy-backfill');
const stage151 = require('../src/utils/db-init-stage151');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');
const { assertUsingTestDatabase } = require('./helpers/test-db');

async function cleanup() {
  await db.query('DELETE FROM robinhood_first_buy_backfill_ranges');
  await db.query('DELETE FROM robinhood_first_buy_backfill_runs');
}

describe('Robinhood first-buy backfill control integration', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage151.init({ closePool: false });
    await stage151.init({ closePool: false });
    await cleanup();
  });

  after(async () => {
    await cleanup();
    await db.pool.end();
  });

  it('creates, leases, resumes and completes checkpointed ranges with ETA', async () => {
    const group = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage151-robinhood-first-buy-backfill-control'
    ));
    assert.equal(group.repair, 'node src/utils/db-init-stage151.js');
    const repository = createRobinhoodFirstBuyBackfillRepository({ database: db });
    const run = await repository.createRun({
      sourceFrom: '2026-08-22T00:00:00Z', sourceThrough: '2026-08-22T02:00:00Z',
      rangeSeconds: 3600,
    });
    assert.deepEqual(run, { id: run.id, status: 'planned', rangeCount: 2 });
    await repository.startRun(run.id);
    assert.equal((await repository.getProgress({ runId: run.id })).etaSeconds, null);

    const first = await repository.claimRange({ runId: run.id, owner: 'worker-a', leaseMs: 60_000 });
    const second = await repository.claimRange({ runId: run.id, owner: 'worker-b', leaseMs: 60_000 });
    assert.notEqual(first.id, second.id);
    assert.equal(await repository.claimRange({
      runId: run.id, owner: 'worker-c', leaseMs: 60_000,
    }), null);

    await repository.completeRange({
      runId: run.id, rangeId: first.id, owner: 'worker-a',
      rowsScanned: 20, factsConsidered: 10, factsWritten: 8,
    });
    const halfway = await repository.getProgress({ runId: run.id, concurrency: 2 });
    assert.equal(halfway.progressPct, 50);
    assert.notEqual(halfway.etaSeconds, null);

    await db.query(
      `UPDATE robinhood_first_buy_backfill_ranges
          SET lease_until = NOW() - INTERVAL '1 second' WHERE id = $1`, [second.id]
    );
    assert.equal(await repository.reclaimExpired(run.id), 1);
    const resumed = await repository.claimRange({
      runId: run.id, owner: 'worker-c', leaseMs: 60_000,
    });
    assert.equal(resumed.id, second.id);
    assert.equal(await repository.retryRange({
      runId: run.id, rangeId: resumed.id, owner: 'worker-c', backoffMs: 0,
      error: { code: 'temporary_failure', message: 'retry me' }, maxAttempts: 5,
    }), 'pending');
    const retried = await repository.claimRange({
      runId: run.id, owner: 'worker-c', leaseMs: 60_000,
    });
    await repository.completeRange({
      runId: run.id, rangeId: retried.id, owner: 'worker-c',
      rowsScanned: 10, factsConsidered: 4, factsWritten: 3,
    });
    const complete = await repository.getProgress({ runId: run.id, concurrency: 2 });
    assert.deepEqual({ status: complete.status, progressPct: complete.progressPct,
      rowsScanned: complete.rowsScanned, factsWritten: complete.factsWritten,
      etaSeconds: complete.etaSeconds }, {
      status: 'completed', progressPct: 100, rowsScanned: 30, factsWritten: 11, etaSeconds: 0,
    });
  });
});
