process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const {
  createRobinhoodWalletTokenFirstBuyRepository,
} = require('../src/models/robinhood-wallet-token-first-buy');
const {
  createRobinhoodFreshWalletShadowRepository,
} = require('../src/models/robinhood-fresh-wallet-shadow');
const {
  createRobinhoodFreshWalletLiveQueueRepository,
} = require('../src/models/robinhood-fresh-wallet-live-queue');
const {
  createRobinhoodTransactionPositionRepairRepository,
} = require('../src/models/robinhood-transaction-position-repair');
const stage63 = require('../src/utils/db-init-stage63');
const stage90 = require('../src/utils/db-init-stage90');
const stage116 = require('../src/utils/db-init-stage116');
const stage139 = require('../src/utils/db-init-stage139');
const stage143 = require('../src/utils/db-init-stage143');
const stage149 = require('../src/utils/db-init-stage149');
const stage171 = require('../src/utils/db-init-stage171');
const stage177 = require('../src/utils/db-init-stage177');
const stage178 = require('../src/utils/db-init-stage178');
const stage179 = require('../src/utils/db-init-stage179');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const TOKEN = `0x${'1'.repeat(40)}`;
const WALLET = `0x${'2'.repeat(40)}`;
const LIVE_WALLET = `0x${'b'.repeat(40)}`;
const POOL = `0x${'3'.repeat(40)}`;
const QUOTE = `0x${'4'.repeat(40)}`;
const HASH = `0x${'5'.repeat(64)}`;
const TX = `0x${'6'.repeat(64)}`;
const LIVE_TX = `0x${'c'.repeat(64)}`;
const FORK_HASH = `0x${'d'.repeat(64)}`;
const MARKET = `robinhood:uniswap-v3:${POOL}`;
const PARTITION = 'robinhood_wallet_swaps_first_buy_test';
const SWAP_HASHES = [7, 8, 9, 11].map((digit) => `0x${digit.toString(16).repeat(64)}`);

async function cleanup() {
  await db.query('DELETE FROM robinhood_fresh_wallet_evaluations WHERE token_address = $1', [TOKEN]);
  await db.query('DELETE FROM robinhood_fresh_wallet_token_coverage WHERE token_address = $1', [TOKEN]);
  await db.query('DELETE FROM robinhood_fresh_wallet_queue WHERE token_address = $1', [TOKEN]);
  await db.query(`DELETE FROM robinhood_holder_classifications
    WHERE token_address = $1 AND tag = 'fresh'`, [TOKEN]);
  await db.query("DELETE FROM robinhood_fresh_wallet_seed_runs WHERE chain = 'robinhood'");
  await db.query("DELETE FROM robinhood_fresh_wallet_activations WHERE chain = 'robinhood'");
  await db.query('DELETE FROM robinhood_launch_anchor_outbox WHERE token_address = $1', [TOKEN]);
  await db.query('DELETE FROM robinhood_wallet_token_first_buys WHERE token_address = $1', [TOKEN]);
  await db.query('DELETE FROM robinhood_holder_token_states WHERE token_address = $1', [TOKEN]);
  await db.query(`DELETE FROM ${PARTITION}`);
  await db.query(
    `DELETE FROM robinhood_transaction_positions
      WHERE transaction_hash IN ($1, $2, $3, $4)`, SWAP_HASHES
  );
  await db.query('DELETE FROM robinhood_pool_registry WHERE market_key = $1', [MARKET]);
}

