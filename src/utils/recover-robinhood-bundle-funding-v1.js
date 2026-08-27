require('dotenv').config();

const db = require('../models/db');

const CONFIRM_FLAG = '--confirm-reset-all-ranges';
const EVIDENCE_V1 = 'rh_native_funding_v1';
const EVIDENCE_V2 = 'rh_native_funding_v2';
const LOCK_ID = 4_663_169;

const INSPECT_SQL = `SELECT run.id::text, run.status, run.evidence_version,
  run.range_count::integer, run.candidate_count::integer,
  COUNT(range.range_index)::integer AS total_ranges,
  COUNT(*) FILTER (WHERE range.status = 'pending')::integer AS pending,
  COUNT(*) FILTER (WHERE range.status = 'leased')::integer AS leased,
  COUNT(*) FILTER (WHERE range.status = 'leased'
    AND range.lease_until > NOW())::integer AS active_leases,
  COUNT(*) FILTER (WHERE range.status = 'completed')::integer AS completed,
  COUNT(*) FILTER (WHERE range.status = 'failed')::integer AS failed,
  (SELECT COUNT(*)::integer FROM robinhood_bundle_funding_evidence evidence
    WHERE evidence.chain = 'robinhood' AND evidence.run_id = run.id) AS scoped_evidence_rows,
  EXISTS (SELECT 1 FROM robinhood_native_funding_edges edge
    WHERE edge.chain = 'robinhood' AND edge.evidence_version = $2) AS v2_edges_exist
FROM robinhood_bundle_funding_backfill_runs run
LEFT JOIN robinhood_bundle_funding_backfill_ranges range ON range.run_id = run.id
WHERE run.chain = 'robinhood' AND run.id = $1
GROUP BY run.id`;

function parseArgs(argv = process.argv.slice(2)) {
  const values = { apply: false, confirmed: false, runId: null };
  for (const argument of argv) {
    if (argument === '--apply' && !values.apply) values.apply = true;
    else if (argument === CONFIRM_FLAG && !values.confirmed) values.confirmed = true;
    else if (/^--run-id=\d+$/.test(argument) && values.runId == null) {
      values.runId = argument.slice('--run-id='.length);
    } else throw new Error(`unknown or repeated argument: ${argument}`);
  }
  if (!values.runId || BigInt(values.runId) < 1n
      || BigInt(values.runId) > 9_223_372_036_854_775_807n) {
    throw new Error('--run-id is required');
  }
  if (values.confirmed && !values.apply) throw new Error(`${CONFIRM_FLAG} requires --apply`);
  if (values.apply && !values.confirmed) throw new Error(`--apply requires ${CONFIRM_FLAG}`);
  return Object.freeze(values);
}

async function assertSchema(database) {
  const result = await database.query(`SELECT
    to_regclass('robinhood_bundle_funding_backfill_runs') AS runs,
    to_regclass('robinhood_bundle_funding_backfill_ranges') AS ranges,
    to_regclass('robinhood_bundle_funding_evidence') AS evidence,
    to_regclass('robinhood_native_funding_edges') AS edges`);
  if (Object.values(result.rows[0] || {}).some((value) => !value)) {
    throw new Error('Stages 167 and 169 are required before recovery');
  }
}

function recoveryReasons(plan) {
  if (!plan || plan.found === false) return ['run_not_found'];
  const reasons = [];
  if (plan.evidenceVersion !== EVIDENCE_V1) reasons.push('run_is_not_v1');
  if (!['running', 'failed', 'completed'].includes(plan.status)) reasons.push('run_not_terminal_or_started');
  if (plan.totalRanges === 0 || plan.totalRanges !== plan.rangeCount) {
    reasons.push('frozen_range_count_mismatch');
  }
  if (plan.activeLeases > 0) reasons.push('active_range_leases');
  if (plan.scopedEvidenceRows > 0) reasons.push('scoped_evidence_already_exists');
  if (plan.v2EdgesExist) reasons.push('v2_global_edges_already_exist');
  return reasons;
}

