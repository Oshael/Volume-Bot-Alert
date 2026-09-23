'use strict';

const db = require('./db');
const { dayBounds } = require('./robinhood-token-transfer-persistence');
const { lockRobinhoodCanonicalRecoveryShared } = require('./robinhood-canonical-projection-fence');

const CHAIN = 'robinhood';
const VERSION = 'rh_transfer_v1';
const DAY_LOCK_PREFIX = 'rh-transfer-retention-day:';

function partitionForDay(day) {
  dayBounds(day);
  return `public.robinhood_token_transfer_events_${day.replace(/-/g, '_')}`;
}

function boundMatchesDay(bound, day) {
  const match = String(bound || '').match(/FOR VALUES FROM \('([^']+)'\) TO \('([^']+)'\)/);
  if (!match) return false;
  const { from, to } = dayBounds(day);
  return Date.parse(match[1]) === Date.parse(from) && Date.parse(match[2]) === Date.parse(to);
}

function parseCursor(encoded, day) {
  if (!encoded) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('after cursor is invalid');
  let value;
  try {
    value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch (_) {
    throw new Error('after cursor is invalid');
  }
  if (!/^0x[0-9a-f]{64}$/.test(value?.transactionHash)
      || !Number.isInteger(value?.logIndex) || value.logIndex < 0
      || typeof value?.blockTime !== 'string'
      || Number.isNaN(Date.parse(value.blockTime))
      || new Date(value.blockTime).toISOString().slice(0, 10) !== day) {
    throw new Error('after cursor is invalid for day');
  }
  return value;
}

function encodeCursor(row) {
  return Buffer.from(JSON.stringify({ transactionHash: row.transaction_hash,
    logIndex: row.log_index, blockTime: row.block_time }), 'utf8').toString('base64url');
}

function range(after, last) {
  const start = after
    ? `AND (raw.transaction_hash, raw.log_index, raw.block_time)
         > ($2::varchar, $3::integer, $4::timestamptz)` : '';
  const endStart = after ? 5 : 2;
  return {
    sql: `${start}
      AND (raw.transaction_hash, raw.log_index, raw.block_time)
        <= ($${endStart}::varchar, $${endStart + 1}::integer, $${endStart + 2}::timestamptz)`,
    params: [CHAIN, ...(after ? [after.transactionHash, after.logIndex, after.blockTime] : []),
      last.transaction_hash, last.log_index, last.block_time],
  };
}

async function assertEligible(client, day, partition) {
  const { rows } = await client.query(
    `SELECT watermark.lifecycle_state, watermark.dropped_at,
            child.relname AS actual_partition,
            pg_get_expr(child.relpartbound, child.oid) AS partition_bound,
            inheritance.inhparent = parent.oid AS attached
       FROM robinhood_wallet_transfer_compaction_watermarks watermark
       LEFT JOIN pg_class child ON child.oid = to_regclass($3)
       LEFT JOIN pg_class parent ON parent.oid = 'public.robinhood_token_transfer_events'::regclass
       LEFT JOIN pg_inherits inheritance ON inheritance.inhrelid = child.oid
         AND inheritance.inhparent = parent.oid
      WHERE watermark.chain = $1 AND watermark.projection_version = $2
        AND watermark.partition_day = $4::date`,
    [CHAIN, VERSION, partition, day]
  );
  const row = rows[0];
  if (!row || row.lifecycle_state !== 'verified' || row.dropped_at
      || row.attached !== true || row.actual_partition !== partition.slice(7)
      || !boundMatchesDay(row.partition_bound, day)) {
    throw new Error('transfer evidence migration requires an attached, verified daily partition');
  }
}

async function readBatch(client, partition, after, batchSize, apply) {
  const predicate = after
    ? `AND (raw.transaction_hash, raw.log_index, raw.block_time)
         > ($2::varchar, $3::integer, $4::timestamptz)` : '';
  const params = [CHAIN, ...(after ? [after.transactionHash, after.logIndex, after.blockTime] : []),
    batchSize];
  const { rows } = await client.query(
    `SELECT raw.transaction_hash, raw.log_index, raw.block_time::text AS block_time,
            raw.transfer_kind
       FROM ${partition} raw
      WHERE raw.chain = $1 ${predicate}
      ORDER BY raw.transaction_hash, raw.log_index, raw.block_time
      LIMIT $${params.length}::integer ${apply ? 'FOR SHARE OF raw' : ''}`,
    params
  );
  return rows;
}

async function preserveBatch(client, partition, after, rows) {
  const unknown = rows.filter((row) => row.transfer_kind === 'unknown').length;
  if (!unknown) return { inserted: 0, unknown: 0 };
  const window = range(after, rows[rows.length - 1]);
  const inserted = await client.query(
    `INSERT INTO robinhood_wallet_transfer_pending_evidence (
       chain, block_number, block_hash, block_time, transaction_hash,
       transaction_index, log_index, token_address, from_wallet, to_wallet,
       amount_raw, classification_version
     ) SELECT raw.chain, raw.block_number, raw.block_hash, raw.block_time,
         raw.transaction_hash, raw.transaction_index, raw.log_index,
         raw.token_address, raw.from_wallet, raw.to_wallet, raw.amount_raw,
         raw.classification_version
       FROM ${partition} raw
      WHERE raw.chain = $1 AND raw.transfer_kind = 'unknown' ${window.sql}
      ON CONFLICT (chain, transaction_hash, log_index, block_time) DO NOTHING`,
    window.params
  );
  const { rows: [coverage] } = await client.query(
    `SELECT COUNT(*)::integer AS total,
            COUNT(*) FILTER (WHERE evidence.chain IS NOT NULL
              AND evidence.block_number = raw.block_number
              AND evidence.block_hash = raw.block_hash
              AND evidence.transaction_index = raw.transaction_index
              AND evidence.token_address = raw.token_address
              AND evidence.from_wallet = raw.from_wallet
              AND evidence.to_wallet = raw.to_wallet
              AND evidence.amount_raw = raw.amount_raw
              AND evidence.classification_version = raw.classification_version
              AND NOT EXISTS (
                SELECT 1 FROM robinhood_wallet_transfer_evidence_dispositions disposition
                WHERE disposition.chain = evidence.chain
                  AND disposition.transaction_hash = evidence.transaction_hash
                  AND disposition.log_index = evidence.log_index
                  AND disposition.block_time = evidence.block_time
                  AND disposition.disposition IN ('orphaned', 'reclassified')
              ))::integer AS matched
       FROM ${partition} raw
       LEFT JOIN robinhood_wallet_transfer_pending_evidence evidence
         ON evidence.chain = raw.chain
        AND evidence.transaction_hash = raw.transaction_hash
        AND evidence.log_index = raw.log_index AND evidence.block_time = raw.block_time
      WHERE raw.chain = $1 AND raw.transfer_kind = 'unknown' ${window.sql}`,
    window.params
  );
  if (coverage.total !== unknown || coverage.matched !== unknown) {
    throw new Error('preserved evidence conflicts with raw or has a terminal disposition');
  }
  return { inserted: inserted.rowCount, unknown };
}

function boundedInteger(value, label, defaultValue, maximum) {
  const number = value == null ? defaultValue : Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) {
    throw new Error(`${label} must be between 1 and ${maximum}`);
  }
  return number;
}

