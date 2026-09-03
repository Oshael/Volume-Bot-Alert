const db = require('./db');

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
    if (!Array.isArray(poolIds) || poolIds.length > 50) throw new RangeError('at most 50 pools are allowed');
    const ids = [...new Set(poolIds.map(poolId))];
    if (!ids.length) return new Map();
    const { rows } = await database.query(
      `WITH requested AS MATERIALIZED (SELECT DISTINCT UNNEST($1::text[]) AS pool_id)
       , replay AS MATERIALIZED (
         SELECT chain FROM robinhood_v4_liquidity_replay_state
         WHERE chain = 'robinhood' AND status = 'completed'
       ), ranges AS MATERIALIZED (
         SELECT delta.pool_id, delta.tick_lower, delta.tick_upper,
                SUM(delta.liquidity_delta) AS liquidity_gross
         FROM robinhood_v4_liquidity_deltas delta
         JOIN requested ON requested.pool_id = delta.pool_id
         JOIN replay ON replay.chain = delta.chain
         WHERE delta.chain = 'robinhood'
           AND (delta.block_number < $2 OR (delta.block_number = $2 AND delta.log_index < $3))
         GROUP BY delta.pool_id, delta.tick_lower, delta.tick_upper
         HAVING SUM(delta.liquidity_delta) > 0
       )
       SELECT requested.pool_id, replay.chain IS NOT NULL AS available,
              ranges.tick_lower, ranges.tick_upper, ranges.liquidity_gross
       FROM requested
       LEFT JOIN replay ON true
       LEFT JOIN ranges ON ranges.pool_id = requested.pool_id
       ORDER BY requested.pool_id, ranges.tick_lower, ranges.tick_upper`,
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
