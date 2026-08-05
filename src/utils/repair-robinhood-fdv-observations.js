const fs = require('node:fs');
const db = require('../models/db');
const {
  MAX_FINITE_HUMAN_SUPPLY,
  formatDecimal,
  multiply,
  parseDecimal,
  rational,
} = require('../services/evm-market-metrics');

// Data repair for the two FDV defects (see fixes f9bd2b15 + 2d3a35af):
//   Pass 1 - transposition: robinhood-processing reprocessed captures with the
//     wrong quoteIndex, swapping token_amount_raw <-> quote_amount_raw for pools
//     whose quote is token1. price/fdv/volume/side are inverted. The decimals,
//     supply and quote USD price were never swapped, so the true values are
//     recoverable by swapping the two raw amounts back and revaluing in place.
//   Pass 2 - invalid supply: more than 1e15 whole tokens makes FDV meaningless
//     under the runtime valuation guard. Price/volume remain correct; set only
//     FDV to null.
// Run rebuilds of the 1m/1h/agg buckets AFTER this (they re-aggregate from the
// corrected observations). Dry-run by default; nothing is written without --mode write.

const ABSURD_FDV = '1e12';   // symptom that isolates a transposed (capped-supply) row
const SANE_FDV_MAX = 1e11;   // a repaired row must fall back into a sane FDV
const MAX_FINITE_HUMAN_SUPPLY_TEXT = MAX_FINITE_HUMAN_SUPPLY.toString();

const PRICE_PLACES = 80;
const USD_PLACES = 12;
const Q192 = 1n << 192n;

// Pure recompute of one transposed observation. Returns the corrected fields, or
// { skip: reason } when the swap does not resolve into a valid, sane valuation.
function recomputeTransposed(row) {
  const tokenDec = Number(row.token_decimals);
  const quoteDec = Number(row.quote_decimals);
  if (!Number.isInteger(tokenDec) || !Number.isInteger(quoteDec)) return { skip: 'bad_decimals' };
  // Stored token/quote raws are swapped: the token's amount landed in quote_amount_raw.
  const trueTokenRaw = BigInt(row.quote_amount_raw);
  const trueQuoteRaw = BigInt(row.token_amount_raw);
  if (trueTokenRaw <= 0n || trueQuoteRaw <= 0n) return { skip: 'non_positive_amount' };
  const tokenScale = 10n ** BigInt(tokenDec);
  const quoteScale = 10n ** BigInt(quoteDec);
  const supplyRaw = BigInt(row.token_total_supply_raw);

  const tokenAmount = rational(trueTokenRaw, tokenScale);
  const quoteAmount = rational(trueQuoteRaw, quoteScale);
  const priceQuote = rational(trueQuoteRaw * tokenScale, trueTokenRaw * quoteScale);
  const quoteUsd = parseDecimal(row.quote_usd_price);
  const priceUsd = multiply(priceQuote, quoteUsd);
  const volumeUsd = multiply(quoteAmount, quoteUsd);
  const fdvUsd = supplyRaw <= MAX_FINITE_HUMAN_SUPPLY * tokenScale
    ? multiply(priceUsd, rational(supplyRaw, tokenScale))
    : null;

  const priceUsdText = formatDecimal(priceUsd, PRICE_PLACES);
  if (priceUsdText === '0') return { skip: 'price_below_precision' };
  const fdvUsdText = fdvUsd ? formatDecimal(fdvUsd, USD_PLACES) : null;
  if (fdvUsdText != null && Number(fdvUsdText) > SANE_FDV_MAX) return { skip: 'still_absurd' };

  return {
    tokenAmountRaw: trueTokenRaw.toString(),
    quoteAmountRaw: trueQuoteRaw.toString(),
    tokenAmount: formatDecimal(tokenAmount),
    quoteAmount: formatDecimal(quoteAmount),
    priceQuote: formatDecimal(priceQuote, PRICE_PLACES),
    priceUsd: priceUsdText,
    volumeUsd: formatDecimal(volumeUsd, USD_PLACES),
    fdvUsd: fdvUsdText,
    side: row.side === 'buy' ? 'sell' : 'buy',
  };
}

