'use strict';

const db = require('./db');
const { BLOCKED_RECOVERY_ERROR } = require('./robinhood-head-processing');

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

function optionalBlock(value) {
  if (value == null || value === '') return null;
  const block = String(value).trim();
  if (!/^\d+$/.test(block)) throw new Error('throughBlock must be a non-negative integer');
  return block;
}

function sourceSql(builder) {
  return Object.freeze({
    legacy: builder(SOURCES.legacy, 'legacy'),
    state: builder(SOURCES.state, 'state'),
  });
}

const WATERMARK_SQL = sourceSql((table, source) => `/* head-lifecycle-shadow:${source}:watermark */
SELECT MIN(block_number) FILTER (
         WHERE processing_status IN ('pending', 'leased', 'blocked')
       ) AS pending_block,
       COUNT(*) FILTER (WHERE processing_status='pending') AS pending,
       COUNT(*) FILTER (WHERE processing_status='leased') AS leased,
       COUNT(*) FILTER (WHERE processing_status='blocked') AS blocked
  FROM ${table}
 WHERE chain='${CHAIN}' AND stream=$1
   AND processing_status IN ('pending', 'leased', 'blocked')`);

const FRONTIER_SQL = sourceSql((table, source) => `/* head-lifecycle-shadow:${source}:frontier */
WITH leased AS MATERIALIZED (
  SELECT chain, transaction_hash, log_index, block_number, transaction_index
    FROM ${table}
   WHERE chain='${CHAIN}' AND stream=$1 AND processing_status='leased'
), active AS (
  (SELECT chain, transaction_hash, log_index, block_number, transaction_index
     FROM ${table}
    WHERE chain='${CHAIN}' AND stream=$1 AND processing_status='pending'
    ORDER BY block_number, transaction_index, log_index
    LIMIT 1)
  UNION ALL
  (SELECT chain, transaction_hash, log_index, block_number, transaction_index
     FROM leased
    ORDER BY block_number, transaction_index, log_index
    LIMIT 1)
), selected AS (
  SELECT * FROM active
  ORDER BY block_number, transaction_index, log_index
  LIMIT 1
)
SELECT selected.chain, selected.transaction_hash, selected.log_index,
       selected.block_number, selected.transaction_index,
       payload.evidence->>'timestampMs' AS timestamp_ms
  FROM selected
  JOIN robinhood_head_captures payload
    USING (chain, transaction_hash, log_index)`);

const RECOVERY_SQL = sourceSql((table, source) => `/* head-lifecycle-shadow:${source}:recovery */
SELECT chain, transaction_hash, log_index, block_number, transaction_index,
       processing_status, last_error
  FROM ${table}
 WHERE chain='${CHAIN}' AND stream='market'
   AND processing_status='blocked' AND last_error=$1
   AND ($2::bigint IS NULL OR block_number <= $2::bigint)
 ORDER BY block_number, transaction_index, log_index
 LIMIT ($3::int + 1)`);

const RETENTION_SQL = Object.freeze({
  legacy: `/* head-lifecycle-shadow:legacy:retention */
SELECT retention_eligible_at
  FROM ${SOURCES.legacy}
 WHERE chain='${CHAIN}' AND processing_status IN ('processed', 'rejected')
   AND terminal_at <= $1::timestamptz - INTERVAL '3 days'
   AND retention_eligible_at IS NOT NULL
   AND retention_eligible_at <= $1::timestamptz
 ORDER BY retention_eligible_at
 LIMIT $2`,
  state: `/* head-lifecycle-shadow:state:retention */
SELECT retention_eligible_at
  FROM ${SOURCES.state}
 WHERE terminal_at <= $1::timestamptz - INTERVAL '3 days'
   AND retention_eligible_at IS NOT NULL
   AND retention_eligible_at <= $1::timestamptz
 ORDER BY retention_eligible_at
 LIMIT $2`,
});

const AUXILIARY_SQL = Object.freeze({
  watermark: WATERMARK_SQL,
  frontier: FRONTIER_SQL,
  recovery: RECOVERY_SQL,
  retention: RETENTION_SQL,
});

function iso(value) {
  return value == null ? null : new Date(value).toISOString();
}

function normalizeWatermark(row = {}) {
  return {
    pendingBlock: row.pending_block == null ? null : String(row.pending_block),
    pending: Number(row.pending || 0),
    leased: Number(row.leased || 0),
    blocked: Number(row.blocked || 0),
  };
}

