const db = require('./db');
const { POOL_LIQUIDITY_BATCH_SIZE } = require('../utils/robinhood-liquidity-limits');

function quantity(value, label) {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/.test(raw) && !/^0x[0-9a-f]+$/i.test(raw)) throw new Error(`${label} is invalid`);
  return BigInt(raw).toString();
}

function poolId(value) {
  const id = String(value || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(id)) throw new Error('poolId must be 32 bytes');
  return id;
}

function createLiquidityHistoricalRangeRepository({ database = db } = {}) {
  async function listHistoricalV4LiquidityRangesByPoolIds(poolIds, blockNumber, logIndex) {
    if (!Array.isArray(poolIds) || poolIds.length > POOL_LIQUIDITY_BATCH_SIZE) {
      throw new RangeError(`at most ${POOL_LIQUIDITY_BATCH_SIZE} pools are allowed`);
    }
    const ids = [...new Set(poolIds.map(poolId))];
    if (!ids.length) return new Map();
    const { rows } = await database.query(
      `WITH requested AS MATERIALIZED (
         SELECT DISTINCT UNNEST($1::text[]) AS pool_id
       ), ready AS MATERIALIZED (
         SELECT replay.chain
           FROM robinhood_v4_liquidity_replay_state replay
           JOIN robinhood_v4_liquidity_materialization_state materialized
             ON materialized.chain = replay.chain
          WHERE replay.chain = 'robinhood' AND replay.status = 'completed'
       ), current_ranges AS MATERIALIZED (
         SELECT ranges.pool_id, ranges.tick_lower, ranges.tick_upper,
                ranges.liquidity_gross
           FROM robinhood_v4_liquidity_ranges ranges
           JOIN requested USING (pool_id)
           JOIN ready ON ready.chain = ranges.chain
       ), tail AS MATERIALIZED (
         SELECT deltas.pool_id, deltas.tick_lower, deltas.tick_upper,
                SUM(deltas.liquidity_delta) AS liquidity_delta
           FROM robinhood_v4_liquidity_deltas deltas
           JOIN requested USING (pool_id)
           JOIN ready ON ready.chain = deltas.chain
          WHERE (deltas.block_number, deltas.log_index) >= ($2::bigint, $3::bigint)
          GROUP BY deltas.pool_id, deltas.tick_lower, deltas.tick_upper
       ), range_keys AS MATERIALIZED (
         SELECT pool_id, tick_lower, tick_upper FROM current_ranges
         UNION
         SELECT pool_id, tick_lower, tick_upper FROM tail
       ), resolved AS (
         SELECT keys.pool_id, keys.tick_lower, keys.tick_upper,
                COALESCE(current_ranges.liquidity_gross, 0)
                  - COALESCE(tail.liquidity_delta, 0) AS liquidity_gross
           FROM range_keys keys
           LEFT JOIN current_ranges USING (pool_id, tick_lower, tick_upper)
           LEFT JOIN tail USING (pool_id, tick_lower, tick_upper)
       )
       SELECT requested.pool_id, ready.chain IS NOT NULL AS available,
              resolved.tick_lower, resolved.tick_upper, resolved.liquidity_gross
         FROM requested
         LEFT JOIN ready ON TRUE
         LEFT JOIN resolved
           ON resolved.pool_id = requested.pool_id AND resolved.liquidity_gross > 0
        ORDER BY requested.pool_id, resolved.tick_lower, resolved.tick_upper`,
      [ids, quantity(blockNumber, 'blockNumber'), quantity(logIndex, 'logIndex')]
    );
    const byPool = new Map(ids.map((id) => [id, null]));
    for (const row of rows) {
      if (!row.available) continue;
      if (byPool.get(row.pool_id) == null) byPool.set(row.pool_id, []);
      if (row.tick_lower != null) byPool.get(row.pool_id).push({
        tick_lower: row.tick_lower, tick_upper: row.tick_upper, liquidity_gross: row.liquidity_gross,
      });
    }
    return byPool;
  }

  async function listHistoricalV4LiquidityRanges(id, blockNumber, logIndex) {
    return (await listHistoricalV4LiquidityRangesByPoolIds([id], blockNumber, logIndex)).get(poolId(id));
  }

  return { listHistoricalV4LiquidityRanges, listHistoricalV4LiquidityRangesByPoolIds };
}

module.exports = { createLiquidityHistoricalRangeRepository };
