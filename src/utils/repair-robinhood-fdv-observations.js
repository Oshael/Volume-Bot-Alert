const db = require('../models/db');
const { formatDecimal, multiply, parseDecimal, rational } = require('../services/evm-market-metrics');

// Data repair for the two FDV defects (see fixes f9bd2b15 + 2d3a35af):
//   Pass 1 - transposition: robinhood-processing reprocessed captures with the
//     wrong quoteIndex, swapping token_amount_raw <-> quote_amount_raw for pools
//     whose quote is token1. price/fdv/volume/side are inverted. The decimals,
//     supply and quote USD price were never swapped, so the true values are
//     recoverable by swapping the two raw amounts back and revaluing in place.
//   Pass 2 - uncapped supply: a uint256-max totalSupply produced FDV = price *
//     ~1e77. price/volume are correct (these rows were correctly oriented), only
//     the FDV is meaningless -> set it null (matches the new valuation guard).
// Run rebuilds of the 1m/1h/agg buckets AFTER this (they re-aggregate from the
// corrected observations). Dry-run by default; nothing is written without --mode write.

const UNCAPPED_SUPPLY_RAW = (1n << 255n).toString();
const ABSURD_FDV = '1e12';   // symptom that isolates a transposed (capped-supply) row
const SANE_FDV_MAX = 1e11;   // a repaired row must fall back into a sane FDV

const PRICE_PLACES = 80;
const USD_PLACES = 12;

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
  const fdvUsd = supplyRaw < BigInt(UNCAPPED_SUPPLY_RAW)
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
     AND fdv_usd::numeric > $1::numeric
     AND token_total_supply_raw::numeric < $2::numeric
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
     AND token_total_supply_raw::numeric >= $1::numeric
     AND fdv_usd IS NOT NULL`;

const COUNT_TRANSPOSED = `
  SELECT COUNT(*)::int AS n FROM robinhood_market_observations
   WHERE chain = 'robinhood' AND status = 'accepted'
     AND fdv_usd::numeric > $1::numeric
     AND token_total_supply_raw::numeric < $2::numeric`;

const COUNT_UNCAPPED = `
  SELECT COUNT(*)::int AS n FROM robinhood_market_observations
   WHERE chain = 'robinhood' AND status = 'accepted'
     AND token_total_supply_raw::numeric >= $1::numeric
     AND fdv_usd IS NOT NULL`;

async function repairTransposed(database, { mode, batchSize }) {
  const write = mode === 'write';
  const summary = { candidates: 0, repaired: 0, wouldRepair: 0, skipped: {}, sample: [] };
  const counted = await database.query(COUNT_TRANSPOSED, [ABSURD_FDV, UNCAPPED_SUPPLY_RAW]);
  summary.candidates = counted.rows[0].n;

  // Keyset cursor over (block_number, log_index): skipped rows still match the
  // absurd-FDV filter, so we must advance past them rather than re-select them.
  // Dry-run walks every candidate the same way but only tallies outcomes, so the
  // preview reports the true repair/skip split before anything is written.
  let cursorBlock = '-1';
  let cursorLog = '0';
  for (;;) {
    const batch = await database.query(
      SELECT_TRANSPOSED, [ABSURD_FDV, UNCAPPED_SUPPLY_RAW, batchSize, cursorBlock, cursorLog]
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

async function repairUncapped(database, { mode }) {
  const counted = await database.query(COUNT_UNCAPPED, [UNCAPPED_SUPPLY_RAW]);
  const summary = { candidates: counted.rows[0].n, cleared: 0 };
  if (mode === 'write') {
    const result = await database.query(UPDATE_UNCAPPED, [UNCAPPED_SUPPLY_RAW]);
    summary.cleared = result.rowCount || 0;
  }
  return summary;
}

function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const next = argv[i + 1];
    args[argv[i].slice(2)] = !next || next.startsWith('--') ? true : (i += 1, next);
  }
  const mode = String(args.mode || 'dry-run').toLowerCase();
  if (!['dry-run', 'write'].includes(mode)) throw new Error('mode must be dry-run or write');
  const batchSize = Number.parseInt(args['batch-size'] || '500', 10);
  if (!Number.isInteger(batchSize) || batchSize <= 0) throw new Error('batch-size must be a positive integer');
  return { mode, batchSize };
}

async function runRepair(options, deps = {}) {
  const database = deps.database || db;
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
  recomputeTransposed,
  UNCAPPED_SUPPLY_RAW,
  __private: { parseArgs, repairTransposed, repairUncapped },
};
