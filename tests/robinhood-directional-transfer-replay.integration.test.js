process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const {
  createRobinhoodDirectionalTransferReplayRepository,
} = require('../src/models/robinhood-directional-transfer-replay');
const stage116 = require('../src/utils/db-init-stage116');
const stage129 = require('../src/utils/db-init-stage129');
const stage134 = require('../src/utils/db-init-stage134');
const stage110 = require('../src/utils/db-init-stage110');
const stage113 = require('../src/utils/db-init-stage113');
const stage114 = require('../src/utils/db-init-stage114');
const stage154 = require('../src/utils/db-init-stage154');
const stage158 = require('../src/utils/db-init-stage158');
const stage159 = require('../src/utils/db-init-stage159');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const HASH = `0x${'a'.repeat(64)}`;
const COVERAGE_HASH = `0x${'b'.repeat(64)}`;
const TOKEN = `0x${'d'.repeat(40)}`;
const ATTRIBUTED_TOKEN = `0x${'c'.repeat(40)}`;
const REPAIR_TOKEN = `0x${'e'.repeat(40)}`;
const UNKNOWN_DEPLOYMENT_TOKEN = `0x${'f'.repeat(40)}`;

async function cleanup() {
  await db.query('DELETE FROM robinhood_directional_transfer_replay_tokens');
  await db.query('DELETE FROM robinhood_directional_transfer_replay_ranges');
  await db.query('DELETE FROM robinhood_directional_transfer_replay_runs');
  await db.query('DELETE FROM robinhood_wallet_transfer_token_coverage');
  await db.query(
    'DELETE FROM robinhood_token_attributions WHERE token_address = ANY($1::varchar[])',
    [[ATTRIBUTED_TOKEN, REPAIR_TOKEN, UNKNOWN_DEPLOYMENT_TOKEN]]
  );
  await db.query(
    "DELETE FROM robinhood_wallet_transfer_cursors WHERE projection_version = 'test_directional_v1'"
  );
  await db.query('DELETE FROM robinhood_holder_token_states');
}

async function deleteRun(runId) {
  await db.query('DELETE FROM robinhood_directional_transfer_replay_tokens WHERE run_id = $1', [runId]);
  await db.query('DELETE FROM robinhood_directional_transfer_replay_ranges WHERE run_id = $1', [runId]);
  await db.query('DELETE FROM robinhood_directional_transfer_replay_runs WHERE id = $1', [runId]);
}

function runInput() {
  return {
    projectionVersion: 'test_directional_v1', sourceFromBlock: '100',
    sourceThroughBlock: '219', sourceThroughHash: HASH, rangeBlocks: 50,
  };
}

