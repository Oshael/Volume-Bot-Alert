process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const {
  createRobinhoodLaunchAnchorBackfillRepository,
} = require('../src/models/robinhood-launch-anchor-backfill');
const { createRobinhoodWalletSwapRepository } = require(
  '../src/models/robinhood-wallet-swap-persistence'
);
const stage63 = require('../src/utils/db-init-stage63');
const stage90 = require('../src/utils/db-init-stage90');
const stage155 = require('../src/utils/db-init-stage155');
const stage157 = require('../src/utils/db-init-stage157');
const stage166 = require('../src/utils/db-init-stage166');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const HASH = `0x${'a'.repeat(64)}`;
const TOKEN = `0x${'1'.repeat(40)}`;
const FAILED_TOKEN = `0x${'2'.repeat(40)}`;
const BACKFILL_TOKEN = `0x${'3'.repeat(40)}`;
const WALLET = `0x${'4'.repeat(40)}`;
const QUOTE = `0x${'5'.repeat(40)}`;
const TX = `0x${'b'.repeat(64)}`;

async function cleanup() {
  await db.query('DELETE FROM robinhood_token_launch_anchors WHERE token_address = $1',
    [BACKFILL_TOKEN]);
  await db.query('DELETE FROM robinhood_wallet_swaps WHERE token_address = $1', [BACKFILL_TOKEN]);
  await db.query('DELETE FROM robinhood_pool_registry WHERE token_address = $1', [BACKFILL_TOKEN]);
  await db.query('DELETE FROM robinhood_launch_anchor_backfill_targets');
  await db.query('DELETE FROM robinhood_launch_anchor_backfill_runs');
}

describe('Robinhood launch-anchor backfill control schema integration', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    for (const stage of [stage63, stage90, stage155, stage157, stage166]) {
      await stage.init({ closePool: false });
    }
    await stage166.init({ closePool: false });
    await cleanup();
  });

  after(async () => {
    await cleanup();
    await db.pool.end();
  });

  it('enforces one active run, lease ownership and terminal outcomes', async () => {
    const run = await db.query(
      `INSERT INTO robinhood_launch_anchor_backfill_runs(source_through_block)
       VALUES (200) RETURNING id`
    );
    await assert.rejects(
      db.query(`INSERT INTO robinhood_launch_anchor_backfill_runs(source_through_block)
                VALUES (300)`),
      /idx_rh_launch_anchor_backfill_runs_active/
    );
    await db.query(
      `INSERT INTO robinhood_launch_anchor_backfill_targets(
         run_id, token_address, first_pool_block,
         source_through_block, source_through_hash
       ) VALUES ($1, $2, 100, 200, $4), ($1, $3, 100, 200, $4)`,
      [run.rows[0].id, TOKEN, FAILED_TOKEN, HASH]
    );
    await assert.rejects(
      db.query(
        `UPDATE robinhood_launch_anchor_backfill_targets
            SET status = 'leased' WHERE run_id = $1 AND token_address = $2`,
        [run.rows[0].id, TOKEN]
      ),
      /rh_launch_anchor_backfill_targets_lease_check/
    );
    await assert.rejects(
      db.query(
        `UPDATE robinhood_launch_anchor_backfill_targets SET
           status = 'completed', completed_at = NOW(),
           anchor_block = 99, anchors_written = 1
         WHERE run_id = $1 AND token_address = $2`,
        [run.rows[0].id, TOKEN]
      ),
      /rh_launch_anchor_backfill_targets_completion_check/
    );
    await db.query(
      `UPDATE robinhood_launch_anchor_backfill_targets SET
         status = 'completed', completed_at = NOW(),
         anchor_block = 101, anchors_written = 1, swaps_considered = 4
       WHERE run_id = $1 AND token_address = $2`,
      [run.rows[0].id, TOKEN]
    );
    const target = await db.query(
      `SELECT status, anchor_block::text, swaps_considered::text, anchors_written
         FROM robinhood_launch_anchor_backfill_targets
        WHERE run_id = $1 AND token_address = $2`,
      [run.rows[0].id, TOKEN]
    );
    assert.deepEqual(target.rows[0], {
      status: 'completed', anchor_block: '101',
      swaps_considered: '4', anchors_written: 1,
    });
    await assert.rejects(
      db.query(
        `UPDATE robinhood_launch_anchor_backfill_targets
            SET status = 'failed' WHERE run_id = $1 AND token_address = $2`,
        [run.rows[0].id, FAILED_TOKEN]
      ),
      /rh_launch_anchor_backfill_targets_completion_check/
    );
    await db.query(
      `UPDATE robinhood_launch_anchor_backfill_targets SET
         status = 'failed', completed_at = NOW(),
         last_error_code = 'retry_exhausted', last_error_message = 'timed out'
       WHERE run_id = $1 AND token_address = $2`,
      [run.rows[0].id, FAILED_TOKEN]
    );
  });

  it('atomically materializes an anchor batch and closes its campaign', async () => {
    await db.query(`UPDATE robinhood_launch_anchor_backfill_runs SET
      status = 'failed', started_at = NOW(), finished_at = NOW() WHERE status = 'planned'`);
    await db.query(`INSERT INTO robinhood_pool_registry (
      protocol, market_key, pool_address, token_address, quote_address,
      currency0, currency1, discovery_block, discovery_block_hash,
      discovery_tx_hash, discovery_log_index, discovered_at
    ) VALUES ('uniswap-v2', 'anchor-backfill', $1, $2, $3, $2, $3, 100, $4, $5, 0, NOW())`,
    [WALLET, BACKFILL_TOKEN, QUOTE, HASH, TX]);
    await createRobinhoodWalletSwapRepository({ database: db }).ensurePartitionForDay('2026-08-26');
    await db.query(`INSERT INTO robinhood_wallet_swaps (
      wallet_address, transaction_hash, action_index, block_number, block_time,
      protocol, market_key, token_address, quote_address, side,
      token_amount_raw, quote_amount_raw, parser_version
    ) VALUES ($1, $2, 0, 101, '2026-08-26T12:00:00Z', 'uniswap-v2',
      'anchor-backfill', $3, $4, 'buy', 1, 1, 'integration')`,
    [WALLET, TX, BACKFILL_TOKEN, QUOTE]);
    const repository = createRobinhoodLaunchAnchorBackfillRepository({
      database: db, statementTimeoutMs: 5_000,
    });
    const run = await repository.createRun({
      report: { approved: true },
      plan: { ready: true, sourceThroughBlock: '200',
        targets: [{ tokenAddress: BACKFILL_TOKEN, firstPoolBlock: '100',
          sourceThroughBlock: '200', sourceThroughHash: HASH }] },
    });
    assert.equal((await repository.loadRunPlan(run.id)).targets.length, 1);
    const result = await repository.materializeBatch({
      runId: run.id, owner: 'integration', limit: 10, leaseMs: 10_000,
    });
    assert.deepEqual(result, {
      status: 'completed', claimed: 1, anchorsWritten: 1, unavailable: 0,
    });
    assert.deepEqual((await db.query(
      `SELECT launch_block::text FROM robinhood_token_launch_anchors
        WHERE token_address = $1`, [BACKFILL_TOKEN]
    )).rows, [{ launch_block: '101' }]);
    assert.equal((await repository.getProgress(run.id)).progressPct, 100);
  });
});
