'use strict';

const {
  INDEX_STATEMENTS, PROTECTED_CTE, SOURCE_TABLE, TARGET_TABLE, parsePreparedMarker,
} = require('./prepare-robinhood-holder-journal-compaction');

const RETIRED_TABLE = 'robinhood_holder_transfer_journal_retired';
const REORG_FENCE_LOCK_ID = '8241992116082026';
const HOLDER_LEASE_PATTERN = 'robinhood-holder-%';
const NON_BLOCKING_HOLDER_LEASE = 'robinhood-holder-summary-worker';

const INDEX_RENAMES = Object.freeze([
  ['idx_rh_holder_journal_compact_pending', 'idx_robinhood_holder_journal_pending'],
  ['idx_rh_holder_journal_compact_pending_token', 'idx_rh_holder_journal_pending_token'],
  ['idx_rh_holder_journal_compact_applied_token_block',
    'idx_rh_holder_journal_applied_token_block'],
  ['idx_rh_holder_journal_compact_block_brin', 'idx_rh_holder_journal_block_brin'],
]);

function parseArgs(args) {
  if (args.length === 1 && args[0] === '--audit') return Object.freeze({ mode: 'audit' });
  const required = ['--finalize', '--write', '--drop-original', '--allow-archive-recovery'];
  if (args.length === required.length && required.every((arg) => args.includes(arg))) {
    return Object.freeze({ mode: 'finalize', archiveRecoveryAcknowledged: true });
  }
  throw new Error('Use --audit or --finalize --write --drop-original '
    + '--allow-archive-recovery');
}

function add(blockers, condition, code, detail = null) {
  if (condition) blockers.push(Object.freeze({ code, ...(detail == null ? {} : { detail }) }));
}

async function relationState(client) {
  const result = await client.query(
    `SELECT source.relowner = target.relowner AS owner_match,
            source.relacl IS NOT DISTINCT FROM target.relacl AS acl_match,
            obj_description(target.oid, 'pg_class') AS marker,
            pg_total_relation_size(source.oid)::bigint AS source_bytes,
            pg_total_relation_size(target.oid)::bigint AS target_bytes
       FROM pg_class source
       JOIN pg_namespace source_ns ON source_ns.oid = source.relnamespace
       JOIN pg_class target ON target.relname = $2 AND target.relkind = 'r'
       JOIN pg_namespace target_ns ON target_ns.oid = target.relnamespace
      WHERE source_ns.nspname = 'public' AND target_ns.nspname = 'public'
        AND source.relname = $1 AND source.relkind = 'r'`,
    [SOURCE_TABLE, TARGET_TABLE]
  );
  return result.rows[0] || null;
}

async function holderLeases(client, preparedAt = null) {
  const condition = preparedAt == null
    ? 'lease_until > NOW()' : 'heartbeat_at >= $3::timestamptz';
  const params = preparedAt == null
    ? [HOLDER_LEASE_PATTERN, NON_BLOCKING_HOLDER_LEASE]
    : [HOLDER_LEASE_PATTERN, NON_BLOCKING_HOLDER_LEASE, preparedAt];
  const result = await client.query(
    `SELECT lease_key FROM worker_leases
      WHERE lease_key LIKE $1 AND lease_key <> $2
        AND ${condition}
      ORDER BY lease_key`,
    params
  );
  return result.rows.map((row) => row.lease_key);
}

async function auditCompaction(client) {
  const blockers = [];
  const relation = await relationState(client);
  add(blockers, !relation, 'compaction_relations_missing');
  if (!relation) return Object.freeze({ mode: 'audit', ready: false, blockers });

  const marker = parsePreparedMarker(relation.marker);
  add(blockers, !marker, 'prepared_marker_invalid');
  add(blockers, relation.owner_match !== true, 'table_owner_mismatch');
  add(blockers, relation.acl_match !== true, 'table_acl_mismatch');
  if (!marker) return Object.freeze({ mode: 'audit', ready: false, blockers });

  add(blockers, BigInt(marker.journalFloorBlock)
    >= BigInt(marker.cutoffBlock) || BigInt(marker.cutoffBlock) > BigInt(marker.nextBlock),
  'prepared_bounds_invalid');

  const [cursorResult, activeLeases, touchedLeases, validation, indexes, triggerFunction] =
    await Promise.all([
      client.query(`SELECT next_block, journal_floor_block FROM robinhood_holder_cursors
        WHERE chain='robinhood' AND stream='live'`),
      holderLeases(client),
      holderLeases(client, marker.preparedAt),
      client.query(`WITH ${PROTECTED_CTE}
        SELECT COUNT(*)::bigint AS copied_rows,
               COUNT(*) FILTER (WHERE compact.block_number < $1::bigint
                 AND (compact.applied OR protected.token_address IS NULL))::bigint
                 AS invalid_old_rows,
               COUNT(*) FILTER (WHERE compact.block_number < $1::bigint
                 AND compact.applied = false)::bigint AS old_pending_rows
          FROM ${TARGET_TABLE} compact
          LEFT JOIN protected_tokens protected
            ON protected.token_address = compact.token_address`, [marker.cutoffBlock]),
      client.query(`SELECT COUNT(*)::int AS ready FROM pg_index
        WHERE indrelid = $1::regclass AND indisvalid AND indisready`, [TARGET_TABLE]),
      client.query("SELECT to_regprocedure('enqueue_robinhood_holder_hot()') IS NOT NULL AS ready"),
    ]);

  const cursor = cursorResult.rows[0];
  add(blockers, !cursor, 'holder_cursor_missing');
  add(blockers, cursor && String(cursor.next_block) !== marker.nextBlock,
    'holder_cursor_advanced', cursor ? String(cursor.next_block) : null);
  add(blockers, cursor && String(cursor.journal_floor_block) !== marker.journalFloorBlock,
    'holder_floor_changed', cursor ? String(cursor.journal_floor_block) : null);
  add(blockers, activeLeases.length > 0, 'holder_workers_active', activeLeases);
  add(blockers, touchedLeases.length > 0, 'holder_workers_ran_after_prepare', touchedLeases);
  const counts = validation.rows[0] || {};
  add(blockers, String(counts.copied_rows) !== marker.copiedRows,
    'prepared_row_count_changed', String(counts.copied_rows));
  add(blockers, String(counts.old_pending_rows) !== marker.oldPendingRows,
    'prepared_pending_count_changed', String(counts.old_pending_rows));
  add(blockers, String(counts.invalid_old_rows) !== '0',
    'prepared_selection_invalid', String(counts.invalid_old_rows));
  add(blockers, Number(indexes.rows[0]?.ready) !== INDEX_STATEMENTS.length,
    'prepared_indexes_invalid', Number(indexes.rows[0]?.ready || 0));
  add(blockers, triggerFunction.rows[0]?.ready !== true, 'hot_queue_trigger_function_missing');

  const sourceBytes = BigInt(relation.source_bytes);
  const targetBytes = BigInt(relation.target_bytes);
  return Object.freeze({
    mode: 'audit', ready: blockers.length === 0, blockers,
    prepared: marker,
    storage: {
      source_bytes: sourceBytes.toString(), target_bytes: targetBytes.toString(),
      reclaimable_bytes: (sourceBytes > targetBytes ? sourceBytes - targetBytes : 0n).toString(),
    },
  });
}

