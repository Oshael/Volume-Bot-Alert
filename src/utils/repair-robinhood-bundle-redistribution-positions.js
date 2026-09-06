require('dotenv').config();

const db = require('../models/db');

const CHAIN = 'robinhood';
const ERROR_CODE = 'redistribution_source_not_ready';
const ERROR_FRAGMENT = '%transaction_position_missing%';
const CONFIRM_FLAG = '--confirm-repair-robinhood-bundle-redistribution-positions';

const SELECT_TOKENS_SQL = `SELECT token_address, observation_from_block::text
  FROM robinhood_bundle_redistribution_queue
 WHERE chain = $1 AND status = 'pending' AND last_error_code = $2
   AND last_error_message LIKE $3
   AND NOT (token_address = ANY($4::varchar[]))
 ORDER BY updated_at, token_address
 LIMIT $5 FOR UPDATE SKIP LOCKED`;

const REPAIR_SQL = `WITH tokens AS MATERIALIZED (
  SELECT token_address, observation_from_block::bigint
    FROM jsonb_to_recordset($1::jsonb)
      AS item(token_address text, observation_from_block text)
), needed AS MATERIALIZED (
  SELECT DISTINCT tokens.token_address,
         edge.first_wallet_transfer_transaction_hash AS transaction_hash,
         edge.first_wallet_transfer_log_index AS log_index,
         edge.first_wallet_transfer_at AS block_time
    FROM tokens
    INNER JOIN robinhood_holder_token_states state
      ON state.chain = '${CHAIN}' AND state.token_address = tokens.token_address
    INNER JOIN robinhood_wallet_transfer_edges edge
      ON edge.chain = '${CHAIN}' AND edge.classification_version = 'rh_transfer_v1'
     AND edge.token_address = tokens.token_address
    INNER JOIN robinhood_wallet_token_first_buys buy
      ON buy.chain = edge.chain AND buy.token_address = edge.token_address
     AND buy.wallet_address = edge.from_wallet
    LEFT JOIN robinhood_transaction_positions position
      ON position.chain = edge.chain
     AND position.transaction_hash = edge.first_wallet_transfer_transaction_hash
   WHERE edge.first_wallet_transfer_block >= tokens.observation_from_block
     AND edge.first_wallet_transfer_block <= state.live_through_block
     AND edge.first_wallet_transfer_block > buy.block_number
     AND edge.first_wallet_transfer_amount_raw > 0
     AND edge.from_wallet <> edge.to_wallet
     AND position.transaction_hash IS NULL
), resolved AS MATERIALIZED (
  SELECT needed.token_address, needed.transaction_hash,
         source.block_number, source.block_hash, source.transaction_index
    FROM needed
    CROSS JOIN LATERAL (
      SELECT event.block_number, event.block_hash, event.transaction_index
        FROM robinhood_token_transfer_events event
       WHERE event.chain = '${CHAIN}'
         AND event.block_time = needed.block_time
         AND event.transaction_hash = needed.transaction_hash
         AND event.log_index = needed.log_index
       LIMIT 1
    ) source
), position_source AS MATERIALIZED (
  SELECT DISTINCT ON (transaction_hash) transaction_hash,
         block_number, block_hash, transaction_index
    FROM resolved
   ORDER BY transaction_hash, block_number, transaction_index
), inserted AS (
  INSERT INTO robinhood_transaction_positions(
    chain, transaction_hash, block_number, block_hash, transaction_index
  ) SELECT '${CHAIN}', transaction_hash, block_number, block_hash, transaction_index
      FROM position_source WHERE $2::boolean
  ON CONFLICT (chain, transaction_hash) DO NOTHING
  RETURNING transaction_hash
), counts AS (
  SELECT tokens.token_address,
         COUNT(DISTINCT needed.transaction_hash)::integer AS needed,
         COUNT(DISTINCT resolved.transaction_hash)::integer AS recoverable
    FROM tokens
    LEFT JOIN needed USING (token_address)
    LEFT JOIN resolved USING (token_address, transaction_hash)
   GROUP BY tokens.token_address
)
SELECT counts.*, (SELECT COUNT(*)::integer FROM inserted) AS inserted
  FROM counts ORDER BY counts.token_address`;

