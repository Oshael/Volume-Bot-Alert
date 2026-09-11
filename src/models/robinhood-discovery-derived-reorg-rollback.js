'use strict';

const CHAIN = 'robinhood';

function quantity(value, label) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized)) throw new Error(`${label} is invalid`);
  return BigInt(normalized).toString();
}

function normalizeRange(input = {}) {
  const range = {
    fromBlock: quantity(input.fromBlock, 'derived rollback fromBlock'),
    throughBlock: quantity(input.throughBlock, 'derived rollback throughBlock'),
  };
  if (BigInt(range.fromBlock) > BigInt(range.throughBlock)) {
    throw new Error('derived rollback range is inconsistent');
  }
  return range;
}

function conflict(message) {
  return Object.assign(new Error(message), {
    code: 'derived_recovery_fence_conflict',
  });
}

async function assertNoFutureFrontiers(client, range) {
  const result = await client.query(
    `SELECT
       (SELECT COUNT(*) FROM robinhood_token_launch_anchors
         WHERE chain=$1 AND source_through_block>$2::bigint)
       + (SELECT COUNT(*) FROM robinhood_holder_classification_states
         WHERE chain=$1 AND through_block_number>$2::bigint)
       + (SELECT COUNT(*) FROM robinhood_holder_distribution_metrics
         WHERE chain=$1 AND through_block_number>$2::bigint)
       + (SELECT COUNT(*) FROM robinhood_possible_bundle_states
         WHERE chain=$1 AND through_block_number>$2::bigint)
       + (SELECT COUNT(*) FROM robinhood_fresh_wallet_token_coverage
         WHERE chain=$1 AND through_block_number>$2::bigint)
       + (SELECT COUNT(*) FROM robinhood_fresh_wallet_evaluations
         WHERE chain=$1 AND through_block_number>$2::bigint)
       + (SELECT COUNT(*) FROM robinhood_bundle_redistribution_states
         WHERE chain=$1 AND through_block_number>$2::bigint) AS rows`,
    [CHAIN, range.throughBlock]
  );
  if (Number(result.rows[0]?.rows || 0)) {
    throw conflict('derived frontier is ahead of the recovery range');
  }
}

async function invalidateLaunchAnchors(client, range) {
  const deleted = await client.query(
    `DELETE FROM robinhood_token_launch_anchors
      WHERE chain=$1 AND source_through_block>=$2::bigint
      RETURNING token_address`, [CHAIN, range.fromBlock]
  );
  const tokens = deleted.rows.map(({ token_address: tokenAddress }) => tokenAddress);
  const removed = await client.query(
    `DELETE FROM robinhood_launch_anchor_outbox outbox
      WHERE outbox.chain=$1 AND NOT EXISTS (
        SELECT 1 FROM robinhood_wallet_token_first_buys first_buy
         WHERE first_buy.chain=outbox.chain
           AND first_buy.token_address=outbox.token_address
      )`, [CHAIN]
  );
  if (tokens.length) {
    await client.query(
      `INSERT INTO robinhood_launch_anchor_outbox(chain,token_address)
       SELECT $1::varchar, token FROM UNNEST($2::varchar[]) token
        WHERE EXISTS (
          SELECT 1 FROM robinhood_wallet_token_first_buys first_buy
           WHERE first_buy.chain=$1::varchar AND first_buy.token_address=token
        )
       ON CONFLICT (chain,token_address) DO UPDATE SET
         status='pending', attempt_count=0, next_attempt_at=NOW(),
         lease_owner=NULL, lease_until=NULL, last_error=NULL, updated_at=NOW()`,
      [CHAIN, tokens]
    );
    await client.query("SELECT pg_notify('robinhood_launch_anchor_outbox',$1)", [tokens[0]]);
  }
  const queued = await client.query(
    `SELECT COUNT(*)::int AS rows FROM robinhood_launch_anchor_outbox
      WHERE chain=$1 AND token_address=ANY($2::varchar[])`, [CHAIN, tokens]
  );
  return {
    deletedLaunchAnchors: deleted.rowCount || 0,
    requeuedLaunchAnchors: Number(queued.rows[0]?.rows || 0),
    removedOrphanOutbox: removed.rowCount || 0,
  };
}

async function markReorged(client, table, range) {
  const result = await client.query(
    `UPDATE ${table} SET status='reorged', status_reason='chain_reorg', updated_at=NOW()
      WHERE chain=$1 AND through_block_number>=$2::bigint`, [CHAIN, range.fromBlock]
  );
  return result.rowCount || 0;
}

function createRobinhoodDiscoveryDerivedReorgRollback() {
  async function rollback(client, input = {}) {
    if (!client || typeof client.query !== 'function') {
      throw new Error('derived rollback requires a transaction client');
    }
    const range = normalizeRange(input);
    await assertNoFutureFrontiers(client, range);
    const launch = await invalidateLaunchAnchors(client, range);
    const tables = [
      ['classificationStates', 'robinhood_holder_classification_states'],
      ['distributionMetrics', 'robinhood_holder_distribution_metrics'],
      ['possibleBundleStates', 'robinhood_possible_bundle_states'],
      ['freshCoverage', 'robinhood_fresh_wallet_token_coverage'],
      ['freshEvaluations', 'robinhood_fresh_wallet_evaluations'],
      ['redistributionStates', 'robinhood_bundle_redistribution_states'],
    ];
    const invalidated = {};
    for (const [key, table] of tables) invalidated[key] = await markReorged(client, table, range);
    return Object.freeze({ ...launch, invalidated: Object.freeze(invalidated) });
  }
  return Object.freeze({ rollback });
}

module.exports = {
  createRobinhoodDiscoveryDerivedReorgRollback,
  __private: { normalizeRange },
};
