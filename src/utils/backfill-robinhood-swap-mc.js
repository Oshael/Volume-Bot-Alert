/**
 * Backfill the durable per-swap MC sidecar (robinhood_swap_mc) from the intact
 * robinhood_market_observations.
 *
 * Run AFTER the sqrtPriceX96 repair so the copied fdv_usd is the corrected value
 * (a re-run is safe and refreshes any stale rows — see the UPSERT guard below).
 * Keyset-paginated over (block_number, log_index) on the accepted-observation
 * index, throttled (--sleep-ms), checkpointed (--checkpoint), and idempotent:
 * ON CONFLICT DO UPDATE only rewrites rows whose value actually changed.
 *
 * Copies every accepted observation with an FDV — the complete MC set to preserve
 * before the wide observations table is pruned for disk. Dry-run by default
 * (counts only); pass --apply to write.
 *
 * Usage:
 *   node src/utils/backfill-robinhood-swap-mc.js                       # dry-run
 *   node src/utils/backfill-robinhood-swap-mc.js --apply \
 *        --checkpoint .swap-mc.json --batch-size 5000 --sleep-ms 50
 */
const fs = require('fs');
const db = require('../models/db');

// Keyset over (block_number, log_index) using idx_robinhood_market_observations_attribution
// (chain, status, block_number, log_index). $1/$2 = cursor, $3 = batch size.
const SELECT_BATCH_SQL = `SELECT chain, transaction_hash, log_index, block_number,
    fdv_usd, token_total_supply_raw
  FROM robinhood_market_observations
  WHERE chain = 'robinhood' AND status = 'accepted' AND fdv_usd IS NOT NULL
    AND (block_number, log_index) > ($1::bigint, $2::bigint)
  ORDER BY block_number, log_index
  LIMIT $3::int`;

// Insert new, refresh changed, skip unchanged (no rewrite when the value matches).
const UPSERT_SQL = `INSERT INTO robinhood_swap_mc (
    chain, transaction_hash, log_index, fdv_usd, token_total_supply_raw
  )
  SELECT item.chain, item.transaction_hash, item.log_index::bigint,
         item.fdv_usd::numeric, item.token_total_supply_raw::numeric
  FROM jsonb_to_recordset($1::jsonb) AS item(
    chain text, transaction_hash text, log_index text,
    fdv_usd text, token_total_supply_raw text
  )
  ON CONFLICT (chain, transaction_hash, log_index) DO UPDATE
    SET fdv_usd = EXCLUDED.fdv_usd,
        token_total_supply_raw = EXCLUDED.token_total_supply_raw
    WHERE (robinhood_swap_mc.fdv_usd, robinhood_swap_mc.token_total_supply_raw)
          IS DISTINCT FROM (EXCLUDED.fdv_usd, EXCLUDED.token_total_supply_raw)`;

function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { args[token.slice(2)] = true; } else {
      args[token.slice(2)] = next; i += 1;
    }
  }
  const apply = args.apply === true;
  const batchSize = Number.parseInt(args['batch-size'] ?? '5000', 10);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 50000) {
    throw new Error('--batch-size must be an integer 1..50000');
  }
  const sleepMs = Number.parseInt(args['sleep-ms'] ?? '0', 10);
  if (!Number.isInteger(sleepMs) || sleepMs < 0) throw new Error('--sleep-ms must be >= 0');
  const maxBatches = Number.parseInt(args['max-batches'] ?? '0', 10);
  if (!Number.isInteger(maxBatches) || maxBatches < 0) {
    throw new Error('--max-batches must be >= 0 (0 = unlimited)');
  }
  const checkpoint = args.checkpoint == null || args.checkpoint === true
    ? null : String(args.checkpoint);
  if (apply && !checkpoint) throw new Error('--apply requires --checkpoint <file>');
  return { apply, batchSize, sleepMs, maxBatches, checkpoint };
}

function readCheckpoint(file) {
  const initial = { afterBlock: '-1', afterLogIndex: '-1' };
  if (!file || !fs.existsSync(file)) return initial;
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  return {
    afterBlock: String(stored.afterBlock ?? '-1'),
    afterLogIndex: String(stored.afterLogIndex ?? '-1'),
  };
}

function writeCheckpoint(file, cursor) {
  if (file) fs.writeFileSync(file, JSON.stringify(cursor, null, 2));
}

function toPayload(rows) {
  return rows.map((row) => ({
    chain: row.chain,
    transaction_hash: row.transaction_hash,
    log_index: String(row.log_index),
    fdv_usd: row.fdv_usd == null ? null : String(row.fdv_usd),
    token_total_supply_raw: row.token_total_supply_raw == null
      ? null : String(row.token_total_supply_raw),
  }));
}

async function run(deps = {}) {
  const database = deps.database || db;
  const options = deps.options || parseArgs();
  const cursor = readCheckpoint(options.checkpoint);
  const summary = {
    apply: options.apply, scanned: 0, upserted: 0, batches: 0, lastBlock: null,
  };
  for (;;) {
    if (options.maxBatches && summary.batches >= options.maxBatches) break;
    const { rows } = await database.query(
      SELECT_BATCH_SQL, [cursor.afterBlock, cursor.afterLogIndex, options.batchSize],
    );
    if (rows.length === 0) break;
    summary.scanned += rows.length;
    if (options.apply) {
      const result = await database.query(UPSERT_SQL, [JSON.stringify(toPayload(rows))]);
      summary.upserted += result.rowCount || 0;
    }
    const last = rows[rows.length - 1];
    cursor.afterBlock = String(last.block_number);
    cursor.afterLogIndex = String(last.log_index);
    summary.lastBlock = cursor.afterBlock;
    summary.batches += 1;
    if (options.apply) writeCheckpoint(options.checkpoint, cursor);
    if (options.sleepMs) await delay(options.sleepMs);
  }
  return summary;
}

async function main() {
  try {
    const summary = await run();
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    console.error('swap-mc backfill failed:', error.message);
    process.exitCode = 1;
  } finally {
    try { await db.pool.end(); } catch (_) {}
  }
}

if (require.main === module) void main();

module.exports = {
  run,
  parseArgs,
  __private: { SELECT_BATCH_SQL, UPSERT_SQL, readCheckpoint, writeCheckpoint, toPayload },
};