const SELECT_TRANSPOSED = `
  SELECT chain, transaction_hash, log_index, block_number, side,
         token_decimals, quote_decimals, token_total_supply_raw,
         token_amount_raw, quote_amount_raw, quote_usd_price
   FROM robinhood_market_observations
   WHERE chain = 'robinhood' AND status = 'accepted'
     AND protocol IN ('uniswap-v2', 'uniswap-v3')
     AND fdv_usd::numeric > $1::numeric
     AND token_total_supply_raw::numeric
       <= $2::numeric * power(10::numeric, token_decimals)
     AND (block_number, log_index) > ($4::bigint, $5::bigint)
   ORDER BY block_number, log_index
   LIMIT $3`;

const UPDATE_TRANSPOSED = `
  UPDATE robinhood_market_observations SET
    token_amount_raw = $4, quote_amount_raw = $5,
    token_amount = $6, quote_amount = $7,
    price_quote = $8, price_usd = $9, volume_usd = $10, fdv_usd = $11,
    side = $12
  WHERE chain = $1 AND transaction_hash = $2 AND log_index = $3`;

const UPDATE_UNCAPPED = `
  UPDATE robinhood_market_observations SET fdv_usd = NULL
   WHERE chain = 'robinhood' AND status = 'accepted'
     AND token_total_supply_raw::numeric
       > $1::numeric * power(10::numeric, token_decimals)
     AND fdv_usd IS NOT NULL`;

const COUNT_TRANSPOSED = `
  SELECT COUNT(*)::int AS n FROM robinhood_market_observations
   WHERE chain = 'robinhood' AND status = 'accepted'
     AND protocol IN ('uniswap-v2', 'uniswap-v3')
     AND fdv_usd::numeric > $1::numeric
     AND token_total_supply_raw::numeric
       <= $2::numeric * power(10::numeric, token_decimals)`;

const COUNT_UNCAPPED = `
  SELECT COUNT(*)::int AS n FROM robinhood_market_observations
   WHERE chain = 'robinhood' AND status = 'accepted'
     AND token_total_supply_raw::numeric
       > $1::numeric * power(10::numeric, token_decimals)
     AND fdv_usd IS NOT NULL`;

// V4 native-ETH transposition (live decode bug fixed in b04e0790): the head decoder
// derived the v4 quote slot from the WETH substitute address instead of native ETH's
// 0x0 (currency0), so it stored the ETH quote amount in token_amount_raw and the token
// amount in quote_amount_raw — inflating price/volume by ~1e9. Corrupt rows report
// price in the millions; real v4 prices are sub-cent, so price_usd > 1e6 isolates them.
// recomputeTransposed reverses it exactly (same swap+revalue as v2/v3).
const V4_TRANSPOSED_SYMPTOM_PRICE = '1e6';

const SELECT_V4_TRANSPOSED = `
  SELECT chain, transaction_hash, log_index, block_number, side,
         token_decimals, quote_decimals, token_total_supply_raw,
         token_amount_raw, quote_amount_raw, quote_usd_price
    FROM robinhood_market_observations
   WHERE chain = 'robinhood' AND status = 'accepted'
     AND market_key LIKE 'robinhood:uniswap-v4:%'
     AND price_usd::numeric > $1::numeric
     AND token_total_supply_raw::numeric
       <= $2::numeric * power(10::numeric, token_decimals)
     AND (block_number, log_index) > ($4::bigint, $5::bigint)
   ORDER BY block_number, log_index
   LIMIT $3`;

const COUNT_V4_TRANSPOSED = `
  SELECT COUNT(*)::int AS n FROM robinhood_market_observations
   WHERE chain = 'robinhood' AND status = 'accepted'
     AND market_key LIKE 'robinhood:uniswap-v4:%'
     AND price_usd::numeric > $1::numeric
     AND token_total_supply_raw::numeric
       <= $2::numeric * power(10::numeric, token_decimals)`;

