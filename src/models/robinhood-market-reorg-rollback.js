'use strict';

const { createRobinhoodMarketAggregateRepository } = require('./robinhood-market-aggregate');

const CHAIN = 'robinhood';
const MINUTE_GRANULARITIES = Object.freeze([5, 15, 30]);
const HOURLY_GRANULARITIES = Object.freeze([60, 240, 1440]);

function block(value, label) {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/.test(raw)) throw new Error(`${label} is invalid`);
  return BigInt(raw).toString();
}

const CAPTURE_TARGETS_SQL = Object.freeze([
  `CREATE TEMP TABLE rh_reorg_market_logs ON COMMIT DROP AS
   SELECT processed.transaction_hash, processed.log_index, processed.block_number,
          processed.block_hash
     FROM robinhood_processed_logs processed
     INNER JOIN robinhood_chain_blocks block
       ON block.chain=processed.chain AND block.block_hash=processed.block_hash
      AND block.block_number=processed.block_number AND block.canonical=TRUE
    WHERE processed.chain=$1 AND processed.stream='market'
      AND processed.block_number BETWEEN $2::bigint AND $3::bigint`,
  'CREATE UNIQUE INDEX ON rh_reorg_market_logs(transaction_hash, log_index)',
  `CREATE TEMP TABLE rh_reorg_market_minutes ON COMMIT DROP AS
   SELECT DISTINCT observation.protocol, observation.market_key,
          observation.token_address, observation.quote_address,
          date_trunc('minute', observation.observed_at) AS bucket_ts
     FROM robinhood_market_observations observation
     INNER JOIN rh_reorg_market_logs orphan USING (transaction_hash, log_index)
    WHERE observation.chain='robinhood' AND observation.status='accepted'`,
  'CREATE UNIQUE INDEX ON rh_reorg_market_minutes(protocol, market_key, bucket_ts)',
]);

const REBUILD_MINUTES_SQL = `WITH deleted AS (
    DELETE FROM robinhood_market_buckets_1m bucket
     USING rh_reorg_market_minutes target
     WHERE bucket.chain=$1 AND bucket.protocol=target.protocol
       AND bucket.market_key=target.market_key AND bucket.bucket_ts=target.bucket_ts
     RETURNING 1
  ), rebuilt AS (
    INSERT INTO robinhood_market_buckets_1m (
      chain, protocol, market_key, token_address, quote_address, bucket_ts,
      open_price_usd, high_price_usd, low_price_usd, close_price_usd,
      open_fdv_usd, high_fdv_usd, low_fdv_usd, close_fdv_usd,
      close_liquidity_usd, close_liquidity_raw, close_liquidity_status,
      close_liquidity_confidence, close_liquidity_warning,
      volume_usd, swaps, buys, sells, transactions, first_observed_at,
      first_block_number, first_log_index, last_observed_at, last_block_number,
      last_log_index, expires_at
    )
    SELECT observation.chain, observation.protocol, observation.market_key,
      observation.token_address, observation.quote_address, target.bucket_ts,
      (array_agg(price_usd ORDER BY observation.block_number, observation.log_index))[1],
      MAX(price_usd), MIN(price_usd), (array_agg(price_usd ORDER BY
        observation.block_number DESC, observation.log_index DESC))[1],
      (array_agg(fdv_usd ORDER BY observation.block_number, observation.log_index))[1],
      MAX(fdv_usd), MIN(fdv_usd), (array_agg(fdv_usd ORDER BY
        observation.block_number DESC, observation.log_index DESC))[1],
      (array_agg(liquidity_usd ORDER BY
        observation.block_number DESC, observation.log_index DESC))[1],
      (array_agg(liquidity_raw ORDER BY
        observation.block_number DESC, observation.log_index DESC))[1],
      (array_agg(liquidity_status ORDER BY
        observation.block_number DESC, observation.log_index DESC))[1],
      (array_agg(liquidity_confidence ORDER BY
        observation.block_number DESC, observation.log_index DESC))[1],
      (array_agg(liquidity_warning ORDER BY
        observation.block_number DESC, observation.log_index DESC))[1],
      SUM(volume_usd), COUNT(*)::bigint, COUNT(*) FILTER (WHERE side='buy'),
      COUNT(*) FILTER (WHERE side='sell'),
      COUNT(DISTINCT observation.transaction_hash)::bigint,
      (array_agg(observed_at ORDER BY
        observation.block_number, observation.log_index))[1],
      MIN(observation.block_number), (array_agg(observation.log_index ORDER BY
        observation.block_number, observation.log_index))[1],
      (array_agg(observed_at ORDER BY
        observation.block_number DESC, observation.log_index DESC))[1],
      MAX(observation.block_number), (array_agg(observation.log_index ORDER BY
        observation.block_number DESC, observation.log_index DESC))[1],
      target.bucket_ts + INTERVAL '14 days'
    FROM rh_reorg_market_minutes target
    INNER JOIN robinhood_market_observations observation
      ON observation.chain=$1 AND observation.protocol=target.protocol
     AND observation.market_key=target.market_key
     AND date_trunc('minute', observation.observed_at)=target.bucket_ts
     AND observation.status='accepted'
    INNER JOIN robinhood_processed_logs processed
      ON processed.chain=observation.chain
     AND processed.transaction_hash=observation.transaction_hash
     AND processed.log_index=observation.log_index
    INNER JOIN robinhood_chain_blocks block
      ON block.chain=processed.chain AND block.block_hash=processed.block_hash
     AND block.block_number=processed.block_number AND block.canonical=TRUE
    GROUP BY observation.chain, observation.protocol, observation.market_key,
      observation.token_address, observation.quote_address, target.bucket_ts
    RETURNING 1
  ) SELECT (SELECT COUNT(*)::int FROM deleted) AS deleted,
           (SELECT COUNT(*)::int FROM rebuilt) AS rebuilt`;