function normalizeLifecycleRow(row = {}) {
  return {
    chain: String(row.chain),
    transactionHash: String(row.transaction_hash).toLowerCase(),
    logIndex: String(row.log_index),
    blockNumber: String(row.block_number),
    transactionIndex: String(row.transaction_index),
    processingStatus: row.processing_status == null ? null : String(row.processing_status),
    lastError: row.last_error == null ? null : String(row.last_error),
    terminalAt: iso(row.terminal_at),
    retentionEligibleAt: iso(row.retention_eligible_at),
    timestampMs: row.timestamp_ms == null ? null : String(row.timestamp_ms),
  };
}

function normalizeRetentionRow(row = {}) {
  return {
    retentionEligibleAt: iso(row.retention_eligible_at),
  };
}

function compareValues(legacyValues, stateValues, normalize) {
  const legacy = legacyValues.map(normalize);
  const state = stateValues.map(normalize);
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

function reportPair(legacy, state, normalize) {
  return {
    ...compareValues(legacy.rows, state.rows, normalize),
    legacyMs: legacy.ms,
    stateMs: state.ms,
  };
}

function createRobinhoodHeadLifecycleShadowRepository(options = {}) {
  const database = options.database || db;

  async function auditAuxiliaryReads(input = {}) {
    const limit = positiveInt(input.limit || 2000, 'limit', 5000);
    const statementTimeoutMs = positiveInt(
      input.statementTimeoutMs || 120_000, 'statementTimeoutMs', 300_000
    );
    const throughBlock = optionalBlock(input.throughBlock);
    const client = await database.getClient();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query("SET LOCAL lock_timeout = '1s'");
      await client.query("SELECT set_config('statement_timeout', $1, true)", [
        `${statementTimeoutMs}ms`,
      ]);
      const snapshot = await client.query('SELECT transaction_timestamp() AS snapshot_at');
      const snapshotAt = snapshot.rows[0].snapshot_at;
      const streams = {};
      for (const stream of ['market', 'discovery']) {
        const legacyWatermark = await timedQuery(
          client, `legacy:${stream}:watermark`, WATERMARK_SQL.legacy, [stream]
        );
        const stateWatermark = await timedQuery(
          client, `state:${stream}:watermark`, WATERMARK_SQL.state, [stream]
        );
        const legacyFrontier = await timedQuery(
          client, `legacy:${stream}:frontier`, FRONTIER_SQL.legacy, [stream]
        );
        const stateFrontier = await timedQuery(
          client, `state:${stream}:frontier`, FRONTIER_SQL.state, [stream]
        );
        streams[stream] = {
          watermark: reportPair(
            legacyWatermark, stateWatermark, normalizeWatermark
          ),
          frontier: reportPair(
            legacyFrontier, stateFrontier, normalizeLifecycleRow
          ),
        };
      }
      const recoveryParams = [BLOCKED_RECOVERY_ERROR, throughBlock, limit];
      const legacyRecovery = await timedQuery(
        client, 'legacy:recovery', RECOVERY_SQL.legacy, recoveryParams
      );
      const stateRecovery = await timedQuery(
        client, 'state:recovery', RECOVERY_SQL.state, recoveryParams
      );
      const retentionParams = [snapshotAt, limit];
      const legacyRetention = await timedQuery(
        client, 'legacy:retention', RETENTION_SQL.legacy, retentionParams
      );
      const stateRetention = await timedQuery(
        client, 'state:retention', RETENTION_SQL.state, retentionParams
      );
      const recovery = reportPair(legacyRecovery, stateRecovery, normalizeLifecycleRow);
      const retention = reportPair(legacyRetention, stateRetention, normalizeRetentionRow);
      await client.query('COMMIT');
      const streamReports = Object.values(streams).flatMap((entry) => Object.values(entry));
      return {
        safe: [...streamReports, recovery, retention].every((report) => report.safe),
        snapshotAt: new Date(snapshotAt).toISOString(),
        limit,
        throughBlock,
        streams,
        recovery,
        retention,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  return Object.freeze({ auditAuxiliaryReads });
}

module.exports = {
  AUXILIARY_SQL,
  compareValues,
  createRobinhoodHeadLifecycleShadowRepository,
  normalizeLifecycleRow,
  normalizeRetentionRow,
  normalizeWatermark,
};
