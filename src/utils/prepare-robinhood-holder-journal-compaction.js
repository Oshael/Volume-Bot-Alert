'use strict';

const { statfsSync } = require('node:fs');

const SOURCE_TABLE = 'robinhood_holder_transfer_journal';
const TARGET_TABLE = 'robinhood_holder_transfer_journal_compact';
const REORG_FENCE_LOCK_ID = '8241992116082026';
const RETENTION_BLOCKS = 20_000n;
const DEFAULT_MIN_FREE_GIB = 60;
const HOLDER_LEASE_PATTERN = 'robinhood-holder-%';
const NON_BLOCKING_HOLDER_LEASE = 'robinhood-holder-summary-worker';

const PROTECTED_CTE = `protected_tokens AS MATERIALIZED (
  SELECT token_address
    FROM robinhood_holder_token_states
   WHERE chain = 'robinhood' AND ledger_status <> 'drifted'
  UNION
  SELECT token.token_address
    FROM robinhood_holder_global_backfill_tokens token
    JOIN robinhood_holder_global_backfill_runs run
      ON run.id = token.run_id AND run.chain = token.chain
   WHERE token.chain = 'robinhood' AND token.status = 'active'
     AND run.barrier_block IS NOT NULL AND run.status <> 'completed'
)`;

const INDEX_STATEMENTS = Object.freeze([
  `ALTER TABLE ${TARGET_TABLE} ADD CONSTRAINT rh_holder_journal_compact_pkey
     PRIMARY KEY (chain, transaction_hash, log_index)`,
  `CREATE INDEX idx_rh_holder_journal_compact_pending
     ON ${TARGET_TABLE}(block_number, transaction_index, log_index)
     WHERE applied = false`,
  `CREATE INDEX idx_rh_holder_journal_compact_pending_token
     ON ${TARGET_TABLE}(chain, token_address, block_number, transaction_index, log_index)
     WHERE applied = false`,
  `CREATE INDEX idx_rh_holder_journal_compact_applied_token_block
     ON ${TARGET_TABLE}(chain, token_address, block_number)
     WHERE applied = true`,
  `CREATE INDEX idx_rh_holder_journal_compact_block_brin
     ON ${TARGET_TABLE} USING BRIN (block_number)
     WITH (pages_per_range = 32, autosummarize = on)`,
]);

function parseArgs(args) {
  const minimum = args.filter((arg) => arg.startsWith('--min-free-gib='));
  const required = ['--prepare', '--write', '--allow-archive-recovery'];
  const valid = required.every((arg) => args.includes(arg)) && minimum.length <= 1
    && args.length === required.length + minimum.length
    && args.every((arg) => required.includes(arg) || minimum.includes(arg));
  const minFreeGiB = minimum.length
    ? Number(minimum[0].slice('--min-free-gib='.length)) : DEFAULT_MIN_FREE_GIB;
  if (!valid || !Number.isInteger(minFreeGiB) || minFreeGiB < 40 || minFreeGiB > 500) {
    throw new Error('Use --prepare --write --allow-archive-recovery '
      + '[--min-free-gib=60] (minimum 40 GiB)');
  }
  return Object.freeze({ minFreeGiB, archiveRecoveryAcknowledged: true });
}

function systemFreeBytes() {
  const stats = statfsSync('/', { bigint: true });
  return stats.bavail * stats.bsize;
}

function gib(bytes) {
  return Number(bytes / (1024n ** 3n));
}

function assertFreeSpace(freeBytes, minFreeGiB, phase) {
  const available = BigInt(freeBytes());
  if (available < BigInt(minFreeGiB) * 1024n ** 3n) {
    const error = new Error(
      `free space below ${minFreeGiB} GiB during ${phase}: ${gib(available)} GiB available`
    );
    error.code = 'holder_journal_compaction_low_disk';
    throw error;
  }
  return available;
}

function createInterruptController(database, progress = () => {}) {
  let backendPid = null;
  let requestedSignal = null;
  let termination = null;

  function terminate() {
    if (!requestedSignal || backendPid == null || termination) return;
    const pid = backendPid;
    progress({ phase: 'interrupt', signal: requestedSignal, backendPid: pid,
      status: 'requested' });
    termination = database.query(
      `SELECT pg_cancel_backend($1::int) AS cancelled
        WHERE $1::int <> pg_backend_pid()`, [pid]
    ).then((result) => {
      const cancelled = result.rows[0]?.cancelled === true;
      progress({ phase: 'interrupt', signal: requestedSignal, backendPid: pid,
        status: cancelled ? 'cancelled' : 'not-found' });
      return cancelled;
    }).catch((error) => {
      progress({ phase: 'interrupt', signal: requestedSignal, backendPid: pid,
        status: 'failed', error: error.message });
      return false;
    });
  }

  return Object.freeze({
    request(signal) {
      if (!requestedSignal) requestedSignal = signal;
      terminate();
    },
    setBackendPid(pid) {
      backendPid = pid == null ? null : Number(pid);
      terminate();
    },
    wait: async () => (termination ? termination : null),
    get signal() { return requestedSignal; },
  });
}