function planFromRow(row) {
  if (!row) return null;
  const plan = {
    found: true, runId: row.id, status: row.status, evidenceVersion: row.evidence_version,
    rangeCount: Number(row.range_count), candidateCount: Number(row.candidate_count),
    totalRanges: Number(row.total_ranges), pending: Number(row.pending),
    leased: Number(row.leased), activeLeases: Number(row.active_leases),
    completed: Number(row.completed), failed: Number(row.failed),
    scopedEvidenceRows: Number(row.scoped_evidence_rows),
    v2EdgesExist: row.v2_edges_exist === true,
  };
  const reasons = recoveryReasons(plan);
  return Object.freeze({ ...plan, ready: reasons.length === 0, reasons: Object.freeze(reasons) });
}

async function inspectRecovery(database, runId) {
  await assertSchema(database);
  const result = await database.query(INSPECT_SQL, [runId, EVIDENCE_V2]);
  return planFromRow(result.rows[0]) || Object.freeze({
    found: false, runId: String(runId), ready: false,
    reasons: Object.freeze(['run_not_found']),
  });
}

function assertRecoveryIsSafe(plan) {
  const reasons = recoveryReasons(plan);
  if (reasons.length) throw new Error(`bundle funding v1 recovery refused: ${reasons.join(', ')}`);
}

async function resetRun(database, runId) {
  const client = await database.getClient();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_ID]);
    await client.query('LOCK TABLE robinhood_bundle_funding_backfill_ranges IN SHARE ROW EXCLUSIVE MODE');
    await client.query(`SELECT id FROM robinhood_bundle_funding_backfill_runs
      WHERE chain = 'robinhood' AND id = $1 FOR UPDATE`, [runId]);
    const plan = await inspectRecovery(client, runId);
    assertRecoveryIsSafe(plan);
    const ranges = await client.query(
      `UPDATE robinhood_bundle_funding_backfill_ranges SET
         status = 'failed', lease_owner = NULL, lease_until = NULL,
         attempt_count = 0, next_attempt_at = NOW(), completed_through_hash = NULL,
         blocks_scanned = 0, native_transfers_scanned = 0,
         raw_events_written = 0, edges_written = 0,
         last_error_code = 'evidence_version_reset',
         last_error_message = 'Reset for token-scoped funding evidence v2',
         started_at = NULL, completed_at = NOW(), updated_at = NOW()
       WHERE run_id = $1`, [runId]
    );
    if (ranges.rowCount !== plan.rangeCount) {
      throw new Error('bundle funding frozen range count changed during recovery');
    }
    const run = await client.query(
      `UPDATE robinhood_bundle_funding_backfill_runs SET
         evidence_version = $2, status = 'failed', finished_at = NOW(), updated_at = NOW()
       WHERE chain = 'robinhood' AND id = $1 AND evidence_version = $3 RETURNING id`,
      [runId, EVIDENCE_V2, EVIDENCE_V1]
    );
    if (!run.rowCount) throw new Error('bundle funding run version changed during recovery');
    await client.query('COMMIT');
    return Object.freeze({ ...plan, resetRanges: ranges.rowCount,
      status: 'failed', evidenceVersion: EVIDENCE_V2 });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const options = parseArgs(argv);
  const database = deps.database || db;
  const logger = deps.logger || console;
  if (!String((deps.env || process.env).DATABASE_URL || '').trim()) {
    throw new Error('missing required env DATABASE_URL');
  }
  const result = options.apply
    ? await resetRun(database, options.runId)
    : await inspectRecovery(database, options.runId);
  const report = { mode: options.apply ? 'reset-v1-to-v2' : 'read-only', ...result };
  logger.log(JSON.stringify(report, null, 2));
  if (!options.apply) logger.log(`No data changed. Re-run with --apply ${CONFIRM_FLAG}.`);
  return report;
}

if (require.main === module) main().catch((error) => {
  console.error('[BundleFundingRecovery] Fatal:', error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = {
  CONFIRM_FLAG, INSPECT_SQL, assertRecoveryIsSafe, inspectRecovery,
  main, parseArgs, planFromRow, recoveryReasons, resetRun,
};
