const db = require('./db');
const { POOL_LIQUIDITY_BATCH_SIZE } = require('../utils/robinhood-liquidity-limits');

const MAX_POSITION_CACHE_POOLS = 512;

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

function position(value, index) {
  const id = String(value?.id || '').trim();
  if (!id) throw new Error(`positions[${index}].id is required`);
  return {
    id,
    poolId: poolId(value.poolId),
    blockNumber: quantity(value.blockNumber, `positions[${index}].blockNumber`),
    logIndex: quantity(value.logIndex, `positions[${index}].logIndex`),
  };
}

function comparePosition(left, right) {
  const block = BigInt(left.blockNumber) - BigInt(right.blockNumber);
  if (block !== 0n) return block < 0n ? -1 : 1;
  const log = BigInt(left.logIndex) - BigInt(right.logIndex);
  return log < 0n ? -1 : log > 0n ? 1 : 0;
}

function snapshotRanges(state) {
  return [...state.values()]
    .filter(({ liquidityGross }) => liquidityGross > 0n)
    .sort((left, right) => left.tickLower - right.tickLower || left.tickUpper - right.tickUpper)
    .map(({ tickLower, tickUpper, liquidityGross }) => ({
      tick_lower: tickLower,
      tick_upper: tickUpper,
      liquidity_gross: liquidityGross.toString(),
    }));
}

function cloneRangeState(state) {
  return new Map([...state].map(([key, value]) => [key, { ...value }]));
}

function groupByPool(items) {
  const grouped = new Map();
  for (const item of items) {
    if (!grouped.has(item.poolId)) grouped.set(item.poolId, []);
    grouped.get(item.poolId).push(item);
  }
  return grouped;
}

function selectBaselines(requestsByPool, positionCache, maxPositionCachePools) {
  const baselines = new Map();
  for (const [requestedPoolId, requests] of requestsByPool) {
    requests.sort(comparePosition);
    if (maxPositionCachePools <= 0) continue;
    const cached = positionCache.get(requestedPoolId);
    if (!cached || comparePosition(cached.position, requests[0]) > 0) continue;
    positionCache.delete(requestedPoolId);
    positionCache.set(requestedPoolId, cached);
    baselines.set(requestedPoolId, cached);
  }
  return baselines;
}

function groupDeltaRows(rows) {
  const grouped = new Map();
  for (const row of rows) {
    if (row.row_kind !== 'delta') continue;
    if (!grouped.has(row.pool_id)) grouped.set(row.pool_id, []);
    grouped.get(row.pool_id).push({
      blockNumber: String(row.block_number),
      logIndex: String(row.log_index),
      tickLower: Number(row.tick_lower),
      tickUpper: Number(row.tick_upper),
      liquidityDelta: BigInt(row.liquidity_delta),
    });
  }
  return grouped;
}

function applyDelta(state, delta) {
  const key = `${delta.tickLower}:${delta.tickUpper}`;
  const current = state.get(key) || {
    tickLower: delta.tickLower, tickUpper: delta.tickUpper, liquidityGross: 0n,
  };
  current.liquidityGross += delta.liquidityDelta;
  state.set(key, current);
}

