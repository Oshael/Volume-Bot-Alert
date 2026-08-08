'use strict';

// READ-ONLY proof-of-concept for the dead-pool price-spike guard. It replays the
// EXACT guard logic (src/services/robinhood-price-spike-guard.js) over the real,
// already-persisted observations of a token and reports what WOULD be rejected vs
// kept. It writes NOTHING. Use it to confirm the guard kills the fake wicks without
// touching real data before wiring it into ingestion.
//
// Usage:
//   node src/utils/poc-price-spike-guard.js --token 0x<addr> [--max-multiple 8] [--recover-after 3]

const db = require('../models/db');
const { replayMarket } = require('../services/robinhood-price-spike-guard');

function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const next = argv[i + 1];
    args[key.slice(2)] = !next || next.startsWith('--') ? true : next;
    if (args[key.slice(2)] !== true) i += 1;
  }
  const token = typeof args.token === 'string' ? args.token.toLowerCase() : null;
  if (!token) throw new Error('--token <address> is required');
  return {
    token,
    maxMultiple: Number(args['max-multiple'] ?? 8),
    recoverAfter: Number(args['recover-after'] ?? 3),
    ceiling: Number(args.ceiling ?? 10e9), // absolute cap fallback; 0 disables
    hardMultiple: Number(args['hard-multiple'] ?? 5), // adaptive cap = this x token median fdv
  };
}

// One time-ordered sequence for the whole token (gate on token-level fdv, which is
// stable across pools) rather than per-pool price (sparse pools give a bad reference).
const LOAD_SQL = `
  SELECT block_number, log_index,
         price_usd::float8 AS price, fdv_usd::float8 AS fdv
  FROM robinhood_market_observations
  WHERE chain = 'robinhood' AND token_address = $1 AND status = 'accepted'
    AND fdv_usd IS NOT NULL
  ORDER BY block_number, log_index`;

function quantile(sortedAsc, q) {
  if (sortedAsc.length === 0) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.floor(q * (sortedAsc.length - 1))));
  return sortedAsc[idx];
}
const money = (x) => (x == null ? 'n/a' : `$${(x / 1e6).toFixed(2)}M`);

async function run() {
  const options = parseArgs();
  const { rows } = await db.query(LOAD_SQL, [options.token]);
  if (rows.length === 0) {
    console.log('no accepted observations for that token');
    return;
  }

  // Adaptive per-token hard cap: hardMultiple x the token's median fdv. The median is
  // robust (fakes are <0.01% of rows), so it reflects the token's real level and the
  // cap scales per token — catching clustered/first-swap fakes the relative gate misses,
  // AND small relative fakes (e.g. $40M on a $5M token) that no absolute ceiling could.
  const allFdv = rows.map((r) => r.fdv).filter((x) => x != null).sort((a, b) => a - b);
  const median = quantile(allFdv, 0.5) || 0;
  const adaptiveCap = median > 0 ? options.hardMultiple * median : Infinity;
  const effectiveCeiling = options.ceiling > 0 ? Math.min(options.ceiling, adaptiveCap) : adaptiveCap;

  const kept = [];
  const rejected = [];
  const verdicts = replayMarket(
    rows.map((r) => ({ value: r.fdv })),
    { ...options, ceiling: effectiveCeiling }
  );
  verdicts.forEach((v, i) => (v.spike ? rejected : kept).push(rows[i]));

  const keptFdv = kept.map((r) => r.fdv).filter((x) => x != null).sort((a, b) => a - b);
  const rejFdv = rejected.map((r) => r.fdv).filter((x) => x != null).sort((a, b) => a - b);

  // Guard-rails on the guard itself:
  //  - overReject  = rejected rows whose FDV sits inside the KEPT normal band (p95).
  //                  These would be FALSE POSITIVES (real data wrongly dropped).
  //  - falseNeg    = kept rows still absurd (FDV > $10B) that the guard MISSED.
  const keptP95 = quantile(keptFdv, 0.95);
  const overReject = rejected.filter((r) => r.fdv != null && keptP95 != null && r.fdv <= keptP95).length;
  const falseNeg = kept.filter((r) => r.fdv != null && r.fdv > effectiveCeiling).length;

  console.log(`Token ${options.token}   K=${options.maxMultiple}  recoverAfter=${options.recoverAfter}`);
  console.log(`token median FDV ${money(median)}  ->  adaptive cap (${options.hardMultiple}x) ${money(adaptiveCap)}  ->  effective ceiling ${money(effectiveCeiling)}`);
  console.log(`Observations: ${rows.length}`);
  console.log('');
  console.log(`REJECTED (spikes): ${rejected.length}  (${(100 * rejected.length / rows.length).toFixed(3)}%)`);
  console.log(`  rejected FDV   min ${money(rejFdv[0])}   p50 ${money(quantile(rejFdv, 0.5))}   max ${money(rejFdv[rejFdv.length - 1])}`);
  console.log(`KEPT (real):     ${kept.length}`);
  console.log(`  kept FDV       min ${money(keptFdv[0])}   p50 ${money(quantile(keptFdv, 0.5))}   p95 ${money(keptP95)}   MAX ${money(keptFdv[keptFdv.length - 1])}`);
  console.log('');
  console.log('sample rejected  (block | price_usd | fdv):');
  rejected
    .slice()
    .sort((a, b) => (b.fdv || 0) - (a.fdv || 0))
    .slice(0, 8)
    .forEach((r) => console.log(`  ${r.block_number}  |  ${r.price}  |  ${money(r.fdv)}`));
  console.log('');
  console.log('--- SANITY ---');
  console.log(`KEPT max FDV = ${money(keptFdv[keptFdv.length - 1])}  <-- should look like this token's REAL market cap`);
  console.log(`false positives (rejected but inside normal band): ${overReject}  <-- want ~0`);
  console.log(`missed spikes  (kept but FDV > effective ceiling): ${falseNeg}  <-- want 0`);
}

run()
  .catch((error) => {
    console.error('[poc-price-spike-guard]', error.message);
    process.exitCode = 1;
  })
  .finally(() => db.pool.end().catch(() => {}));