async function activeHolderLeases(client) {
  const result = await client.query(
    `/* holder-compact:leases */ SELECT lease_key FROM worker_leases
      WHERE lease_key LIKE $1 AND lease_key <> $2
        AND lease_until > NOW() ORDER BY lease_key`,
    [HOLDER_LEASE_PATTERN, NON_BLOCKING_HOLDER_LEASE]
  );
  return result.rows.map((row) => row.lease_key);
}

async function assertNoActiveHolderLeases(client) {
  const active = await activeHolderLeases(client);
  if (active.length) {
    const error = new Error(`active holder leases: ${active.join(', ')}`);
    error.code = 'holder_journal_compaction_workers_active';
    throw error;
  }
}

function assertPrepareInput(database, options) {
  if (!database?.getClient) throw new TypeError('database.getClient is required');
  if (options.archiveRecoveryAcknowledged !== true) {
    const error = new Error('archive recovery acknowledgement is required');
    error.code = 'holder_journal_compaction_archive_recovery_required';
    throw error;
  }
}

async function reportBackendPid(client, callback) {
  if (typeof callback !== 'function') return;
  const backend = await client.query('SELECT pg_backend_pid()::int AS backend_pid');
  callback(backend.rows[0].backend_pid);
}

function clearBackendPid(callback) {
  if (typeof callback === 'function') callback(null);
}