// Transposition repair is identical across variants — swap the two raw amounts back
// and revalue with recomputeTransposed. Only the candidate query differs (v2/v3 keys
// off the absurd FDV, v4 off the inflated price), so both share this keyset walk.
// `pass.filterParams` fill the query's leading placeholders; the batch size and the
// (block, log) cursor always follow them.
async function runTransposedPass(database, { mode, batchSize }, pass) {
  const write = mode === 'write';
  const summary = { candidates: 0, repaired: 0, wouldRepair: 0, skipped: {}, sample: [] };
  const counted = await database.query(pass.countSql, pass.filterParams);
  summary.candidates = counted.rows[0].n;

  // Keyset cursor over (block_number, log_index): skipped rows still match the
  // symptom filter, so we must advance past them rather than re-select them.
  // Dry-run walks every candidate the same way but only tallies outcomes, so the
  // preview reports the true repair/skip split before anything is written.
  let cursorBlock = '-1';
  let cursorLog = '0';
  for (;;) {
    const batch = await database.query(
      pass.selectSql, [...pass.filterParams, batchSize, cursorBlock, cursorLog]
    );
    if (batch.rows.length === 0) break;
    const client = write ? await database.getClient() : null;
    try {
      if (write) await client.query('BEGIN');
      for (const row of batch.rows) {
        const fixed = recomputeTransposed(row);
        if (summary.sample.length < 3) {
          summary.sample.push({
            tx: `${row.transaction_hash}:${row.log_index}`,
            before: { tokenRaw: row.token_amount_raw, quoteRaw: row.quote_amount_raw, side: row.side },
            after: fixed,
          });
        }
        if (fixed.skip) {
          summary.skipped[fixed.skip] = (summary.skipped[fixed.skip] || 0) + 1;
          continue;
        }
        if (write) {
          await client.query(UPDATE_TRANSPOSED, [
            row.chain, row.transaction_hash, row.log_index,
            fixed.tokenAmountRaw, fixed.quoteAmountRaw, fixed.tokenAmount, fixed.quoteAmount,
            fixed.priceQuote, fixed.priceUsd, fixed.volumeUsd, fixed.fdvUsd, fixed.side,
          ]);
          summary.repaired += 1;
        } else {
          summary.wouldRepair += 1;
        }
      }
      if (write) await client.query('COMMIT');
    } catch (error) {
      if (write) { try { await client.query('ROLLBACK'); } catch (_) {} }
      throw error;
    } finally {
      if (client) client.release();
    }
    // In write mode, repaired rows drop out of the filter; the cursor still moves
    // forward so skipped rows are passed exactly once.
    const last = batch.rows[batch.rows.length - 1];
    cursorBlock = String(last.block_number);
    cursorLog = String(last.log_index);
  }
  return summary;
}

const V2_V3_TRANSPOSED_PASS = {
  countSql: COUNT_TRANSPOSED, selectSql: SELECT_TRANSPOSED,
  filterParams: [ABSURD_FDV, MAX_FINITE_HUMAN_SUPPLY_TEXT],
};
const V4_TRANSPOSED_PASS = {
  countSql: COUNT_V4_TRANSPOSED, selectSql: SELECT_V4_TRANSPOSED,
  filterParams: [V4_TRANSPOSED_SYMPTOM_PRICE, MAX_FINITE_HUMAN_SUPPLY_TEXT],
};

const repairTransposed = (database, options) => runTransposedPass(database, options, V2_V3_TRANSPOSED_PASS);
const repairV4Transposed = (database, options) => runTransposedPass(database, options, V4_TRANSPOSED_PASS);