async function prepareCoverage(input) {
  const coverageThrough = input.coverageThroughBlock || input.sourceThroughBlock;
  await db.query(
    `INSERT INTO robinhood_holder_token_states (token_address, ledger_status)
       VALUES ($1, 'live') ON CONFLICT (chain, token_address)
       DO UPDATE SET ledger_status = 'live'`, [TOKEN]
  );
  await db.query(
    'DELETE FROM robinhood_wallet_transfer_token_coverage WHERE token_address = $1', [TOKEN]
  );
  await db.query(
    `INSERT INTO robinhood_wallet_transfer_token_coverage (
       projection_version, token_address, source_from_block, next_block,
       source_through_block, source_through_hash, status, completed_at, published_at
     ) VALUES ($1, $2, $3::bigint, $4::bigint + 1, $4::bigint, $5,
               'complete', NOW(), NOW())`,
    [input.projectionVersion, TOKEN, input.sourceFromBlock, coverageThrough, COVERAGE_HASH]
  );
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
    for (const stage of [
      stage110, stage113, stage114, stage116, stage129, stage134, stage154, stage158, stage159,
    ]) {
      await stage.init({ closePool: false });
    }
    await cleanup();
  });

  after(async () => {
    await cleanup();
    await db.pool.end();
  });

  it('freezes the tracked catalog at campaign creation without requiring broad repair', async () => {
    await db.query(
      `INSERT INTO robinhood_holder_token_states (
         token_address, ledger_status, deployment_block
       ) VALUES ($1, 'live', 110)`, [TOKEN]
    );
    const repository = createRobinhoodDirectionalTransferReplayRepository({ database: db });
    const created = await repository.createRun(runInput());
    const snapshot = await db.query(
      `SELECT coverage_from_block::text, coverage_through_block::text, coverage_through_hash
         FROM robinhood_directional_transfer_replay_tokens WHERE run_id = $1`, [created.id]
    );
    assert.deepEqual(snapshot.rows[0], {
      coverage_from_block: '100', coverage_through_block: '219', coverage_through_hash: HASH,
    });
    await deleteRun(created.id);
  });

  it('creates disjoint ranges, resumes leases and completes with progress', async () => {
    const repository = createRobinhoodDirectionalTransferReplayRepository({ database: db });
    await prepareCoverage({ ...runInput(), coverageThroughBlock: '250' });
    const created = await repository.createRun(runInput());
    assert.deepEqual(created, {
      id: created.id, status: 'planned', rangeCount: 3, tokenCount: 1,
    });
    await db.query(
      'DELETE FROM robinhood_directional_transfer_replay_tokens WHERE run_id = $1', [created.id]
    );
    assert.deepEqual(await repository.ensureTokenScope(created.id), {
      ready: true, tokenCount: 1, unavailable: 0, alreadyFrozen: false,
    });
    assert.deepEqual(await repository.getTokenScopeReadiness(created.id), {
      ready: true, tokenCount: 1, unavailable: 0, alreadyFrozen: true,
    });
    assert.deepEqual(await repository.listRunTokenAddresses(created.id), [TOKEN]);
    const snapshot = await db.query(
      `SELECT coverage_through_block::text, coverage_through_hash
         FROM robinhood_directional_transfer_replay_tokens WHERE run_id = $1`, [created.id]
    );
    assert.deepEqual(snapshot.rows[0], {
      coverage_through_block: '219', coverage_through_hash: HASH,
    });
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

  it('stages only a missing token from its exact deployment block', async () => {
    await db.query(
      `INSERT INTO robinhood_holder_token_states (
         token_address, ledger_status, deployment_block
       ) VALUES ($1, 'live', 120)`, [REPAIR_TOKEN]
    );
    const repository = createRobinhoodDirectionalTransferReplayRepository({ database: db });
    const created = await repository.createRun(runInput());
    await db.query(
      `INSERT INTO robinhood_wallet_transfer_cursors (
         projection_version, stream, origin_block, next_block, next_block_time,
         safe_head, checkpoint_block, checkpoint_hash, lifecycle_state
       ) VALUES ('test_directional_v1', 'live', 100, 251, NOW(), 250, 250, $1, 'running')`,
      [HASH]
    );
    assert.deepEqual(await repository.stageTokenRepairCandidates({
      runId: created.id, tokenAddresses: [REPAIR_TOKEN, REPAIR_TOKEN],
    }), { requested: 1, inserted: 1 });
    const coverage = await db.query(
      `SELECT source_from_block::text, next_block::text, source_through_block::text, status
         FROM robinhood_wallet_transfer_token_coverage WHERE token_address = $1`, [REPAIR_TOKEN]
    );
    assert.deepEqual(coverage.rows[0], {
      source_from_block: '120', next_block: '120', source_through_block: '250', status: 'pending',
    });
    await db.query(
      `INSERT INTO robinhood_holder_token_states (token_address, ledger_status)
       VALUES ($1, 'live')`, [ATTRIBUTED_TOKEN]
    );
    await db.query(
      `INSERT INTO robinhood_token_attributions (
         token_address, creator_address, source, attribution_block, attribution_tx_hash,
         last_resolved_at
       ) VALUES ($1, $2, 'rpc_direct', 130, $3, NOW())`,
      [ATTRIBUTED_TOKEN, `0x${'1'.repeat(40)}`, HASH]
    );
    assert.deepEqual(await repository.stageTokenRepairCandidates({
      runId: created.id, tokenAddresses: [ATTRIBUTED_TOKEN],
    }), { requested: 1, inserted: 1 });
    const attributedCoverage = await db.query(
      `SELECT source_from_block::text FROM robinhood_wallet_transfer_token_coverage
        WHERE token_address = $1`, [ATTRIBUTED_TOKEN]
    );
    assert.equal(attributedCoverage.rows[0].source_from_block, '130');
    await db.query(
      `INSERT INTO robinhood_holder_token_states (token_address, ledger_status)
       VALUES ($1, 'live')`, [UNKNOWN_DEPLOYMENT_TOKEN]
    );
    await assert.rejects(repository.stageTokenRepairCandidates({
      runId: created.id, tokenAddresses: [UNKNOWN_DEPLOYMENT_TOKEN],
    }), (error) => error.code === 'directional_repair_deployment_unavailable');
    await deleteRun(created.id);
  });

  it('fails after the attempt budget and resumes only failed ranges', async () => {
    const repository = createRobinhoodDirectionalTransferReplayRepository({ database: db });
    const input = {
      ...runInput(), sourceFromBlock: '300', sourceThroughBlock: '300',
    };
    await prepareCoverage(input);
    const created = await repository.createRun(input);
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
    await deleteRun(created.id);
  });

  it('defers missing-edge ranges and settles only after remaining work drains', async () => {
    const repository = createRobinhoodDirectionalTransferReplayRepository({ database: db });
    const input = {
      ...runInput(), sourceFromBlock: '400', sourceThroughBlock: '401', rangeBlocks: 1,
    };
    await prepareCoverage(input);
    const created = await repository.createRun(input);
    await repository.startRun(created.id);
    const deferred = await repository.claimRange({
      runId: created.id, owner: 'worker-a', leaseMs: 60_000,
    });
    assert.equal(await repository.deferRangeForTokenRepair({
      runId: created.id, rangeId: deferred.id, owner: 'worker-a',
      error: { code: 'directional_replay_edge_missing', message: 'repair required' },
    }), 'failed');
    assert.equal((await repository.getRun(created.id)).status, 'running');
    assert.deepEqual(await repository.settleTokenRepairDiscovery(created.id), {
      status: 'running', settled: false,
    });

    const remaining = await repository.claimRange({
      runId: created.id, owner: 'worker-b', leaseMs: 60_000,
    });
    await complete(repository, created.id, remaining, 'worker-b', { blocksScanned: '1' });
    assert.deepEqual(await repository.settleTokenRepairDiscovery(created.id), {
      status: 'failed', settled: true,
    });
    const progress = await repository.getProgress({ runId: created.id });
    assert.deepEqual({
      status: progress.status, completed: progress.completed, failed: progress.failed,
      pending: progress.pending, leased: progress.leased,
    }, { status: 'failed', completed: 1, failed: 1, pending: 0, leased: 0 });
    assert.deepEqual(await repository.resumeFailed(created.id), {
      runId: created.id, requeued: 1,
    });
  });
});
