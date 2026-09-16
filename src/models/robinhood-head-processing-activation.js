'use strict';

const db = require('./db');
const {
  AUTHORITY_LOCK_KEY, inspectStateRuntimePrerequisites, loadHeadProcessingAuthority,
} = require('./robinhood-head-processing-authority');
const { FUNCTION_NAME, TRIGGER_NAME } = require('../utils/db-init-stage224');

const STOPPED_LEASE_KEYS = Object.freeze([
  'robinhood-ingestion-worker',
  'robinhood-head-capture-worker',
  'robinhood-canonical-head-worker',
  'robinhood-processing-worker',
  'robinhood-retention-worker',
  'robinhood-derived-worker',
  'robinhood-wallet-swap-live-worker',
]);
const REPAIR_LOCK_KEYS = Object.freeze([
  'robinhood-processing-blocked-recovery',
  'robinhood-v4-liquidity-materialization',
  'robinhood:v3-pruned-capture-repair',
]);

const PARITY_SQL = `WITH payload AS MATERIALIZED (
  SELECT * FROM robinhood_head_captures
   WHERE chain='robinhood' AND processing_status IN ('pending','leased','blocked')
), state AS MATERIALIZED (
  SELECT * FROM robinhood_head_capture_states
   WHERE chain='robinhood' AND processing_status IN ('pending','leased','blocked')
), compared AS (
  SELECT payload.transaction_hash AS payload_hash, state.transaction_hash AS state_hash,
         payload.processing_status AS payload_status, state.processing_status AS state_status,
         state.stream AS state_stream, state.protocol AS state_protocol,
         state.market_key AS state_market_key, state.block_number AS state_block_number,
         state.transaction_index AS state_transaction_index,
         ROW(payload.stream,payload.protocol,payload.market_key,payload.block_number,
             payload.transaction_index,payload.processing_status,payload.lease_owner,
             payload.lease_until,payload.attempt_count,payload.next_attempt_at,
             payload.last_error,payload.terminal_at,payload.retention_eligible_at)
           IS DISTINCT FROM
         ROW(state.stream,state.protocol,state.market_key,state.block_number,
             state.transaction_index,state.processing_status,state.lease_owner,
             state.lease_until,state.attempt_count,state.next_attempt_at,
             state.last_error,state.terminal_at,state.retention_eligible_at) AS divergent
    FROM payload FULL JOIN state USING (chain, transaction_hash, log_index)
)
SELECT COUNT(*) FILTER (WHERE payload_hash IS NOT NULL)::int AS payload_active,
       COUNT(*) FILTER (WHERE state_hash IS NOT NULL)::int AS state_active,
       COUNT(*) FILTER (WHERE payload_hash IS NOT NULL AND state_hash IS NULL)::int AS missing_state,
       COUNT(*) FILTER (WHERE payload_hash IS NULL AND state_hash IS NOT NULL)::int AS excess_state,
       COUNT(*) FILTER (WHERE payload_hash IS NOT NULL AND state_hash IS NOT NULL AND divergent)::int
         AS divergent,
       COUNT(*) FILTER (WHERE state_hash IS NOT NULL AND (state_stream IS NULL
         OR state_protocol IS NULL OR state_block_number IS NULL OR state_transaction_index IS NULL
         OR (state_protocol='uniswap-v4' AND state_market_key IS NULL)))::int AS incomplete_state,
       COUNT(*) FILTER (WHERE payload_status='leased')::int AS payload_leased,
       COUNT(*) FILTER (WHERE state_status='leased')::int AS state_leased
  FROM compared`;

async function inspectActivation(client) {
  const authority = await loadHeadProcessingAuthority(client);
  const gate = await inspectStateRuntimePrerequisites(client, { triggerMode: 'full-mirror' });
  const leases = await client.query(
    `SELECT COALESCE(array_agg(lease_key ORDER BY lease_key), '{}') AS active
       FROM worker_leases WHERE lease_key=ANY($1::text[]) AND lease_until>clock_timestamp()`,
    [STOPPED_LEASE_KEYS]
  );
  const parity = await client.query(PARITY_SQL);
  const activeLeases = leases.rows[0]?.active || [];
  const counts = Object.fromEntries(Object.entries(parity.rows[0] || {})
    .map(([key, value]) => [key, Number(value || 0)]));
  const blockers = [...gate.blockers];
  if (authority.authority !== 'legacy') blockers.push(`authority is ${authority.authority}`);
  if (activeLeases.length) blockers.push(`active worker leases: ${activeLeases.join(', ')}`);
  for (const key of ['missing_state', 'excess_state', 'divergent', 'incomplete_state',
    'payload_leased', 'state_leased']) {
    if (counts[key]) blockers.push(`${key}=${counts[key]}`);
  }
  return { safe: blockers.length === 0, authority, activeLeases, counts, blockers };
}

async function activateHeadProcessingState(options = {}) {
  const database = options.database || db;
  const client = await database.getClient();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout='${options.lockTimeoutMs || 5000}ms';
      SET LOCAL statement_timeout='${options.statementTimeoutMs || 300000}ms'`);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [AUTHORITY_LOCK_KEY]);
    for (const key of REPAIR_LOCK_KEYS) {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
    }
    await client.query(`LOCK TABLE robinhood_head_captures, robinhood_head_capture_states
      IN SHARE ROW EXCLUSIVE MODE`);
    const report = await inspectActivation(client);
    if (!report.safe) {
      const error = new Error(`State authority activation blocked: ${report.blockers.join('; ')}`);
      error.report = report;
      throw error;
    }
    await client.query(`DROP TRIGGER ${TRIGGER_NAME} ON robinhood_head_captures`);
    await client.query(`CREATE TRIGGER ${TRIGGER_NAME} AFTER INSERT ON robinhood_head_captures
      FOR EACH ROW EXECUTE FUNCTION ${FUNCTION_NAME}()`);
    const runtimeGate = await inspectStateRuntimePrerequisites(client);
    if (!runtimeGate.safe) throw new Error(`Post-switch runtime gate failed: ${runtimeGate.blockers.join('; ')}`);
    const activated = await client.query(`UPDATE robinhood_head_processing_authority
      SET authority='state', generation=generation+1, activated_at=clock_timestamp(),
          activation_report=$1::jsonb, updated_at=clock_timestamp()
      WHERE chain='robinhood' AND authority='legacy'
      RETURNING authority, generation, activated_at`, [JSON.stringify(report)]);
    if (activated.rowCount !== 1) throw new Error('Head processing authority changed during activation');
    await client.query('COMMIT');
    return { safe: true, activated: true, authority: activated.rows[0], report };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function previewHeadProcessingActivation(options = {}) {
  const database = options.database || db;
  const client = await database.getClient();
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const report = await inspectActivation(client);
    await client.query('COMMIT');
    return report;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  PARITY_SQL, REPAIR_LOCK_KEYS, STOPPED_LEASE_KEYS, activateHeadProcessingState,
  inspectActivation, previewHeadProcessingActivation,
};