const SELECT_SPOT_ROWS = `
  SELECT observation.chain, observation.transaction_hash, observation.log_index,
         observation.block_number, observation.protocol, observation.token_address,
         observation.quote_address, observation.token_decimals, observation.quote_decimals,
         observation.token_total_supply_raw, observation.quote_usd_price,
         observation.price_quote, observation.price_usd, observation.fdv_usd,
         COALESCE(staging.data, capture.data) AS log_data,
         COALESCE(registry.metadata ->> 'quoteIndex', capture.evidence ->> 'quoteIndex')
           AS quote_index,
         CASE WHEN staging.data IS NOT NULL THEN 'backfill-staging'
              WHEN capture.data IS NOT NULL THEN 'head-capture' END AS evidence_source
    FROM robinhood_market_observations observation
    LEFT JOIN robinhood_market_log_staging staging
      ON staging.chain = observation.chain
     AND staging.transaction_hash = observation.transaction_hash
     AND staging.log_index = observation.log_index
    LEFT JOIN robinhood_head_captures capture
      ON capture.chain = observation.chain
     AND capture.transaction_hash = observation.transaction_hash
     AND capture.log_index = observation.log_index
    LEFT JOIN robinhood_pool_registry registry
      ON registry.chain = observation.chain
     AND registry.protocol = observation.protocol
     AND registry.market_key = observation.market_key
   WHERE observation.chain = 'robinhood' AND observation.status = 'accepted'
     AND observation.protocol IN ('uniswap-v3', 'uniswap-v4')
     AND observation.block_number BETWEEN $1::bigint AND $2::bigint
     AND (observation.block_number, observation.log_index, observation.transaction_hash)
       > ($3::bigint, $4::bigint, $5::text)
   ORDER BY observation.block_number, observation.log_index, observation.transaction_hash
   LIMIT $6`;

const UPDATE_SPOT_ROWS = `
  UPDATE robinhood_market_observations observation SET
    price_quote = item.price_quote::numeric,
    price_usd = item.price_usd::numeric,
    fdv_usd = item.fdv_usd::numeric
  FROM jsonb_to_recordset($1::jsonb) AS item(
    transaction_hash text, log_index bigint, price_quote text, price_usd text, fdv_usd text
  )
  WHERE observation.chain = 'robinhood'
    AND observation.transaction_hash = item.transaction_hash
    AND observation.log_index = item.log_index
    AND observation.status = 'accepted'
    AND observation.protocol IN ('uniswap-v3', 'uniswap-v4')
    AND (observation.price_quote, observation.price_usd, observation.fdv_usd)
      IS DISTINCT FROM (item.price_quote::numeric, item.price_usd::numeric, item.fdv_usd::numeric)`;

function decimalText(value) {
  return value == null ? null : String(value).replace(/\.0+$/, '');
}

function spotSqrtPrice(data, protocol) {
  const words = protocol === 'uniswap-v3' ? 5 : 6;
  const raw = String(data || '').toLowerCase();
  if (!new RegExp(`^0x[0-9a-f]{${words * 64}}$`).test(raw)) {
    throw new Error(`${protocol} swap data has an invalid ABI length`);
  }
  const sqrt = BigInt(`0x${raw.slice(2 + (2 * 64), 2 + (3 * 64))}`);
  if (sqrt <= 0n || sqrt >= 1n << 160n) throw new Error('sqrtPriceX96 is outside uint160');
  return sqrt;
}

function recomputeSpot(row) {
  const tokenDecimals = Number(row.token_decimals);
  const quoteDecimals = Number(row.quote_decimals);
  if (!Number.isInteger(tokenDecimals) || !Number.isInteger(quoteDecimals)) {
    return { skip: 'bad_decimals' };
  }
  if (row.log_data == null) return { skip: 'missing_raw_log' };
  const quoteIndex = row.protocol === 'uniswap-v3'
    ? (BigInt(row.quote_address) < BigInt(row.token_address) ? 0 : 1)
    : (row.quote_index == null || row.quote_index === '' ? Number.NaN : Number(row.quote_index));
  if (![0, 1].includes(quoteIndex)) return { skip: 'missing_quote_index' };

  try {
    const sqrt = spotSqrtPrice(row.log_data, row.protocol);
    const squared = sqrt ** 2n;
    const rawPrice = quoteIndex === 0 ? rational(Q192, squared) : rational(squared, Q192);
    const priceQuote = multiply(
      rawPrice,
      rational(10n ** BigInt(tokenDecimals), 10n ** BigInt(quoteDecimals)),
    );
    const priceUsd = multiply(priceQuote, parseDecimal(row.quote_usd_price));
    const supplyRaw = BigInt(row.token_total_supply_raw);
    const supplyScale = 10n ** BigInt(tokenDecimals);
    const fdvUsd = supplyRaw <= MAX_FINITE_HUMAN_SUPPLY * supplyScale
      ? multiply(priceUsd, rational(supplyRaw, supplyScale))
      : null;
    const result = {
      priceQuote: formatDecimal(priceQuote, PRICE_PLACES),
      priceUsd: formatDecimal(priceUsd, PRICE_PLACES),
      fdvUsd: fdvUsd ? formatDecimal(fdvUsd, USD_PLACES) : null,
    };
    if (result.priceQuote === '0' || result.priceUsd === '0') return { skip: 'price_below_precision' };
    return result;
  } catch (_) {
    return { skip: 'invalid_evidence' };
  }
}

