'use strict';

require('dotenv').config();
const db = require('../models/db');
const { SOURCE_TABLE, STATE_TABLE } = require('./db-init-stage236');
const { PROGRESS_TABLE } = require('./db-init-stage237');

const CHAIN = 'robinhood';
const KEYS = ['chain', 'transaction_hash', 'log_index', 'block_hash', 'event_kind'];
const VALUES = [
  'block_number', 'transaction_index', 'status', 'lease_owner', 'lease_until',
  'attempt_count', 'next_attempt_at', 'published_at', 'last_error',
  'audit_status', 'audit_lease_owner', 'audit_lease_until', 'audit_attempt_count',
  'audit_next_attempt_at', 'audited_at', 'audit_last_error', 'terminalized_at',
  'created_at', 'updated_at',
];
const COLUMNS = [...KEYS, ...VALUES];
const KEY_SQL = 'transaction_hash, log_index, block_hash, event_kind';
const KEY_DESC_SQL = KEY_SQL.split(', ').map((column) => `${column} DESC`).join(', ');
const CURSOR_SQL = 'after_transaction_hash, after_log_index, after_block_hash, after_event_kind';
const TARGET_SQL = 'target_transaction_hash, target_log_index, target_block_hash, target_event_kind';

function boundedLimit(value) {
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
    throw new Error('limit must be between 1 and 10000');
  }
  return limit;
}

function parseArgs(argv = []) {
  const options = { apply: false, limit: 1000 };
  for (const argument of argv) {
    if (argument === '--apply') options.apply = true;
    else if (argument.startsWith('--limit=')) options.limit = Number(argument.slice(8));
    else throw new Error(`unknown argument: ${argument}`);
  }
  try { options.limit = boundedLimit(options.limit); } catch (_) {
    throw new Error('--limit must be between 1 and 10000');
  }
  return Object.freeze(options);
}

function batchSql(apply) {
  const sourceColumns = COLUMNS.map((column) => `source.${column}`).join(', ');
  const insertion = apply ? `, inserted AS (
    INSERT INTO ${STATE_TABLE} (${COLUMNS.join(', ')})
    SELECT ${COLUMNS.map((column) => `batch.${column}`).join(', ')} FROM batch
    LEFT JOIN ${STATE_TABLE} state USING (${KEYS.join(', ')})
    WHERE state.chain IS NULL
    ON CONFLICT (${KEYS.join(', ')}) DO NOTHING RETURNING 1
  )` : '';
  return `WITH batch AS MATERIALIZED (
    SELECT ${sourceColumns} FROM ${SOURCE_TABLE} source
    JOIN ${PROGRESS_TABLE} progress ON progress.chain=source.chain
    WHERE source.chain=$1 AND (progress.after_transaction_hash IS NULL
      OR ROW(source.${KEY_SQL.replaceAll(', ', ', source.')})
       > ROW(progress.${CURSOR_SQL.replaceAll(', ', ', progress.')}))
      AND ROW(source.${KEY_SQL.replaceAll(', ', ', source.')})
        <= ROW(progress.${TARGET_SQL.replaceAll(', ', ', progress.')})
    ORDER BY source.${KEY_SQL.replaceAll(', ', ', source.')} LIMIT $2
  )${insertion}
  SELECT COUNT(*)::int AS scanned,
    ${apply ? '(SELECT COUNT(*)::int FROM inserted)' : '0::int'} AS inserted,
    (SELECT transaction_hash FROM batch ORDER BY ${KEY_DESC_SQL} LIMIT 1) AS next_transaction_hash,
    (SELECT log_index::text FROM batch ORDER BY ${KEY_DESC_SQL} LIMIT 1) AS next_log_index,
    (SELECT block_hash FROM batch ORDER BY ${KEY_DESC_SQL} LIMIT 1) AS next_block_hash,
    (SELECT event_kind FROM batch ORDER BY ${KEY_DESC_SQL} LIMIT 1) AS next_event_kind
  FROM batch`;
}

const PARITY_SQL = `SELECT
  COUNT(*) FILTER (WHERE state.chain IS NULL)::int AS missing,
  COUNT(*) FILTER (WHERE state.chain IS NOT NULL AND
    ROW(${VALUES.map((column) => `source.${column}`).join(', ')}) IS DISTINCT FROM
    ROW(${VALUES.map((column) => `state.${column}`).join(', ')}))::int AS divergent
FROM ${SOURCE_TABLE} source
JOIN ${PROGRESS_TABLE} progress USING (chain)
LEFT JOIN ${STATE_TABLE} state USING (${KEYS.join(', ')})
WHERE source.chain=$1
  AND (progress.after_transaction_hash IS NULL
    OR ROW(source.${KEY_SQL.replaceAll(', ', ', source.')})
     > ROW(progress.${CURSOR_SQL.replaceAll(', ', ', progress.')}))
  AND ROW(source.${KEY_SQL.replaceAll(', ', ', source.')}) <= ROW($2,$3::bigint,$4,$5)`;

