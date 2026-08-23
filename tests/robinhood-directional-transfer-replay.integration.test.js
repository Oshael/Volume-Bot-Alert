process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const {
  createRobinhoodDirectionalTransferReplayRepository,
} = require('../src/models/robinhood-directional-transfer-replay');
const stage154 = require('../src/utils/db-init-stage154');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const HASH = `0x${'a'.repeat(64)}`;

async function cleanup() {
  await db.query('DELETE FROM robinhood_directional_transfer_replay_ranges');
  await db.query('DELETE FROM robinhood_directional_transfer_replay_runs');
}

function runInput() {
  return {
    projectionVersion: 'test_directional_v1', sourceFromBlock: '100',
    sourceThroughBlock: '219', sourceThroughHash: HASH, rangeBlocks: 50,
  };
}

async function complete(repository, runId, range, ownerName, stats = {}) {
  await repository.completeRange({
    runId, rangeId: range.id, owner: ownerName,
    completedThroughBlock: range.rangeEndBlock, completedThroughHash: HASH,
    blocksScanned: '50', transfersScanned: '10', edgesConsidered: '5',
    edgesWritten: '4', ...stats,
  });
}

describe('Robinhood directional transfer replay persistence', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage154.init({ closePool: false });
    await cleanup();
  });

  after(async () => {
    await cleanup();
    await db.pool.end();
  });

  it('creates disjoint ranges, resumes leases and completes with progress', async () => {
    const repository = createRobinhoodDirectionalTransferReplayRepository({ database: db });
    const created = await repository.createRun(runInput());
    assert.deepEqual(created, { id: created.id, status: 'planned', rangeCount: 3 });
    assert.deepEqual(await repository.getRun(created.id), {
      id: created.id, status: 'planned', projectionVersion: 'test_directional_v1',
      replayVersion: 'rh_directional_transfer_replay_v1',
      sourceFromBlock: '100', sourceThroughBlock: '219', sourceThroughHash: HASH,
      rangeBlocks: 50, rangeCount: 3,
    });
    await repository.startRun(created.id);
    assert.equal((await repository.getProgress({ runId: created.id })).etaSeconds, null);

    const first = await repository.claimRange({
      runId: created.id, owner: 'worker-a', leaseMs: 60_000,
    });
    const second = await repository.claimRange({
      runId: created.id, owner: 'worker-b', leaseMs: 60_000,
    });
    assert.deepEqual(
      [first.rangeStartBlock, first.rangeEndBlock, second.rangeStartBlock, second.rangeEndBlock],
      ['100', '149', '150', '199']
    );
    await complete(repository, created.id, first, 'worker-a');

    await db.query(
      `UPDATE robinhood_directional_transfer_replay_ranges
          SET lease_until = NOW() - INTERVAL '1 second' WHERE id = $1`, [second.id]
    );
    assert.equal(await repository.reclaimExpired(created.id), 1);
    const resumed = await repository.claimRange({
      runId: created.id, owner: 'worker-c', leaseMs: 60_000,
    });
    assert.equal(resumed.id, second.id);
    assert.equal(await repository.retryRange({
      runId: created.id, rangeId: resumed.id, owner: 'worker-c', backoffMs: 0,
      maxAttempts: 5, error: { code: 'archive_timeout', message: 'retry range' },
    }), 'pending');
    const retried = await repository.claimRange({
      runId: created.id, owner: 'worker-c', leaseMs: 60_000,
    });
    await complete(repository, created.id, retried, 'worker-c');
    const third = await repository.claimRange({
      runId: created.id, owner: 'worker-d', leaseMs: 60_000,
    });
    assert.deepEqual([third.rangeStartBlock, third.rangeEndBlock], ['200', '219']);
    await complete(repository, created.id, third, 'worker-d', { blocksScanned: '20' });

    const progress = await repository.getProgress({ runId: created.id, concurrency: 2 });
    assert.deepEqual({
      status: progress.status, total: progress.total, completed: progress.completed,
      blocksScanned: progress.blocksScanned, transfersScanned: progress.transfersScanned,
      edgesWritten: progress.edgesWritten, progressPct: progress.progressPct,
      etaSeconds: progress.etaSeconds,
    }, {
      status: 'completed', total: 3, completed: 3,
      blocksScanned: '120', transfersScanned: '30', edgesWritten: '12',
      progressPct: 100, etaSeconds: 0,
    });
  });

  it('fails after the attempt budget and resumes only failed ranges', async () => {
    const repository = createRobinhoodDirectionalTransferReplayRepository({ database: db });
    const created = await repository.createRun({
      ...runInput(), sourceFromBlock: '300', sourceThroughBlock: '300',
    });
    await repository.startRun(created.id);
    const range = await repository.claimRange({
      runId: created.id, owner: 'worker-a', leaseMs: 60_000,
    });
    assert.equal(await repository.retryRange({
      runId: created.id, rangeId: range.id, owner: 'worker-a', maxAttempts: 1,
      error: { code: 'archive_failed', message: 'archive failed' },
    }), 'failed');
    assert.equal((await repository.getRun(created.id)).status, 'failed');
    assert.deepEqual(await repository.resumeFailed(created.id), {
      runId: created.id, requeued: 1,
    });
    const resumed = await repository.claimRange({
      runId: created.id, owner: 'worker-b', leaseMs: 60_000,
    });
    assert.equal(resumed.attemptCount, 1);
  });
});