function readSpotCheckpoint(options) {
  const initial = {
    fromBlock: options.fromBlock, toBlock: options.toBlock,
    afterBlock: options.fromBlock, afterLogIndex: '-1', afterTransactionHash: '',
  };
  if (!options.checkpoint || !fs.existsSync(options.checkpoint)) return initial;
  const stored = JSON.parse(fs.readFileSync(options.checkpoint, 'utf8'));
  if (stored.fromBlock !== options.fromBlock || stored.toBlock !== options.toBlock) {
    throw new Error('checkpoint bounds do not match --from-block/--to-block');
  }
  return stored;
}

function writeSpotCheckpoint(file, value) {
  if (!file) return;
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function spotFieldsChanged(row, fixed) {
  return decimalText(row.price_quote) !== decimalText(fixed.priceQuote)
    || decimalText(row.price_usd) !== decimalText(fixed.priceUsd)
    || decimalText(row.fdv_usd) !== decimalText(fixed.fdvUsd);
}

function collectSpotUpdates(rows, summary) {
  const updates = [];
  for (const row of rows) {
    summary.scanned += 1;
    const source = row.evidence_source || 'missing';
    summary.sources[source] = (summary.sources[source] || 0) + 1;
    const fixed = recomputeSpot(row);
    if (fixed.skip) {
      summary.skipped[fixed.skip] = (summary.skipped[fixed.skip] || 0) + 1;
    } else if (!spotFieldsChanged(row, fixed)) {
      summary.unchanged += 1;
    } else {
      updates.push({
        transaction_hash: row.transaction_hash, log_index: row.log_index,
        price_quote: fixed.priceQuote, price_usd: fixed.priceUsd, fdv_usd: fixed.fdvUsd,
      });
    }
  }
  return updates;
}

async function persistSpotUpdates(database, updates, summary, write) {
  if (!write) {
    summary.wouldRepair += updates.length;
    return;
  }
  if (Object.keys(summary.skipped).length) {
    throw new Error(`spot repair stopped on incomplete evidence: ${JSON.stringify(summary.skipped)}`);
  }
  if (!updates.length) return;
  const updated = await database.query(UPDATE_SPOT_ROWS, [JSON.stringify(updates)]);
  summary.repaired += updated.rowCount || 0;
}

function advanceSpotCursor(cursor, rows, summary, options, write) {
  const last = rows[rows.length - 1];
  Object.assign(cursor, {
    afterBlock: String(last.block_number),
    afterLogIndex: String(last.log_index),
    afterTransactionHash: last.transaction_hash,
  });
  summary.batches += 1;
  summary.nextCursor = { ...cursor };
  if (write) writeSpotCheckpoint(options.checkpoint, cursor);
}

async function repairSpot(database, options) {
  const write = options.mode === 'write';
  const cursor = readSpotCheckpoint(options);
  const summary = {
    scanned: 0, repaired: 0, wouldRepair: 0, unchanged: 0,
    batches: 0, sources: {}, skipped: {}, nextCursor: null, complete: false,
  };
  for (;;) {
    const result = await database.query(SELECT_SPOT_ROWS, [
      options.fromBlock, options.toBlock, cursor.afterBlock,
      cursor.afterLogIndex, cursor.afterTransactionHash, options.batchSize,
    ]);
    if (!result.rows.length) {
      summary.complete = true;
      summary.nextCursor = null;
      break;
    }
    const updates = collectSpotUpdates(result.rows, summary);
    await persistSpotUpdates(database, updates, summary, write);
    advanceSpotCursor(cursor, result.rows, summary, options, write);
    if (options.maxBatches && summary.batches >= options.maxBatches) break;
  }
  return summary;
}

async function repairUncapped(database, { mode }) {
  const counted = await database.query(COUNT_UNCAPPED, [MAX_FINITE_HUMAN_SUPPLY_TEXT]);
  const summary = { candidates: counted.rows[0].n, cleared: 0 };
  if (mode === 'write') {
    const result = await database.query(UPDATE_UNCAPPED, [MAX_FINITE_HUMAN_SUPPLY_TEXT]);
    summary.cleared = result.rowCount || 0;
  }
  return summary;
}

function parseNamedArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const next = argv[i + 1];
    args[argv[i].slice(2)] = !next || next.startsWith('--') ? true : (i += 1, next);
  }
  return args;
}