function createRobinhoodWalletTransferEvidenceMigration(options = {}) {
  const database = options.database || db;
  const lockRecovery = options.lockRecovery || lockRobinhoodCanonicalRecoveryShared;

  async function run(input = {}) {
    const day = String(input.day || '');
    const partition = partitionForDay(day);
    const batchSize = boundedInteger(input.batchSize, 'batchSize', 5_000, 10_000);
    const maxBatches = boundedInteger(input.maxBatches, 'maxBatches', 1, 100);
    const apply = input.apply === true;
    if (apply !== (input.confirmed === true)) throw new Error('apply requires explicit confirmation');
    let after = parseCursor(input.after, day);
    let nextCursor = input.after || null;
    let scanned = 0;
    let unknown = 0;
    let inserted = 0;
    let scanComplete = false;
    for (let batch = 1; batch <= maxBatches; batch += 1) {
      const client = await database.getClient();
      try {
        await client.query(apply ? 'BEGIN' : 'BEGIN READ ONLY');
        await client.query("SET LOCAL statement_timeout = '30s'");
        await client.query("SET LOCAL lock_timeout = '2s'");
        if (apply) {
          await lockRecovery(client);
          const recovery = await client.query(
            'SELECT recovery_state FROM robinhood_chain_capture_cursor WHERE chain = $1', [CHAIN]
          );
          if (recovery.rows[0]?.recovery_state !== 'running') {
            throw new Error('canonical recovery is not running normally');
          }
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
            `${DAY_LOCK_PREFIX}${day}`,
          ]);
        }
        await assertEligible(client, day, partition);
        const rows = await readBatch(client, partition, after, batchSize, apply);
        const result = apply && rows.length
          ? await preserveBatch(client, partition, after, rows)
          : { inserted: 0, unknown: rows.filter((row) => row.transfer_kind === 'unknown').length };
        await client.query(apply ? 'COMMIT' : 'ROLLBACK');
        scanned += rows.length;
        unknown += result.unknown;
        inserted += result.inserted;
        if (rows.length) {
          after = { transactionHash: rows.at(-1).transaction_hash,
            logIndex: rows.at(-1).log_index, blockTime: rows.at(-1).block_time };
          nextCursor = encodeCursor(rows.at(-1));
        }
        scanComplete = rows.length < batchSize;
        if (input.onBatch) input.onBatch({ batch, scanned: rows.length,
          unknown: result.unknown, inserted: result.inserted, nextCursor, scanComplete });
        if (scanComplete) break;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    }
    return { mode: apply ? 'apply' : 'read-only', day, scanned, unknown, inserted,
      nextCursor, scanComplete, readyForDrop: false };
  }

  return { run };
}

module.exports = { createRobinhoodWalletTransferEvidenceMigration };
