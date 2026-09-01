const db = require('./db');

const CHAIN = 'robinhood';
const PROJECTION_VERSION = 'rh_transfer_v1';
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const DEAD_ADDRESS = '0x000000000000000000000000000000000000dead';
const MAX_PAGE_SIZE = 100;

const TOKENS_SQL = `SELECT anchor.token_address
  FROM robinhood_token_launch_anchors anchor
 WHERE anchor.chain = $1 AND anchor.token_address > $2
   AND anchor.launch_block_time IS NOT NULL
 ORDER BY anchor.token_address
 LIMIT $3::integer`;

const CLUSTERS_SQL = `WITH requested(token_address) AS (
  SELECT value::varchar FROM jsonb_array_elements_text($3::jsonb) value
), edges AS MATERIALIZED (
  SELECT edge.token_address, edge.from_wallet AS source_wallet,
         edge.to_wallet AS recipient_wallet,
         anchor.launch_block, anchor.launch_block_time,
         buy.block_number AS buy_block, buy.block_time AS buy_time,
         edge.first_wallet_transfer_block AS transfer_block,
         edge.first_wallet_transfer_at AS transfer_time,
         edge.first_wallet_transfer_amount_raw AS transfer_amount_raw
    FROM requested
    JOIN robinhood_token_launch_anchors anchor
      ON anchor.chain = $1 AND anchor.token_address = requested.token_address
    JOIN robinhood_wallet_token_first_buys buy
      ON buy.chain = anchor.chain AND buy.token_address = anchor.token_address
    JOIN robinhood_wallet_transfer_edges edge
      ON edge.chain = buy.chain AND edge.classification_version = $2
     AND edge.token_address = buy.token_address AND edge.from_wallet = buy.wallet_address
    LEFT JOIN robinhood_token_attributions attribution
      ON attribution.chain = edge.chain AND attribution.token_address = edge.token_address
   WHERE edge.first_wallet_transfer_block > buy.block_number
     AND buy.block_number >= anchor.launch_block
     AND edge.first_wallet_transfer_amount_raw > 0
     AND edge.from_wallet <> edge.to_wallet
     AND edge.from_wallet NOT IN ($4, $5)
     AND edge.to_wallet NOT IN ($4, $5)
     AND edge.from_wallet IS DISTINCT FROM attribution.creator_address
     AND NOT EXISTS (
       SELECT 1 FROM robinhood_infrastructure_registry infrastructure
        WHERE infrastructure.chain = edge.chain
          AND infrastructure.address IN (edge.from_wallet, edge.to_wallet)
          AND infrastructure.valid_from_block <= edge.first_wallet_transfer_block
          AND (infrastructure.valid_through_block IS NULL
            OR infrastructure.valid_through_block >= edge.first_wallet_transfer_block)
     )
     AND NOT EXISTS (
       SELECT 1 FROM robinhood_pool_registry pool
        WHERE pool.chain = edge.chain AND pool.token_address = edge.token_address
          AND pool.discovery_block <= edge.first_wallet_transfer_block
          AND (pool.pool_address IN (edge.from_wallet, edge.to_wallet)
            OR (pool.protocol = 'uniswap-v4'
              AND pool.origin_address IN (edge.from_wallet, edge.to_wallet)))
     )
), qualified AS MATERIALIZED (
  SELECT token_address, source_wallet, MIN(launch_block) AS launch_block,
         MIN(launch_block_time) AS launch_time, MIN(buy_block) AS buy_block,
         MIN(buy_time) AS buy_time, MIN(transfer_block) AS first_transfer_block,
         MIN(transfer_time) AS first_transfer_time,
         MAX(transfer_time) AS last_first_transfer_time,
         COUNT(DISTINCT recipient_wallet)::integer AS recipient_count,
         SUM(transfer_amount_raw)::text AS first_distributed_amount_raw
    FROM edges GROUP BY token_address, source_wallet HAVING COUNT(DISTINCT recipient_wallet) >= 2
), sell_after AS MATERIALIZED (
  SELECT edge.token_address, edge.source_wallet, edge.recipient_wallet,
         MIN(edge.transfer_time) AS transfer_time,
         MIN(swap.block_number) AS first_sell_block,
         MIN(swap.block_time) AS first_sell_time
    FROM edges edge
    JOIN qualified cluster USING (token_address, source_wallet)
    JOIN robinhood_wallet_swaps swap
      ON swap.chain = $1 AND swap.token_address = edge.token_address
     AND swap.wallet_address = edge.recipient_wallet AND swap.side = 'sell'
     AND swap.block_number > edge.transfer_block
   GROUP BY edge.token_address, edge.source_wallet, edge.recipient_wallet
), bought AS MATERIALIZED (
  SELECT cluster.token_address, cluster.source_wallet,
         COALESCE(SUM(swap.token_amount_raw), 0)::text AS bought_before_distribution_raw
    FROM qualified cluster
    LEFT JOIN robinhood_wallet_swaps swap
      ON swap.chain = $1 AND swap.token_address = cluster.token_address
     AND swap.wallet_address = cluster.source_wallet AND swap.side = 'buy'
     AND swap.block_number BETWEEN cluster.buy_block AND cluster.first_transfer_block
   GROUP BY cluster.token_address, cluster.source_wallet
)
SELECT cluster.token_address, cluster.source_wallet,
       cluster.launch_block::text, cluster.launch_time,
       cluster.buy_block::text, cluster.buy_time,
       cluster.first_transfer_block::text, cluster.first_transfer_time,
       cluster.last_first_transfer_time, cluster.recipient_count,
       cluster.first_distributed_amount_raw,
       bought.bought_before_distribution_raw,
       COUNT(sell_after.recipient_wallet)::integer AS selling_recipient_count,
       MIN(sell_after.first_sell_time) AS first_recipient_sell_time,
       (COUNT(sell_after.recipient_wallet) FILTER (WHERE
          sell_after.first_sell_time <= sell_after.transfer_time + INTERVAL '1 minute'))::integer
         AS recipient_sells_within_1m,
       (COUNT(sell_after.recipient_wallet) FILTER (WHERE
          sell_after.first_sell_time <= sell_after.transfer_time + INTERVAL '5 minutes'))::integer
         AS recipient_sells_within_5m,
       (COUNT(sell_after.recipient_wallet) FILTER (WHERE
          sell_after.first_sell_time <= sell_after.transfer_time + INTERVAL '30 minutes'))::integer
         AS recipient_sells_within_30m,
       (COUNT(sell_after.recipient_wallet) FILTER (WHERE
          sell_after.first_sell_time <= sell_after.transfer_time + INTERVAL '2 hours'))::integer
         AS recipient_sells_within_2h
  FROM qualified cluster
  JOIN bought USING (token_address, source_wallet)
  LEFT JOIN sell_after USING (token_address, source_wallet)
 GROUP BY cluster.token_address, cluster.source_wallet, cluster.launch_block,
          cluster.launch_time, cluster.buy_block, cluster.buy_time,
          cluster.first_transfer_block, cluster.first_transfer_time,
          cluster.last_first_transfer_time, cluster.recipient_count,
          cluster.first_distributed_amount_raw, bought.bought_before_distribution_raw
 ORDER BY cluster.token_address, cluster.source_wallet`;