function summary(progress, batch, parity, apply, complete) {
  return {
    mode: apply ? 'apply' : 'preview', pass: Number(progress.pass),
    scanned: Number(batch.scanned), inserted: Number(batch.inserted),
    alreadyPresent: Number(batch.scanned)
      - (apply ? Number(batch.inserted) : Number(parity.missing)),
    missing: Number(parity.missing), divergent: Number(parity.divergent),
    next: batch.next_transaction_hash ? {
      transactionHash: batch.next_transaction_hash, logIndex: batch.next_log_index,
      blockHash: batch.next_block_hash, eventKind: batch.next_event_kind,
    } : null,
    totalScanned: Number(progress.scanned) + (apply ? Number(batch.scanned) : 0),
    totalInserted: Number(progress.inserted) + (apply ? Number(batch.inserted) : 0),
    target: progress.target_transaction_hash ? {
      transactionHash: progress.target_transaction_hash,
      logIndex: String(progress.target_log_index), blockHash: progress.target_block_hash,
      eventKind: progress.target_event_kind, capturedAt: progress.target_captured_at,
    } : null,
    complete,
  };
}

async function runBatch(options = {}, dependencies = {}) {
  const database = dependencies.database || db;
  const apply = options.apply === true;
  const limit = boundedLimit(options.limit ?? 1000);
  const client = await database.getClient();
  try {
    await client.query(apply ? 'BEGIN' : 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SET LOCAL lock_timeout = '1s'");
    const progress = (await client.query(
      `SELECT * FROM ${PROGRESS_TABLE} WHERE chain=$1${apply ? ' FOR UPDATE' : ''}`,
      [CHAIN]
    )).rows[0];
    if (!progress) throw new Error('state backfill progress is missing; apply Stage 237');
    if (!Object.prototype.hasOwnProperty.call(progress, 'target_transaction_hash')) {
      throw new Error('state backfill target is missing; apply Stage 238');
    }
    if (progress.completed_at) {
      await client.query(apply ? 'COMMIT' : 'ROLLBACK');
      return summary(progress, { scanned: 0, inserted: 0 }, { missing: 0, divergent: 0 }, apply, true);
    }
    if (!progress.target_transaction_hash) {
      throw new Error('state backfill target is not frozen; apply Stage 238');
    }
    const batch = (await client.query(batchSql(apply), [CHAIN, limit])).rows[0];
    let parity = { missing: 0, divergent: 0 };
    if (batch.next_transaction_hash) {
      parity = (await client.query(PARITY_SQL, [CHAIN, batch.next_transaction_hash,
        batch.next_log_index, batch.next_block_hash, batch.next_event_kind])).rows[0];
    }
    if (apply && (Number(parity.missing) > 0 || Number(parity.divergent) > 0)) {
      throw new Error(`state backfill parity failed: missing=${parity.missing} divergent=${parity.divergent}`);
    }
    const complete = Number(batch.scanned) < limit;
    if (apply) {
      await client.query(`UPDATE ${PROGRESS_TABLE} SET
        after_transaction_hash=COALESCE($2,after_transaction_hash),
        after_log_index=COALESCE($3::bigint,after_log_index),
        after_block_hash=COALESCE($4,after_block_hash),
        after_event_kind=COALESCE($5,after_event_kind),
        scanned=scanned+$6, inserted=inserted+$7,
        completed_at=CASE WHEN $8 THEN NOW() ELSE NULL END, updated_at=NOW()
        WHERE chain=$1`, [CHAIN, batch.next_transaction_hash, batch.next_log_index,
        batch.next_block_hash, batch.next_event_kind, batch.scanned, batch.inserted, complete]);
      await client.query('COMMIT');
    } else await client.query('ROLLBACK');
    return summary(progress, batch, parity, apply, complete);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  try {
    const result = await runBatch(parseArgs(argv), dependencies);
    (dependencies.logger || console).log(JSON.stringify(result, null, 2));
    return result;
  } finally {
    if (!dependencies.database) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) main().catch((error) => {
  console.error(JSON.stringify({ mode: 'error', message: error.message }));
  process.exitCode = 1;
});

module.exports = { PARITY_SQL, batchSql, main, parseArgs, runBatch };