function bounded(value, fallback, minimum, maximum, label) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function parseArgs(argv = []) {
  const values = {};
  let apply = false; let confirmed = false;
  for (const argument of argv) {
    if (argument === '--apply' && !apply) apply = true;
    else if (argument === CONFIRM_FLAG && !confirmed) confirmed = true;
    else {
      const match = /^--(batch-size|max-batches|pause-ms|statement-timeout-ms)=(.+)$/.exec(argument);
      if (!match || values[match[1]] != null) throw new Error(`unknown or repeated argument: ${argument}`);
      values[match[1]] = match[2];
    }
  }
  if (apply !== confirmed) throw new Error(`--apply requires ${CONFIRM_FLAG}`);
  return Object.freeze({
    apply, batchSize: bounded(values['batch-size'], 10, 1, 25, '--batch-size'),
    maxBatches: bounded(values['max-batches'], apply ? 1000 : 1, 1, 1000, '--max-batches'),
    pauseMs: bounded(values['pause-ms'], apply ? 250 : 0, 0, 60_000, '--pause-ms'),
    statementTimeoutMs: bounded(
      values['statement-timeout-ms'], 120_000, 5_000, 900_000, '--statement-timeout-ms'
    ),
  });
}

function summarize(rows, inserted) {
  const tokens = rows.map((row) => ({
    tokenAddress: row.token_address,
    needed: Number(row.needed), recoverable: Number(row.recoverable),
  }));
  const repaired = tokens.filter((item) => item.needed > 0
    && item.needed === item.recoverable);
  return Object.freeze({
    selected: tokens.length,
    needed: tokens.reduce((sum, item) => sum + item.needed, 0),
    recoverable: tokens.reduce((sum, item) => sum + item.recoverable, 0),
    inserted: Number(inserted || 0), repaired: repaired.length,
    repairedTokens: Object.freeze(repaired.map((item) => item.tokenAddress)),
    unresolved: Object.freeze(tokens.filter((item) => !repaired.includes(item))),
  });
}

async function repairBatch(database, input = {}) {
  const client = await database.getClient();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('statement_timeout', $1, true)", [
      `${input.statementTimeoutMs}ms`,
    ]);
    const selected = await client.query(SELECT_TOKENS_SQL, [
      CHAIN, ERROR_CODE, ERROR_FRAGMENT, input.exclude || [], input.batchSize,
    ]);
    if (!selected.rowCount) {
      await client.query('COMMIT');
      return summarize([], 0);
    }
    const evidence = await client.query(REPAIR_SQL, [JSON.stringify(selected.rows), input.apply]);
    const result = summarize(evidence.rows, evidence.rows[0]?.inserted);
    if (input.apply && result.repairedTokens.length) {
      await client.query(`UPDATE robinhood_bundle_redistribution_queue SET
          next_attempt_at = NOW(), last_error_code = NULL, last_error_message = NULL,
          updated_at = NOW()
        WHERE chain = $1 AND status = 'pending'
          AND token_address = ANY($2::varchar[])`, [CHAIN, result.repairedTokens]);
    }
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function countPending(database) {
  const { rows } = await database.query(`SELECT COUNT(*)::integer AS total
    FROM robinhood_bundle_redistribution_queue
   WHERE chain = $1 AND status = 'pending' AND last_error_code = $2
     AND last_error_message LIKE $3`, [CHAIN, ERROR_CODE, ERROR_FRAGMENT]);
  return Number(rows[0]?.total || 0);
}

async function execute(options, deps = {}) {
  const database = deps.database || db; const logger = deps.logger || console;
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const excluded = new Set();
  const totals = { batches: 0, selected: 0, needed: 0, recoverable: 0,
    inserted: 0, repaired: 0 };
  for (let batch = 1; batch <= options.maxBatches; batch += 1) {
    const result = await (deps.repairBatch || repairBatch)(database, {
      ...options, exclude: [...excluded],
    });
    if (!result.selected) break;
    totals.batches += 1;
    for (const field of ['selected', 'needed', 'recoverable', 'inserted', 'repaired']) {
      totals[field] += result[field];
    }
    for (const item of result.unresolved) excluded.add(item.tokenAddress);
    for (const token of result.repairedTokens) excluded.add(token);
    logger.log(JSON.stringify({ batch, ...result }));
    if (options.pauseMs && batch < options.maxBatches) await sleep(options.pauseMs);
  }
  const pending = options.apply ? await (deps.countPending || countPending)(database) : null;
  return Object.freeze({ mode: options.apply ? 'apply' : 'read-only',
    status: pending == null ? 'preview' : pending === 0 ? 'drained' : 'partial',
    ...totals, pending, unresolvedTokens: excluded.size - totals.repaired });
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const options = parseArgs(argv);
  const report = await execute(options, deps);
  const logger = deps.logger || console;
  logger.log(JSON.stringify(report, null, 2));
  if (!options.apply) logger.log(`No data changed. Re-run with --apply ${CONFIRM_FLAG}.`);
  return report;
}

if (require.main === module) main().catch((error) => {
  console.error('[BundleRedistributionPositionRepair] Fatal:', error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = {
  CONFIRM_FLAG, REPAIR_SQL, SELECT_TOKENS_SQL, execute, main, parseArgs, repairBatch, summarize,
};