function integer(value, fallback, min, max, label) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} must be between ${min} and ${max}`);
  }
  return parsed;
}

function cursor(value) {
  const normalized = String(value || ZERO_ADDRESS).trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) throw new Error('afterToken is invalid');
  return normalized;
}

function row(item) {
  const bought = BigInt(item.bought_before_distribution_raw);
  const distributed = BigInt(item.first_distributed_amount_raw);
  const coverage = bought > 0n ? (distributed * 10_000n) / bought : null;
  return Object.freeze({
    tokenAddress: item.token_address, sourceWallet: item.source_wallet,
    launchBlock: String(item.launch_block), launchTime: new Date(item.launch_time).toISOString(),
    buyBlock: String(item.buy_block), buyTime: new Date(item.buy_time).toISOString(),
    firstTransferBlock: String(item.first_transfer_block),
    firstTransferTime: new Date(item.first_transfer_time).toISOString(),
    lastFirstTransferTime: new Date(item.last_first_transfer_time).toISOString(),
    recipientCount: Number(item.recipient_count),
    sellingRecipientCount: Number(item.selling_recipient_count),
    firstRecipientSellTime: item.first_recipient_sell_time
      ? new Date(item.first_recipient_sell_time).toISOString() : null,
    recipientSellCountsWithin: Object.freeze({
      lte_1m: Number(item.recipient_sells_within_1m),
      lte_5m: Number(item.recipient_sells_within_5m),
      lte_30m: Number(item.recipient_sells_within_30m),
      lte_2h: Number(item.recipient_sells_within_2h),
    }),
    firstDistributedAmountRaw: distributed.toString(),
    boughtBeforeDistributionRaw: bought.toString(),
    firstDistributionCoverageBps: coverage == null ? null
      : Number(coverage > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : coverage),
  });
}

function createRobinhoodBundleRedistributionCalibration(options = {}) {
  const database = options.database || db;
  const statementTimeoutMs = integer(
    options.statementTimeoutMs, 120_000, 1_000, 900_000, 'statementTimeoutMs'
  );
  const query = (sql, params) => (typeof database.queryWithStatementTimeout === 'function'
    ? database.queryWithStatementTimeout(sql, params, statementTimeoutMs)
    : database.query(sql, params));

  async function loadPage(input = {}) {
    const pageSize = integer(input.pageSize, 25, 1, MAX_PAGE_SIZE, 'pageSize');
    const afterToken = cursor(input.afterToken);
    const tokenResult = await query(TOKENS_SQL, [CHAIN, afterToken, pageSize]);
    const tokens = tokenResult.rows.map(({ token_address: tokenAddress }) => tokenAddress);
    const clusterResult = tokens.length
      ? await query(CLUSTERS_SQL, [
        CHAIN, PROJECTION_VERSION, JSON.stringify(tokens), ZERO_ADDRESS, DEAD_ADDRESS,
      ])
      : { rows: [] };
    return Object.freeze({
      afterToken, pageSize, tokens: Object.freeze(tokens),
      clusters: Object.freeze(clusterResult.rows.map(row)),
      nextToken: tokens.at(-1) || afterToken,
      exhausted: tokens.length < pageSize,
    });
  }

  return Object.freeze({ loadPage });
}

module.exports = {
  createRobinhoodBundleRedistributionCalibration,
  __private: { CLUSTERS_SQL, TOKENS_SQL, cursor, row },
};