function count(row, key) { return Number(row?.[key] || 0); }

function createRobinhoodMarketReorgRollback(options = {}) {
  const aggregateFactory = options.aggregateFactory || createRobinhoodMarketAggregateRepository;

  async function rollback(client, input = {}) {
    if (!client || typeof client.query !== 'function') {
      throw new Error('transactional market rollback client is required');
    }
    const fromBlock = block(input.fromBlock, 'market rollback fromBlock');
    const throughBlock = block(input.throughBlock, 'market rollback throughBlock');
    if (BigInt(fromBlock) > BigInt(throughBlock)) throw new Error('market rollback range is inverted');
    await client.query(CAPTURE_TARGETS_SQL[0], [CHAIN, fromBlock, throughBlock]);
    for (const sql of CAPTURE_TARGETS_SQL.slice(1)) await client.query(sql);
    const bounds = (await client.query(
      `SELECT token_address, MIN(bucket_ts) AS minute_from,
              MAX(bucket_ts) + INTERVAL '24 hours' AS minute_to,
              date_trunc('hour', MIN(bucket_ts)) AS hour_from,
              date_trunc('hour', MAX(bucket_ts)) + INTERVAL '1 hour' AS hour_rebuild_to,
              date_trunc('hour', MAX(bucket_ts)) + INTERVAL '24 hours' AS hour_aggregate_to
         FROM rh_reorg_market_minutes GROUP BY token_address ORDER BY token_address`
    )).rows;
    const derived = await client.query(
      `DELETE FROM robinhood_derived_outbox outbox USING rh_reorg_market_minutes target
        WHERE outbox.chain=$1 AND outbox.protocol=target.protocol
          AND outbox.market_key=target.market_key AND outbox.bucket_ts=target.bucket_ts
          AND outbox.last_block_number BETWEEN $2::bigint AND $3::bigint`,
      [CHAIN, fromBlock, throughBlock]
    );
    const logs = await client.query(
      `DELETE FROM robinhood_processed_logs processed USING rh_reorg_market_logs orphan
        WHERE processed.chain=$1 AND processed.transaction_hash=orphan.transaction_hash
          AND processed.log_index=orphan.log_index`, [CHAIN]
    );
    const minutes = (await client.query(REBUILD_MINUTES_SQL, [CHAIN])).rows[0];
    const hoursDeleted = await client.query(
      `DELETE FROM robinhood_market_buckets_1h bucket USING rh_reorg_market_minutes target
        WHERE bucket.chain=$1 AND bucket.protocol=target.protocol
          AND bucket.market_key=target.market_key
          AND bucket.bucket_ts=date_trunc('hour', target.bucket_ts)`, [CHAIN]
    );
    const aggregatesDeleted = await client.query(
      `DELETE FROM robinhood_market_buckets_agg bucket USING rh_reorg_market_minutes target
        CROSS JOIN unnest(ARRAY[5,15,30,60,240,1440]::smallint[]) granularity
        WHERE bucket.chain=$1 AND bucket.token_address=target.token_address
          AND bucket.granularity_minutes=granularity
          AND bucket.bucket_ts=date_bin(
            granularity * INTERVAL '1 minute', target.bucket_ts,
            TIMESTAMPTZ '1970-01-01 00:00:00+00')`, [CHAIN]
    );
    const aggregate = aggregateFactory(client);
    let hourlyWritten = 0; let aggregateWritten = 0; let aggregateRemoved = 0;
    for (const target of bounds) {
      const hourly = await aggregate.refreshHourlyRange({
        from: target.hour_from, to: target.hour_rebuild_to,
        tokenAddress: target.token_address,
        afterToken: null, tokenLimit: 1,
      });
      hourlyWritten += hourly.writtenBuckets;
      for (const [from, to, granularities] of [
        [target.minute_from, target.minute_to, MINUTE_GRANULARITIES],
        [target.hour_from, target.hour_aggregate_to, HOURLY_GRANULARITIES],
      ]) {
        const refreshed = await aggregate.refreshAggregateRange({
          from, to, granularities, tokenAddress: target.token_address,
          afterToken: null, tokenLimit: 1,
        });
        aggregateWritten += refreshed.writtenBuckets;
        aggregateRemoved += refreshed.deletedBuckets;
      }
    }
    return {
      affectedTokens: bounds.length, deletedProcessedLogs: logs.rowCount || 0,
      deletedDerivedRows: derived.rowCount || 0, deletedMinuteBuckets: count(minutes, 'deleted'),
      rebuiltMinuteBuckets: count(minutes, 'rebuilt'), deletedHourBuckets: hoursDeleted.rowCount || 0,
      rebuiltHourBuckets: hourlyWritten, deletedAggregateBuckets: aggregatesDeleted.rowCount || 0,
      rebuiltAggregateBuckets: aggregateWritten, removedEmptyAggregateBuckets: aggregateRemoved,
    };
  }

  return Object.freeze({ rollback });
}

module.exports = { createRobinhoodMarketReorgRollback, __private: { CAPTURE_TARGETS_SQL, REBUILD_MINUTES_SQL } };