function createLiquidityHistoricalRangeRepository({
  database = db,
  maxPositionCachePools = 0,
} = {}) {
  const positionCache = new Map();

  function rememberPosition(requestedPoolId, value) {
    if (maxPositionCachePools <= 0) return;
    positionCache.delete(requestedPoolId);
    positionCache.set(requestedPoolId, value);
    while (positionCache.size > maxPositionCachePools) {
      positionCache.delete(positionCache.keys().next().value);
    }
  }

  async function listHistoricalV4LiquidityRangesAtPositions(input) {
    if (!Array.isArray(input) || input.length > 1000) {
      throw new RangeError('at most 1000 historical positions are allowed');
    }
    const positions = input.map(position);
    const ids = new Set();
    for (const item of positions) {
      if (ids.has(item.id)) throw new Error(`duplicate historical position id: ${item.id}`);
      ids.add(item.id);
    }
    if (!positions.length) return new Map();
    const requestsByPool = groupByPool(positions);
    const baselines = selectBaselines(
      requestsByPool, positionCache, maxPositionCachePools
    );
    const { rows } = await database.query(
      `WITH positions AS MATERIALIZED (
         SELECT * FROM jsonb_to_recordset($1::jsonb) AS item(
           id text, pool_id text, block_number bigint, log_index bigint
         )
       ), baselines AS MATERIALIZED (
         SELECT * FROM jsonb_to_recordset($2::jsonb) AS item(
           pool_id text, block_number bigint, log_index bigint
         )
       ), requested AS MATERIALIZED (
         SELECT DISTINCT pool_id FROM positions
       ), maxima AS MATERIALIZED (
         SELECT DISTINCT ON (pool_id) pool_id, block_number, log_index
         FROM positions ORDER BY pool_id, block_number DESC, log_index DESC
       ), ready AS MATERIALIZED (
         SELECT replay.chain
         FROM robinhood_v4_liquidity_replay_state replay
         JOIN robinhood_v4_liquidity_materialization_state materialized
           ON materialized.chain = replay.chain
         WHERE replay.chain = 'robinhood' AND replay.status = 'completed'
       ), result AS (
         SELECT 'availability'::text AS row_kind, requested.pool_id,
                ready.chain IS NOT NULL AS available,
                NULL::bigint AS block_number, NULL::bigint AS log_index,
                NULL::integer AS tick_lower, NULL::integer AS tick_upper,
                NULL::numeric AS liquidity_delta
         FROM requested LEFT JOIN ready ON TRUE
         UNION ALL
         SELECT 'delta', deltas.pool_id, TRUE, deltas.block_number, deltas.log_index,
                deltas.tick_lower, deltas.tick_upper, deltas.liquidity_delta
         FROM robinhood_v4_liquidity_deltas deltas
         JOIN maxima USING (pool_id)
         LEFT JOIN baselines baseline USING (pool_id)
         JOIN ready ON ready.chain = deltas.chain
         WHERE (deltas.block_number, deltas.log_index)
               < (maxima.block_number, maxima.log_index)
           AND (baseline.pool_id IS NULL OR
                (deltas.block_number, deltas.log_index)
                  >= (baseline.block_number, baseline.log_index))
       )
       SELECT * FROM result
       ORDER BY pool_id, block_number NULLS FIRST, log_index NULLS FIRST`,
      [JSON.stringify(positions.map((item) => ({
        id: item.id,
        pool_id: item.poolId,
        block_number: item.blockNumber,
        log_index: item.logIndex,
      }))), JSON.stringify([...baselines].map(([requestedPoolId, cached]) => ({
        pool_id: requestedPoolId,
        block_number: cached.position.blockNumber,
        log_index: cached.position.logIndex,
      })))]
    );
    const available = new Set(rows.filter((row) => (
      row.row_kind === 'availability' && row.available
    )).map((row) => row.pool_id));
    const deltasByPool = groupDeltaRows(rows);
    const result = new Map(positions.map(({ id }) => [id, null]));
    for (const [requestedPoolId, requests] of requestsByPool) {
      if (!available.has(requestedPoolId)) {
        positionCache.delete(requestedPoolId);
        continue;
      }
      const baseline = baselines.get(requestedPoolId);
      const state = baseline ? cloneRangeState(baseline.state) : new Map();
      const deltas = deltasByPool.get(requestedPoolId) || [];
      deltas.sort(comparePosition);
      let offset = 0;
      for (const request of requests) {
        while (offset < deltas.length && comparePosition(deltas[offset], request) < 0) {
          applyDelta(state, deltas[offset]);
          offset += 1;
        }
        result.set(request.id, snapshotRanges(state));
      }
      rememberPosition(requestedPoolId, {
        position: requests.at(-1),
        state: cloneRangeState(state),
      });
    }
    return result;
  }

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

  return {
    listHistoricalV4LiquidityRanges,
    listHistoricalV4LiquidityRangesAtPositions,
    listHistoricalV4LiquidityRangesByPoolIds,
  };
}

module.exports = { MAX_POSITION_CACHE_POOLS, createLiquidityHistoricalRangeRepository };