describe('Robinhood wallet-token first buy schema integration', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage63.init({ closePool: false });
    await stage90.init({ closePool: false });
    await stage116.init({ closePool: false });
    await stage139.init({ closePool: false });
    await stage143.init({ closePool: false });
    await stage149.init({ closePool: false });
    await stage171.init({ closePool: false });
    await stage177.init({ closePool: false });
    await stage178.init({ closePool: false });
    await stage179.init({ closePool: false });
    await stage149.init({ closePool: false });
    await db.query(
      `CREATE TABLE IF NOT EXISTS ${PARTITION}
       PARTITION OF robinhood_wallet_swaps
       FOR VALUES FROM ('2099-01-01T00:00:00Z') TO ('2099-01-04T00:00:00Z')`
    );
    await cleanup();
    await db.query(
      `INSERT INTO robinhood_pool_registry (
         protocol, market_key, pool_address, origin_address, token_address,
         quote_address, currency0, currency1, discovery_block,
         discovery_block_hash, discovery_tx_hash, discovery_log_index, discovered_at
       ) VALUES ('uniswap-v3', $1, $2, $2, $3, $4, $3, $4, 10,
         $5, $6, 0, '2026-08-22T12:00:00Z')`,
      [MARKET, POOL, TOKEN, QUOTE, HASH, TX]
    );
  });

  after(async () => {
    await cleanup();
    await db.pool.end();
  });

  it('persists one canonical fact without classifier state', async () => {
    await db.query(
      `INSERT INTO robinhood_wallet_token_first_buys (
         token_address, wallet_address, transaction_hash, transaction_index,
         action_index, block_number, block_hash, block_time, protocol,
         market_key, volume_usd, source_parser_version
       ) VALUES ($1, $2, $3, 1, 2, 20, $4, '2026-08-22T12:01:00Z',
         'uniswap-v3', $5, 25.5, 'swap_only_v1')`,
      [TOKEN, WALLET, TX, HASH, MARKET]
    );
    const { rows } = await db.query(
      `SELECT block_number::text, volume_usd::text, evidence_version
         FROM robinhood_wallet_token_first_buys
        WHERE token_address = $1 AND wallet_address = $2`,
      [TOKEN, WALLET]
    );
    assert.deepEqual(rows[0], {
      block_number: '20', volume_usd: '25.5', evidence_version: 'rh_first_buy_v1',
    });
    assert.equal((await db.query(
      'SELECT COUNT(*)::integer count FROM robinhood_launch_anchor_outbox WHERE token_address = $1',
      [TOKEN]
    )).rows[0].count, 0);
    await db.query(`INSERT INTO robinhood_holder_token_states(
      token_address, ledger_status, live_through_block, live_through_hash
    ) VALUES ($1, 'live', 30, $2)`, [TOKEN, HASH]);
    assert.deepEqual((await db.query(
      `SELECT status, eligibility_version FROM robinhood_launch_anchor_outbox
        WHERE token_address = $1`, [TOKEN]
    )).rows[0], { status: 'pending', eligibility_version: 'rh_holder_live_v1' });
    await assert.rejects(db.query(
      `UPDATE robinhood_wallet_token_first_buys SET volume_usd = -1
        WHERE token_address = $1`, [TOKEN]
    ), /rh_wallet_token_first_buys_values_check/);
    await assert.rejects(db.query(
      `INSERT INTO robinhood_wallet_token_first_buys (
         token_address, wallet_address, transaction_hash, transaction_index,
         action_index, block_number, block_hash, block_time, protocol,
         market_key, source_parser_version
       ) VALUES ($1, $2, $3, 1, 3, 20, $4, '2026-08-22T12:01:00Z',
         'uniswap-v3', 'unknown-market', 'swap_only_v1')`,
      [TOKEN, `0x${'7'.repeat(40)}`, TX, HASH]
    ), /rh_wallet_token_first_buys_pool_fkey/);
  });

  it('freezes activation and queues only idempotent post-activation work', async () => {
    await db.query(`INSERT INTO robinhood_fresh_wallet_activations (
      status, activation_at, activation_block, activation_block_hash,
      seed_cutoff_at, first_buy_source_through, first_buy_source_next_block, activated_at
    ) VALUES ('active', '2026-08-22T12:01:00Z', 20, $1,
      '2026-08-08T12:01:00Z', '2026-08-22T12:01:00Z', 21, NOW())`, [HASH]);
    assert.equal((await db.query(
      'SELECT COUNT(*)::integer count FROM robinhood_fresh_wallet_queue'
    )).rows[0].count, 0);

    await db.query(`INSERT INTO robinhood_wallet_token_first_buys (
      token_address, wallet_address, transaction_hash, transaction_index,
      action_index, block_number, block_hash, block_time, protocol,
      market_key, volume_usd, source_parser_version
    ) VALUES ($1, $2, $3, 2, 0, 21, $4, '2026-08-22T12:02:00Z',
      'uniswap-v3', $5, 10, 'swap_only_v1')`,
    [TOKEN, LIVE_WALLET, LIVE_TX, HASH, MARKET]);
    assert.deepEqual((await db.query(`SELECT source_kind, requested_version::integer
      FROM robinhood_fresh_wallet_queue WHERE token_address = $1 AND wallet_address = $2`,
    [TOKEN, LIVE_WALLET])).rows[0], { source_kind: 'live', requested_version: 1 });

    await db.query(`UPDATE robinhood_wallet_token_first_buys SET block_hash = block_hash
      WHERE token_address = $1 AND wallet_address = $2`, [TOKEN, LIVE_WALLET]);
    assert.equal((await db.query(`SELECT requested_version::integer value
      FROM robinhood_fresh_wallet_queue WHERE token_address = $1 AND wallet_address = $2`,
    [TOKEN, LIVE_WALLET])).rows[0].value, 1);
    await db.query(`UPDATE robinhood_wallet_token_first_buys SET block_hash = $3
      WHERE token_address = $1 AND wallet_address = $2`, [TOKEN, LIVE_WALLET, FORK_HASH]);
    assert.equal((await db.query(`SELECT requested_version::integer value
      FROM robinhood_fresh_wallet_queue WHERE token_address = $1 AND wallet_address = $2`,
    [TOKEN, LIVE_WALLET])).rows[0].value, 2);

    await db.query(`UPDATE robinhood_wallet_token_first_buys
      SET block_number = 19, block_time = '2026-08-22T12:00:00Z'
      WHERE token_address = $1 AND wallet_address = $2`, [TOKEN, LIVE_WALLET]);
    assert.equal((await db.query(`SELECT COUNT(*)::integer count
      FROM robinhood_fresh_wallet_queue WHERE token_address = $1 AND wallet_address = $2`,
    [TOKEN, LIVE_WALLET])).rows[0].count, 0);
    await assert.rejects(db.query(`UPDATE robinhood_fresh_wallet_activations
      SET activation_block = 19 WHERE chain = 'robinhood'`),
    /FRESH activation boundary is immutable/);
  });

  it('refuses complete seed and ready partial coverage without complete counts', async () => {
    const run = await db.query(`INSERT INTO robinhood_fresh_wallet_seed_runs (
      expected_token_count, expected_pair_count
    ) VALUES (1, 1) RETURNING id`);
    await assert.rejects(db.query(`UPDATE robinhood_fresh_wallet_seed_runs
      SET expected_pair_count = 2 WHERE id = $1`, [run.rows[0].id]),
    /FRESH seed cohort is immutable/);
    await assert.rejects(db.query(`UPDATE robinhood_fresh_wallet_seed_runs SET
      status = 'completed', started_at = NOW(), finished_at = NOW() WHERE id = $1`,
    [run.rows[0].id]), /rh_fresh_wallet_seed_runs_lifecycle_check/);
    await db.query(`INSERT INTO robinhood_fresh_wallet_token_coverage (
      token_address, coverage_scope, status, status_reason,
      required_pair_count, completed_pair_count
    ) VALUES ($1, 'partial', 'pending', 'outside_seed_window', 1, 0)`, [TOKEN]);
    await assert.rejects(db.query(`UPDATE robinhood_fresh_wallet_token_coverage SET
      status = 'ready', completed_pair_count = 1,
      through_block_number = 20, through_block_hash = $2
      WHERE token_address = $1`, [TOKEN, HASH]),
    /rh_fresh_wallet_token_coverage_contract_check/);
  });

  it('replaces out-of-order facts and fails closed on missing positions', async () => {
    await db.query('DELETE FROM robinhood_wallet_token_first_buys WHERE token_address = $1', [TOKEN]);
    await db.query(
      `INSERT INTO robinhood_transaction_positions
         (transaction_hash, block_number, block_hash, transaction_index)
       VALUES ($1, 30, $4, 2), ($2, 20, $4, 1), ($3, 20, $4, 0)`,
      [SWAP_HASHES[0], SWAP_HASHES[1], SWAP_HASHES[3], HASH]
    );
    await db.query(
      `INSERT INTO ${PARTITION} (
         wallet_address, transaction_hash, action_index, block_number, block_time,
         protocol, market_key, token_address, quote_address, side,
         token_amount_raw, quote_amount_raw, volume_usd, parser_version
       ) VALUES
         ($1, $3, 0, 30, '2099-01-02T01:00:00Z', 'uniswap-v3', $6, $2, $7,
          'buy', 1, 1, 30, 'swap_only_v1'),
         ($1, $4, 0, 20, '2099-01-01T01:00:00Z', 'uniswap-v3', $6, $2, $7,
          'buy', 1, 1, 20, 'swap_only_v1'),
         ($1, $5, 0, 20, '2099-01-01T01:00:01Z', 'uniswap-v3', $6, $2, $7,
          'buy', 1, 1, 21, 'swap_only_v1'),
         ($8, $9, 0, 40, '2099-01-03T01:00:00Z', 'uniswap-v3', $6, $2, $7,
          'buy', 1, 1, 40, 'swap_only_v1')`,
      [WALLET, TOKEN, SWAP_HASHES[0], SWAP_HASHES[1], SWAP_HASHES[3], MARKET, QUOTE,
        `0x${'a'.repeat(40)}`, SWAP_HASHES[2]]
    );
    const repair = createRobinhoodTransactionPositionRepairRepository({ database: db });
    assert.deepEqual(await repair.listMissing({
      rangeStart: '2099-01-03T00:00:00Z', rangeEnd: '2099-01-04T00:00:00Z',
    }), [{
      transaction_hash: SWAP_HASHES[2], block_number: '40', transaction_index: null,
    }]);
    const repository = createRobinhoodWalletTokenFirstBuyRepository({ database: db });
    await repository.materializeRange({
      rangeStart: '2099-01-02T00:00:00Z', rangeEnd: '2099-01-03T00:00:00Z',
    });
    await repository.materializeRange({
      rangeStart: '2099-01-01T00:00:00Z', rangeEnd: '2099-01-02T00:00:00Z',
    });
    const persisted = await db.query(
      `SELECT transaction_hash, block_number::text
         FROM robinhood_wallet_token_first_buys
        WHERE token_address = $1 AND wallet_address = $2`, [TOKEN, WALLET]
    );
    assert.deepEqual(persisted.rows[0], {
      transaction_hash: SWAP_HASHES[3], block_number: '20',
    });
    await assert.rejects(repository.materializeRange({
      rangeStart: '2099-01-03T00:00:00Z', rangeEnd: '2099-01-04T00:00:00Z',
    }), (error) => error.code === 'first_buy_position_unavailable');
  });

  it('materializes shadow evidence atomically and removes FRESH after a reorg', async () => {
    const repository = createRobinhoodFreshWalletShadowRepository({ database: db });
    const lease = async () => (await db.query(`UPDATE robinhood_fresh_wallet_queue SET
      status = 'leased', lease_owner = 'shadow-test', lease_until = NOW() + INTERVAL '1 minute',
      completed_at = NULL WHERE token_address = $1 AND wallet_address = $2
      RETURNING requested_version::text`, [TOKEN, WALLET])).rows[0].requested_version;
    const evidence = (blockNumber, blockHash) => ({
      ruleVersion: 'rh_fresh_signed_v1', source: 'test',
      observedAt: '2026-08-22T12:03:00Z',
      firstBuy: {
        walletAddress: WALLET, transactionHash: SWAP_HASHES[3],
        blockNumber: String(blockNumber), blockHash,
        blockTime: '2026-08-22T12:02:00Z', nonce: '5',
      },
      cutoff: { targetAt: '2026-08-21T12:02:00Z', number: '10', hash: HASH,
        blockTime: '2026-08-21T12:01:59Z', nonce: '0' },
      nextBlock: { number: '11', hash: FORK_HASH, blockTime: '2026-08-21T12:02:00Z' },
    });
    const decision = {
      ruleVersion: 'rh_fresh_signed_v1', outcome: 'fresh',
      outcomeReason: 'new_wallet_at_first_buy', reasonCode: 'new_wallet_at_first_buy',
      confidence: 'high',
    };
    await db.query(`UPDATE robinhood_wallet_token_first_buys SET
      block_number = 21, block_hash = $3, block_time = '2026-08-22T12:02:00Z'
      WHERE token_address = $1 AND wallet_address = $2`, [TOKEN, WALLET, HASH]);
    const version = await lease();
    const input = {
      tokenAddress: TOKEN, walletAddress: WALLET, owner: 'shadow-test',
      requestedVersion: version, status: 'ready', evidence: evidence(21, HASH), decision,
    };
    assert.deepEqual(await repository.replaceAndComplete(input), {
      completed: true, status: 'replace',
    });
    await lease();
    assert.deepEqual(await repository.replaceAndComplete(input), {
      completed: true, status: 'unchanged',
    });
    assert.equal((await db.query(`SELECT COUNT(*)::integer count
      FROM robinhood_holder_classifications WHERE token_address = $1
        AND wallet_address = $2 AND tag = 'fresh'`, [TOKEN, WALLET])).rows[0].count, 1);

    await db.query(`UPDATE robinhood_wallet_token_first_buys SET block_number = 22
      WHERE token_address = $1 AND wallet_address = $2`, [TOKEN, WALLET]);
    const staleVersion = await lease();
    assert.equal((await repository.replaceAndComplete({
      ...input, requestedVersion: staleVersion, status: 'stale',
      statusReason: 'behind_canonical_frontier', evidence: evidence(20, HASH),
      throughBlockNumber: 20, decision: undefined,
    })).status, 'ignore');
    assert.equal((await db.query(`SELECT through_block_number::text value
      FROM robinhood_fresh_wallet_evaluations WHERE token_address = $1
        AND wallet_address = $2`, [TOKEN, WALLET])).rows[0].value, '21');

    await db.query(`UPDATE robinhood_wallet_token_first_buys SET
      block_number = 21, block_hash = $3 WHERE token_address = $1 AND wallet_address = $2`,
    [TOKEN, WALLET, FORK_HASH]);
    const reorgVersion = await lease();
    const reorg = {
      ...input, requestedVersion: reorgVersion, status: 'reorged',
      statusReason: 'canonical_reorg', evidence: evidence(21, FORK_HASH), decision: undefined,
    };
    await assert.rejects(repository.replaceAndComplete(reorg), /fork requires explicit/);
    assert.deepEqual(await repository.replaceAndComplete(reorg, {
      allowForkReplacement: true,
    }), { completed: true, status: 'replace' });
    const result = await db.query(`SELECT evaluation.status,
      classification.wallet_address FROM robinhood_fresh_wallet_evaluations evaluation
      LEFT JOIN robinhood_holder_classifications classification
        ON classification.token_address = evaluation.token_address
       AND classification.wallet_address = evaluation.wallet_address
       AND classification.tag = 'fresh'
      WHERE evaluation.token_address = $1 AND evaluation.wallet_address = $2`, [TOKEN, WALLET]);
    assert.deepEqual(result.rows[0], { status: 'reorged', wallet_address: null });

    await db.query(`UPDATE robinhood_wallet_token_first_buys SET
      block_number = 22, block_hash = $3 WHERE token_address = $1 AND wallet_address = $2`,
    [TOKEN, WALLET, HASH]);
    assert.equal((await db.query(`SELECT status FROM robinhood_fresh_wallet_queue
      WHERE token_address = $1 AND wallet_address = $2`, [TOKEN, WALLET])).rows[0].status,
    'pending');
    const unavailableVersion = await lease();
    await repository.replaceAndComplete({
      ...input, requestedVersion: unavailableVersion, status: 'unavailable',
      statusReason: 'rpc_unavailable', decision: undefined,
      evidence: { source: 'test', observedAt: '2026-08-22T12:04:00Z',
        error: { code: 'archive_unavailable' } },
    }, { allowReset: true });
    assert.equal((await db.query(`SELECT status FROM robinhood_fresh_wallet_evaluations
      WHERE token_address = $1 AND wallet_address = $2`, [TOKEN, WALLET])).rows[0].status,
    'unavailable');
  });

  it('retries exact FRESH live leases and resumes expired work', async () => {
    const queue = createRobinhoodFreshWalletLiveQueueRepository({ database: db });
    await db.query(`UPDATE robinhood_wallet_token_first_buys SET block_number = 23
      WHERE token_address = $1 AND wallet_address = $2`, [TOKEN, WALLET]);
    const [task] = await queue.claimBatch({ owner: 'live-a', leaseMs: 10_000, limit: 10 });
    assert.deepEqual({ tokenAddress: task.tokenAddress, walletAddress: task.walletAddress,
      blockNumber: task.blockNumber, attemptCount: task.attemptCount }, {
      tokenAddress: TOKEN, walletAddress: WALLET, blockNumber: '23', attemptCount: 1,
    });
    assert.equal(await queue.retry({ ...task, owner: 'wrong', retryMs: 1000,
      error: new Error('retry') }), false);
    assert.equal(await queue.retry({ ...task, owner: 'live-a', retryMs: 1000,
      error: Object.assign(new Error('RPC down'), { code: 'rpc_unavailable' }) }), true);
    assert.deepEqual((await db.query(`SELECT status, last_error_code
      FROM robinhood_fresh_wallet_queue WHERE token_address = $1 AND wallet_address = $2`,
    [TOKEN, WALLET])).rows[0], { status: 'pending', last_error_code: 'rpc_unavailable' });
    await db.query(`UPDATE robinhood_fresh_wallet_queue SET next_attempt_at = NOW()
      WHERE token_address = $1 AND wallet_address = $2`, [TOKEN, WALLET]);
    const [reclaimed] = await queue.claimBatch({ owner: 'live-b', leaseMs: 10_000 });
    await db.query(`UPDATE robinhood_fresh_wallet_queue SET lease_until = NOW() - INTERVAL '1 second'
      WHERE token_address = $1 AND wallet_address = $2`, [TOKEN, WALLET]);
    const [expired] = await queue.claimBatch({ owner: 'live-c', leaseMs: 10_000 });
    assert.equal(expired.attemptCount, reclaimed.attemptCount + 1);
  });
});
