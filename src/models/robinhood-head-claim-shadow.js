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
        const legacy = await client.query(DECISION_SQL[stream].legacy, [snapshotAt, limit]);
        const state = await client.query(DECISION_SQL[stream].state, [snapshotAt, limit]);
        reports[stream] = compareDecisions(legacy.rows, state.rows);
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

  return Object.freeze({ auditClaimDecisions });
}

module.exports = {
  DECISION_SQL,
  compareDecisions,
  createRobinhoodHeadClaimShadowRepository,
};
