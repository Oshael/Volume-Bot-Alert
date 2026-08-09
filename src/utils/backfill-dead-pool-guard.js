'use strict';

// Historical dead-pool cleanup that replays the EXACT live guard
// (src/services/robinhood-price-spike-guard.js) over persisted observations, so the
// past is scrubbed with the same rule that runs live — no coarse calendar-median
// approximation. Per token, in on-chain order, it keeps a rolling window of the last
// `sampleSize` accepted fdvs, bands each swap against that window's median (with the
// volume gate), and marks the out-of-band low-volume ones as
// status='rejected', rejection_reason='dead_pool_price'.
//
// Dry-run by default (counts only). Pass --apply to write. Checkpointed by token.
//
// Usage:
//   node src/utils/backfill-dead-pool-guard.js                      # dry-run, all tokens
//   node src/utils/backfill-dead-pool-guard.js --apply --checkpoint .dpg.json
//   node src/utils/backfill-dead-pool-guard.js --token 0x..         # one token (test)

const fs = require('fs');
const db = require('../models/db');
const { evaluateFdvBand } = require('../services/robinhood-price-spike-guard');

function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const next = argv[i + 1];
    args[key.slice(2)] = !next || next.startsWith('--') ? true : next;
    if (args[key.slice(2)] !== true) i += 1;
  }
  return {
    apply: args.apply === true,
    token: typeof args.token === 'string' ? args.token.toLowerCase() : null,
    maxMultiple: Number(args['max-multiple'] ?? 2.5),
    minVolumeUsd: Number(args['min-volume'] ?? 100),
    sampleSize: Math.max(1, Number(args['sample-size'] ?? 500)),
    recomputeEvery: Math.max(1, Number(args['recompute-every'] ?? 50)),
    checkpoint: typeof args.checkpoint === 'string' ? args.checkpoint : null,
    flushSize: Math.max(500, Number(args['flush-size'] ?? 5000)),
    sleepMs: Math.max(0, Number(args['sleep-ms'] ?? 0)),
  };
}

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function median(sortedAsc) {
  const n = sortedAsc.length;
  if (n === 0) return null;
  const mid = n >> 1;
  return n % 2 ? sortedAsc[mid] : (sortedAsc[mid - 1] + sortedAsc[mid]) / 2;
}

const TOKENS_SQL = `SELECT DISTINCT token_address FROM robinhood_market_observations
  WHERE chain = 'robinhood' AND status = 'accepted' AND token_address > $1
  ORDER BY token_address LIMIT $2::int`;

const OBS_SQL = `SELECT transaction_hash, log_index,
    fdv_usd::float8 AS fdv, volume_usd::float8 AS vol
  FROM robinhood_market_observations
  WHERE chain = 'robinhood' AND token_address = $1
    AND status = 'accepted' AND fdv_usd IS NOT NULL
  ORDER BY block_number, log_index`;

const APPLY_SQL = `UPDATE robinhood_market_observations o
  SET status = 'rejected', rejection_reason = 'dead_pool_price'
  FROM jsonb_to_recordset($1::jsonb) AS r(transaction_hash text, log_index bigint)
  WHERE o.chain = 'robinhood' AND o.status = 'accepted'
    AND o.transaction_hash = r.transaction_hash AND o.log_index = r.log_index`;

// Replay one token's ordered observations. Returns the reject list for it.
function replayToken(rows, options) {
  const window = [];
  const rejects = [];
  let reference = null;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    // Refresh the reference once the window has data and then every recomputeEvery
    // swaps (mirrors the live guard, which has a reference from the token's first swaps).
    if (window.length && (reference === null || i % options.recomputeEvery === 0)) {
      reference = median([...window].sort((a, b) => a - b));
    }
    const verdict = evaluateFdvBand({
      fdvUsd: row.fdv,
      reference,
      maxMultiple: options.maxMultiple,
      volumeUsd: row.vol,
      minVolumeUsd: options.minVolumeUsd,
    });
    if (verdict.outlier) {
      rejects.push({ transaction_hash: row.transaction_hash, log_index: String(row.log_index) });
    } else {
      // Only accepted values feed the reference (mirrors the live guard).
      window.push(row.fdv);
      if (window.length > options.sampleSize) window.shift();
    }
  }
  return rejects;
}

function readCheckpoint(file) {
  if (!file || !fs.existsSync(file)) return { afterToken: '', scanned: 0, rejected: 0 };
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function writeCheckpoint(file, state) {
  if (file) fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

async function flush(pending, options, summary) {
  if (pending.length === 0) return;
  if (options.apply) {
    const result = await db.query(APPLY_SQL, [JSON.stringify(pending)]);
    summary.rejected += result.rowCount || 0;
  } else {
    summary.rejected += pending.length;
  }
  pending.length = 0;
}

async function run() {
  const options = parseArgs();
  const checkpoint = options.token ? { afterToken: '', scanned: 0, rejected: 0 } : readCheckpoint(options.checkpoint);
  const summary = { apply: options.apply, tokens: 0, scanned: checkpoint.scanned || 0, rejected: checkpoint.rejected || 0 };
  const pending = [];

  const tokenBatch = async (afterToken) => {
    if (options.token) return afterToken ? [] : [{ token_address: options.token }];
    const { rows } = await db.query(TOKENS_SQL, [afterToken, 500]);
    return rows;
  };

  let afterToken = checkpoint.afterToken || '';
  for (;;) {
    const tokens = await tokenBatch(afterToken);
    if (tokens.length === 0) break;
    for (const { token_address: token } of tokens) {
      const { rows } = await db.query(OBS_SQL, [token]);
      summary.scanned += rows.length;
      const rejects = replayToken(rows, options);
      for (const r of rejects) {
        pending.push(r);
        if (pending.length >= options.flushSize) await flush(pending, options, summary);
      }
      summary.tokens += 1;
      afterToken = token;
      if (options.sleepMs) await delay(options.sleepMs);
    }
    await flush(pending, options, summary);
    if (!options.token && options.checkpoint) {
      writeCheckpoint(options.checkpoint, { afterToken, scanned: summary.scanned, rejected: summary.rejected });
    }
    if (options.token) break;
  }
  await flush(pending, options, summary);
  console.log(JSON.stringify(summary, null, 2));
}

run()
  .catch((error) => { console.error('[backfill-dead-pool-guard]', error.message); process.exitCode = 1; })
  .finally(() => db.pool.end().catch(() => {}));