async function runPrepare(options = {}, dependencies = {}) {
  const database = dependencies.database;
  const freeBytes = dependencies.freeBytes || systemFreeBytes;
  const progress = dependencies.progress || (() => {});
  const onBackendPid = dependencies.onBackendPid;
  const minFreeGiB = options.minFreeGiB ?? DEFAULT_MIN_FREE_GIB;
  assertPrepareInput(database, options);
  assertFreeSpace(freeBytes, minFreeGiB, 'preflight');
  const client = await database.getClient();
  let transactionOpen = false;
  try {
    await reportBackendPid(client, onBackendPid);
    const existing = await client.query(
      '/* holder-compact:target */ SELECT to_regclass($1) AS target', [TARGET_TABLE]
    );
    if (existing.rows[0]?.target) {
      throw new Error(`${TARGET_TABLE} already exists; no changes made`);
    }
    await assertNoActiveHolderLeases(client);
    await client.query('BEGIN');
    transactionOpen = true;
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '0'");
    await client.query('SET LOCAL enable_mergejoin = off');
    await client.query('SET LOCAL enable_nestloop = off');
    await client.query('SET LOCAL enable_indexscan = off');
    await client.query('SET LOCAL enable_bitmapscan = off');
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [REORG_FENCE_LOCK_ID]);
    await client.query(`LOCK TABLE ${SOURCE_TABLE}, robinhood_holder_token_states,
      robinhood_holder_global_backfill_tokens, robinhood_holder_global_backfill_runs,
      robinhood_holder_cursors IN SHARE MODE`);
    await assertNoActiveHolderLeases(client);
    const cursorResult = await client.query(
      `SELECT next_block, journal_floor_block FROM robinhood_holder_cursors
        WHERE chain = 'robinhood' AND stream = 'live' FOR SHARE`
    );
    if (cursorResult.rowCount !== 1) throw new Error('holder live cursor is missing');
    const nextBlock = BigInt(cursorResult.rows[0].next_block);
    const cutoffBlock = nextBlock > RETENTION_BLOCKS ? nextBlock - RETENTION_BLOCKS : 0n;
    progress({ phase: 'copy', cutoffBlock: cutoffBlock.toString(), nextBlock: nextBlock.toString() });
    await client.query(`CREATE TABLE ${TARGET_TABLE} (
      LIKE ${SOURCE_TABLE} INCLUDING DEFAULTS INCLUDING CONSTRAINTS
        INCLUDING STORAGE INCLUDING COMPRESSION INCLUDING COMMENTS
    )`);
    const copied = await client.query(
      `WITH ${PROTECTED_CTE}
       INSERT INTO ${TARGET_TABLE}
       SELECT journal.* FROM ${SOURCE_TABLE} journal
       LEFT JOIN protected_tokens protected
         ON protected.token_address = journal.token_address
        WHERE journal.chain = 'robinhood' AND (
          journal.block_number >= $1::bigint OR (
            journal.block_number < $1::bigint AND journal.applied = false
            AND protected.token_address IS NOT NULL
          )
        )`,
      [cutoffBlock.toString()]
    );
    assertFreeSpace(freeBytes, minFreeGiB, 'copy');
    for (let index = 0; index < INDEX_STATEMENTS.length; index += 1) {
      progress({ phase: 'index', index: index + 1, total: INDEX_STATEMENTS.length });
      await client.query(INDEX_STATEMENTS[index]);
      assertFreeSpace(freeBytes, minFreeGiB, `index ${index + 1}`);
    }
    const validation = await client.query(
      `WITH ${PROTECTED_CTE}
       SELECT COUNT(*)::bigint AS copied_rows,
              COUNT(*) FILTER (WHERE compact.block_number < $1::bigint
                AND (compact.applied OR protected.token_address IS NULL))::bigint
                AS invalid_old_rows,
              COUNT(*) FILTER (WHERE compact.block_number < $1::bigint
                AND compact.applied = false)::bigint AS old_pending_rows
         FROM ${TARGET_TABLE} compact
         LEFT JOIN protected_tokens protected
           ON protected.token_address = compact.token_address`,
      [cutoffBlock.toString()]
    );
    const copiedRows = BigInt(validation.rows[0].copied_rows);
    if (copiedRows !== BigInt(copied.rowCount)
      || BigInt(validation.rows[0].invalid_old_rows) !== 0n) {
      throw new Error('compact journal validation diverged from the locked source selection');
    }
    const ready = await client.query(
      `SELECT COUNT(*)::int AS ready FROM pg_index
        WHERE indrelid = $1::regclass AND indisvalid AND indisready`, [TARGET_TABLE]
    );
    if (Number(ready.rows[0].ready) !== INDEX_STATEMENTS.length) {
      throw new Error('compact journal indexes are not valid/ready');
    }
    const oldPendingRows = BigInt(validation.rows[0].old_pending_rows);
    const marker = `holder-journal-compact:v3;recovery=archive-required;cutoff=${cutoffBlock};next=${nextBlock};rows=${copiedRows};old_pending=${oldPendingRows}`;
    await client.query(`COMMENT ON TABLE ${TARGET_TABLE} IS '${marker}'`);
    await client.query(`ANALYZE ${TARGET_TABLE}`);
    const size = await client.query(
      `SELECT pg_total_relation_size($1::regclass)::bigint AS total_bytes`, [TARGET_TABLE]
    );
    const remaining = assertFreeSpace(freeBytes, minFreeGiB, 'validation');
    await client.query('COMMIT');
    transactionOpen = false;
    return Object.freeze({
      status: 'prepared', sourceTable: SOURCE_TABLE, targetTable: TARGET_TABLE,
      cutoffBlock: cutoffBlock.toString(), nextBlock: nextBlock.toString(),
      copiedRows: copiedRows.toString(), totalBytes: String(size.rows[0].total_bytes),
      oldPendingRows: oldPendingRows.toString(),
      recoveryBeforeCutoff: 'archive-required',
      freeGiB: gib(remaining), originalUntouched: true,
    });
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    clearBackendPid(onBackendPid);
    client.release();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const database = require('../models/db');
  const progress = (entry) => console.log(JSON.stringify(entry));
  const interrupt = createInterruptController(database, progress);
  const handlers = Object.fromEntries(['SIGINT', 'SIGTERM'].map((signal) => [
    signal, () => interrupt.request(signal),
  ]));
  for (const [signal, handler] of Object.entries(handlers)) process.on(signal, handler);
  try {
    const result = await runPrepare(options, {
      database, progress, onBackendPid: (pid) => interrupt.setBackendPid(pid),
    });
    if (interrupt.signal) {
      const error = new Error(`interrupted by ${interrupt.signal}`);
      error.code = 'holder_journal_compaction_interrupted';
      throw error;
    }
    console.log(JSON.stringify(result));
  } finally {
    await interrupt.wait();
    for (const [signal, handler] of Object.entries(handlers)) {
      process.removeListener(signal, handler);
    }
    await database.pool.end();
  }
}

if (require.main === module) main().catch((error) => {
  console.error(JSON.stringify({ status: 'error', code: error.code || null, message: error.message }));
  process.exitCode = 1;
});

module.exports = {
  DEFAULT_MIN_FREE_GIB, INDEX_STATEMENTS, SOURCE_TABLE, TARGET_TABLE, createInterruptController,
  parseArgs, runPrepare,
};