function assertFinalizable(audit) {
  if (audit.ready) return;
  const error = new Error(`compaction audit blocked: ${audit.blockers.map(({ code }) => code).join(', ')}`);
  error.code = 'holder_journal_compaction_not_ready';
  error.audit = audit;
  throw error;
}

async function runFinalize(database, options = {}) {
  if (options.archiveRecoveryAcknowledged !== true) {
    const error = new Error('archive recovery acknowledgement is required');
    error.code = 'holder_journal_compaction_archive_recovery_required';
    throw error;
  }
  const before = await database.getClient();
  try { assertFinalizable(await auditCompaction(before)); } finally { before.release(); }

  const client = await database.getClient();
  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '0'");
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [REORG_FENCE_LOCK_ID]);
    await client.query(`LOCK TABLE ${SOURCE_TABLE}, ${TARGET_TABLE} IN ACCESS EXCLUSIVE MODE`);
    await client.query(`LOCK TABLE robinhood_holder_cursors, robinhood_holder_token_states,
      robinhood_holder_global_backfill_tokens, robinhood_holder_global_backfill_runs IN SHARE MODE`);
    const audit = await auditCompaction(client);
    assertFinalizable(audit);
    const marker = audit.prepared;

    const floor = await client.query(`UPDATE robinhood_holder_cursors
      SET journal_floor_block=$1::bigint, updated_at=NOW()
      WHERE chain='robinhood' AND stream='live' AND next_block=$2::bigint
        AND journal_floor_block=$3::bigint RETURNING journal_floor_block`,
    [marker.cutoffBlock, marker.nextBlock, marker.journalFloorBlock]);
    if (floor.rowCount !== 1) throw new Error('holder journal floor changed during finalize');

    await client.query(`ALTER TABLE ${SOURCE_TABLE} RENAME TO ${RETIRED_TABLE}`);
    await client.query(`ALTER TABLE ${TARGET_TABLE} RENAME TO ${SOURCE_TABLE}`);
    await client.query(`DROP TABLE ${RETIRED_TABLE}`);
    await client.query(`ALTER TABLE ${SOURCE_TABLE}
      RENAME CONSTRAINT rh_holder_journal_compact_pkey
      TO robinhood_holder_transfer_journal_pkey`);
    for (const [from, to] of INDEX_RENAMES) {
      await client.query(`ALTER INDEX ${from} RENAME TO ${to}`);
    }
    await client.query(`CREATE TRIGGER rh_holder_journal_hot_enqueue
      AFTER INSERT ON ${SOURCE_TABLE}
      REFERENCING NEW TABLE AS inserted_holder_transfers
      FOR EACH STATEMENT EXECUTE FUNCTION enqueue_robinhood_holder_hot()`);
    await client.query(`COMMENT ON TABLE ${SOURCE_TABLE} IS
      'holder-journal-compacted:v1;cutoff=${marker.cutoffBlock};prepared_at=${marker.preparedAt}'`);
    await client.query(`ANALYZE ${SOURCE_TABLE}`);
    await client.query('COMMIT');
    transactionOpen = false;
    return Object.freeze({
      mode: 'finalize', status: 'completed', cutoffBlock: marker.cutoffBlock,
      retainedRows: marker.copiedRows, storage: audit.storage,
    });
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const db = require('../models/db');
  try {
    if (options.mode === 'audit') {
      const client = await db.getClient();
      try {
        const result = await auditCompaction(client);
        console.log(JSON.stringify(result, null, 2));
        if (!result.ready) process.exitCode = 2;
      } finally { client.release(); }
      return;
    }
    console.log(JSON.stringify(await runFinalize(db, options), null, 2));
  } finally { await db.pool.end(); }
}

if (require.main === module) main().catch((error) => {
  console.error(JSON.stringify({
    status: 'error', code: error.code || null, message: error.message,
    ...(error.audit ? { audit: error.audit } : {}),
  }, null, 2));
  process.exitCode = 1;
});

module.exports = {
  INDEX_RENAMES, RETIRED_TABLE, auditCompaction, parseArgs, runFinalize,
};