function parseBaseOptions(args) {
  const mode = String(args.mode || 'dry-run').toLowerCase();
  if (!['dry-run', 'write'].includes(mode)) throw new Error('mode must be dry-run or write');
  const batchSize = Number.parseInt(args['batch-size'] || '500', 10);
  if (!Number.isInteger(batchSize) || batchSize <= 0) throw new Error('batch-size must be a positive integer');
  const target = String(args.target || 'all').toLowerCase();
  if (!['all', 'v4', 'supply', 'spot'].includes(target)) {
    throw new Error('target must be all, v4, supply or spot');
  }
  return { mode, batchSize, target };
}

function parseSpotOptions(args, mode) {
  const fromBlock = String(args['from-block'] ?? '0');
  const toBlock = String(args['to-block'] ?? '');
  if (!/^\d+$/.test(fromBlock) || !/^\d+$/.test(toBlock) || BigInt(toBlock) < BigInt(fromBlock)) {
    throw new Error('spot target requires valid --from-block and --to-block bounds');
  }
  const checkpoint = args.checkpoint == null ? null : String(args.checkpoint);
  if (mode === 'write' && !checkpoint) throw new Error('spot write requires --checkpoint');
  const maxBatches = Number.parseInt(args['max-batches'] ?? (mode === 'dry-run' ? '1' : '0'), 10);
  if (!Number.isInteger(maxBatches) || maxBatches < 0) {
    throw new Error('max-batches must be a non-negative integer');
  }
  return { fromBlock, toBlock, checkpoint, maxBatches };
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = parseNamedArgs(argv);
  const options = parseBaseOptions(args);
  return options.target === 'spot'
    ? { ...options, ...parseSpotOptions(args, options.mode) }
    : options;
}

async function runRepair(options, deps = {}) {
  const database = deps.database || db;
  // target=v4 repairs only the v4 native-ETH transposition, leaving every other row
  // untouched; the default keeps the original v2/v3 transposed + uncapped passes.
  if (options.target === 'v4') {
    return { mode: options.mode, target: 'v4', v4Transposed: await repairV4Transposed(database, options) };
  }
  if (options.target === 'supply') {
    return { mode: options.mode, target: 'supply', supply: await repairUncapped(database, options) };
  }
  if (options.target === 'spot') {
    return { mode: options.mode, target: 'spot', spot: await repairSpot(database, options) };
  }
  const transposed = await repairTransposed(database, options);
  const uncapped = await repairUncapped(database, options);
  return { mode: options.mode, transposed, uncapped };
}

async function run() {
  try {
    const summary = await runRepair(parseArgs());
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    console.error('[RobinhoodFdvRepair]', error.message);
    process.exitCode = 1;
  } finally {
    await db.pool.end().catch(() => {});
  }
}

if (require.main === module) void run();

module.exports = {
  run,
  runRepair,
  recomputeSpot,
  recomputeTransposed,
  __private: {
    parseArgs, repairSpot, repairTransposed, repairV4Transposed, repairUncapped,
    spotSqrtPrice,
  },
};
