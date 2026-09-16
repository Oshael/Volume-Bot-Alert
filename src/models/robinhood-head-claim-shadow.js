'use strict';

const db = require('./db');

const CHAIN = 'robinhood';
const SOURCES = Object.freeze({
  legacy: 'robinhood_head_captures',
  state: 'robinhood_head_capture_states',
});

function positiveInt(value, label, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${label} must be between 1 and ${maximum}`);
  }
  return parsed;
}

function marketDecisionSql(sourceName) {
  const table = SOURCES[sourceName];
  if (!table) throw new Error('claim shadow source is invalid');
  return `/* head-claim-shadow:${sourceName}:market */
WITH RECURSIVE first_v4_by_pool AS (
  (
    SELECT capture.market_key, capture.transaction_hash, capture.log_index,
           capture.block_number, capture.transaction_index
      FROM ${table} capture
     WHERE capture.chain='${CHAIN}' AND capture.stream='market'
       AND capture.protocol='uniswap-v4' AND capture.market_key IS NOT NULL
       AND capture.processing_status IN ('pending', 'leased', 'blocked')
     ORDER BY capture.market_key, capture.block_number,
              capture.transaction_index, capture.log_index
     LIMIT 1
  )
  UNION ALL
  SELECT next_pool.market_key, next_pool.transaction_hash, next_pool.log_index,
         next_pool.block_number, next_pool.transaction_index
    FROM first_v4_by_pool current_pool
    CROSS JOIN LATERAL (
      SELECT capture.market_key, capture.transaction_hash, capture.log_index,
             capture.block_number, capture.transaction_index
        FROM ${table} capture
       WHERE capture.chain='${CHAIN}' AND capture.stream='market'
         AND capture.protocol='uniswap-v4'
         AND capture.processing_status IN ('pending', 'leased', 'blocked')
         AND capture.market_key > current_pool.market_key
       ORDER BY capture.market_key, capture.block_number,
                capture.transaction_index, capture.log_index
       LIMIT 1
    ) next_pool
), v4_claimable AS (
  SELECT capture.chain, capture.transaction_hash, capture.log_index,
         capture.block_number, capture.transaction_index,
         capture.protocol, capture.market_key
    FROM first_v4_by_pool first_v4
    JOIN ${table} capture
      ON capture.chain='${CHAIN}'
     AND capture.transaction_hash=first_v4.transaction_hash
     AND capture.log_index=first_v4.log_index
   WHERE capture.processing_status='pending' AND capture.next_attempt_at <= $1
   ORDER BY capture.block_number, capture.transaction_index, capture.log_index
   LIMIT $2
), independent_claimable AS (
  SELECT capture.chain, capture.transaction_hash, capture.log_index,
         capture.block_number, capture.transaction_index,
         capture.protocol, capture.market_key
    FROM ${table} capture
   WHERE capture.chain='${CHAIN}' AND capture.stream='market'
     AND capture.protocol IS DISTINCT FROM 'uniswap-v4'
     AND capture.processing_status='pending' AND capture.next_attempt_at <= $1
   ORDER BY capture.block_number, capture.transaction_index, capture.log_index
   LIMIT $2
)
SELECT * FROM (
  SELECT * FROM v4_claimable
  UNION ALL
  SELECT * FROM independent_claimable
) candidate
ORDER BY block_number, transaction_index, log_index
LIMIT $2`;
}

function discoveryDecisionSql(sourceName) {
  const table = SOURCES[sourceName];
  if (!table) throw new Error('claim shadow source is invalid');
  return `/* head-claim-shadow:${sourceName}:discovery */
SELECT capture.chain, capture.transaction_hash, capture.log_index,
       capture.block_number, capture.transaction_index,
       capture.protocol, capture.market_key
  FROM ${table} capture
 WHERE capture.chain='${CHAIN}' AND capture.stream='discovery'
   AND capture.processing_status='pending' AND capture.next_attempt_at <= $1
 ORDER BY capture.block_number, capture.transaction_index, capture.log_index
 LIMIT $2`;
}

const DECISION_SQL = Object.freeze({
  market: Object.freeze({
    legacy: marketDecisionSql('legacy'),
    state: marketDecisionSql('state'),
  }),
  discovery: Object.freeze({
    legacy: discoveryDecisionSql('legacy'),
    state: discoveryDecisionSql('state'),
  }),
});

function activeV4PoolsSql(sourceName) {
  const table = SOURCES[sourceName];
  if (!table) throw new Error('claim shadow source is invalid');
  return `/* head-claim-shadow:${sourceName}:v4-pools */
SELECT DISTINCT capture.market_key
  FROM ${table} capture
 WHERE capture.chain='${CHAIN}' AND capture.stream='market'
   AND capture.protocol='uniswap-v4' AND capture.market_key IS NOT NULL
   AND capture.processing_status IN ('pending', 'leased', 'blocked')
   AND ($2::text IS NULL OR capture.market_key > $2)
 ORDER BY capture.market_key
 LIMIT $1`;
}

function continuationDecisionSql(sourceName) {
  const table = SOURCES[sourceName];
  if (!table) throw new Error('claim shadow source is invalid');
  return `/* head-claim-shadow:${sourceName}:v4-continuation */
WITH requested AS MATERIALIZED (
  SELECT DISTINCT requested.market_key
    FROM unnest($2::text[]) AS requested(market_key)
), first_by_pool AS MATERIALIZED (
  SELECT first_capture.* FROM requested
  CROSS JOIN LATERAL (
    SELECT capture.transaction_hash, capture.log_index
      FROM ${table} capture
     WHERE capture.chain='${CHAIN}' AND capture.stream='market'
       AND capture.protocol='uniswap-v4'
       AND capture.market_key=requested.market_key
       AND capture.processing_status IN ('pending', 'leased', 'blocked')
     ORDER BY capture.block_number, capture.transaction_index, capture.log_index
     LIMIT 1
  ) first_capture
), ready_pools AS MATERIALIZED (
  SELECT capture.market_key FROM first_by_pool first_capture
  JOIN ${table} capture
    ON capture.chain='${CHAIN}'
   AND capture.transaction_hash=first_capture.transaction_hash
   AND capture.log_index=first_capture.log_index
 WHERE capture.processing_status='pending' AND capture.next_attempt_at <= $1
), bounded_by_pool AS MATERIALIZED (
  SELECT next_capture.* FROM ready_pools
  CROSS JOIN LATERAL (
    SELECT capture.chain, capture.market_key, capture.transaction_hash,
           capture.log_index, capture.block_number, capture.transaction_index,
           capture.protocol, capture.processing_status, capture.next_attempt_at
      FROM ${table} capture
     WHERE capture.chain='${CHAIN}' AND capture.stream='market'
       AND capture.protocol='uniswap-v4'
       AND capture.market_key=ready_pools.market_key
       AND capture.processing_status IN ('pending', 'leased', 'blocked')
     ORDER BY capture.block_number, capture.transaction_index, capture.log_index
     LIMIT LEAST(
       $4::int,
       GREATEST(1, CEIL($3::numeric / (SELECT COUNT(*) FROM requested))::int)
     )
  ) next_capture
), marked_prefix AS MATERIALIZED (
  SELECT bounded.*,
         BOOL_OR(
           bounded.processing_status <> 'pending'
           OR bounded.next_attempt_at > $1
         ) OVER pool_prefix AS blocked_prefix
    FROM bounded_by_pool bounded
  WINDOW pool_prefix AS (
    PARTITION BY bounded.market_key
    ORDER BY bounded.block_number, bounded.transaction_index, bounded.log_index
    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
  )
), prefix AS MATERIALIZED (
  SELECT * FROM marked_prefix WHERE NOT blocked_prefix
)
SELECT capture.chain, capture.transaction_hash, capture.log_index,
       capture.block_number, capture.transaction_index,
       capture.protocol, capture.market_key
  FROM prefix
  JOIN ${table} capture
    ON capture.chain='${CHAIN}'
   AND capture.transaction_hash=prefix.transaction_hash
   AND capture.log_index=prefix.log_index
 WHERE capture.processing_status='pending' AND capture.next_attempt_at <= $1
 ORDER BY capture.block_number, capture.transaction_index, capture.log_index
 LIMIT $3`;
}

const V4_CONTINUATION_SQL = Object.freeze({
  pools: Object.freeze({
    legacy: activeV4PoolsSql('legacy'),
    state: activeV4PoolsSql('state'),
  }),
  decisions: Object.freeze({
    legacy: continuationDecisionSql('legacy'),
    state: continuationDecisionSql('state'),
  }),
});

function normalizeDecision(row) {
  return {
    chain: String(row.chain),
    transactionHash: String(row.transaction_hash).toLowerCase(),
    logIndex: String(row.log_index),
    blockNumber: String(row.block_number),
    transactionIndex: String(row.transaction_index),
    protocol: row.protocol == null ? null : String(row.protocol),
    marketKey: row.market_key == null ? null : String(row.market_key),
  };
}

function compareDecisions(legacyRows, stateRows) {
  const legacy = legacyRows.map(normalizeDecision);
  const state = stateRows.map(normalizeDecision);
  const compared = Math.max(legacy.length, state.length);
  let firstMismatch = null;
  for (let index = 0; index < compared; index += 1) {
    if (JSON.stringify(legacy[index]) === JSON.stringify(state[index])) continue;
    firstMismatch = { index, legacy: legacy[index] || null, state: state[index] || null };
    break;
  }
  return {
    safe: firstMismatch == null,
    legacyCount: legacy.length,
    stateCount: state.length,
    firstMismatch,
  };
}

function comparePoolKeys(legacyRows, stateRows) {
  const normalize = (row) => String(row.market_key || '').toLowerCase();
  const legacy = legacyRows.map(normalize);
  const state = stateRows.map(normalize);
  const compared = Math.max(legacy.length, state.length);
  let firstMismatch = null;
  for (let index = 0; index < compared; index += 1) {
    if (legacy[index] === state[index]) continue;
    firstMismatch = { index, legacy: legacy[index] || null, state: state[index] || null };
    break;
  }
  return {
    safe: firstMismatch == null,
    legacyCount: legacy.length,
    stateCount: state.length,
    firstMismatch,
  };
}

async function timedQuery(client, label, sql, params) {
  const startedAt = process.hrtime.bigint();
  try {
    const result = await client.query(sql, params);
    const elapsed = Number(process.hrtime.bigint() - startedAt) / 1e6;
    return { rows: result.rows, ms: Math.round(elapsed * 100) / 100 };
  } catch (error) {
    error.message = `${label}: ${error.message}`;
    throw error;
  }
}

function createRobinhoodHeadClaimShadowRepository(options = {}) {
  const database = options.database || db;

  async function auditClaimDecisions(input = {}) {
    const limit = positiveInt(input.limit || 2000, 'limit', 5000);
    const statementTimeoutMs = positiveInt(
      input.statementTimeoutMs || 30_000, 'statementTimeoutMs', 120_000
    );
    const client = await database.getClient();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SET LOCAL lock_timeout = '1s'");
      await client.query("SELECT set_config('statement_timeout', $1, true)", [
        `${statementTimeoutMs}ms`,
      ]);
      const snapshot = await client.query('SELECT transaction_timestamp() AS snapshot_at');
      const snapshotAt = snapshot.rows[0].snapshot_at;
      const reports = {};
      for (const stream of ['market', 'discovery']) {
        const legacy = await timedQuery(
          client, `legacy:${stream}`, DECISION_SQL[stream].legacy, [snapshotAt, limit]
        );
        const state = await timedQuery(
          client, `state:${stream}`, DECISION_SQL[stream].state, [snapshotAt, limit]
        );
        reports[stream] = {
          ...compareDecisions(legacy.rows, state.rows),
          legacyMs: legacy.ms,
          stateMs: state.ms,
        };
      }
      await client.query('COMMIT');
      return {
        safe: Object.values(reports).every((report) => report.safe),
        snapshotAt: new Date(snapshotAt).toISOString(),
        limit,
        streams: reports,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function auditV4ContinuationDecisions(input = {}) {
    const poolLimit = positiveInt(input.poolLimit || 8, 'poolLimit', 64);
    const limit = positiveInt(input.limit || 2000, 'limit', 5000);
    const perPoolLimit = positiveInt(input.perPoolLimit || 512, 'perPoolLimit', 2000);
    const statementTimeoutMs = positiveInt(
      input.statementTimeoutMs || 30_000, 'statementTimeoutMs', 120_000
    );
    const afterMarketKey = input.afterMarketKey == null
      ? null : String(input.afterMarketKey).trim().toLowerCase();
    if (afterMarketKey != null && (!afterMarketKey || afterMarketKey.length > 256)) {
      throw new Error('afterMarketKey is invalid');
    }
    const client = await database.getClient();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SET LOCAL lock_timeout = '1s'");
      await client.query("SELECT set_config('statement_timeout', $1, true)", [
        `${statementTimeoutMs}ms`,
      ]);
      const snapshot = await client.query('SELECT transaction_timestamp() AS snapshot_at');
      const snapshotAt = snapshot.rows[0].snapshot_at;
      const legacyPools = await timedQuery(
        client, 'legacy:v4-pools', V4_CONTINUATION_SQL.pools.legacy,
        [poolLimit, afterMarketKey]
      );
      const statePools = await timedQuery(
        client, 'state:v4-pools', V4_CONTINUATION_SQL.pools.state,
        [poolLimit, afterMarketKey]
      );
      const marketKeys = [...new Set([
        ...legacyPools.rows.map((row) => row.market_key),
        ...statePools.rows.map((row) => row.market_key),
      ])].sort().slice(0, poolLimit);
      const params = [snapshotAt, marketKeys, limit, perPoolLimit];
      const legacy = await timedQuery(
        client, 'legacy:v4-continuation', V4_CONTINUATION_SQL.decisions.legacy, params
      );
      const state = await timedQuery(
        client, 'state:v4-continuation', V4_CONTINUATION_SQL.decisions.state, params
      );
      const pools = {
        ...comparePoolKeys(legacyPools.rows, statePools.rows),
        legacyMs: legacyPools.ms,
        stateMs: statePools.ms,
      };
      const decisions = {
        ...compareDecisions(legacy.rows, state.rows),
        legacyMs: legacy.ms,
        stateMs: state.ms,
      };
      await client.query('COMMIT');
      return {
        safe: pools.safe && decisions.safe,
        snapshotAt: new Date(snapshotAt).toISOString(),
        poolLimit,
        afterMarketKey,
        nextMarketKey: marketKeys.at(-1) || afterMarketKey,
        complete: marketKeys.length < poolLimit,
        requestedPoolCount: marketKeys.length,
        limit,
        perPoolLimit,
        pools,
        decisions,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  return Object.freeze({ auditClaimDecisions, auditV4ContinuationDecisions });
}

module.exports = {
  DECISION_SQL,
  V4_CONTINUATION_SQL,
  compareDecisions,
  comparePoolKeys,
  createRobinhoodHeadClaimShadowRepository,
};
