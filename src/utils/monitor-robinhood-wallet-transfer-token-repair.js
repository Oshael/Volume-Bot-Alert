require('dotenv').config();

const db = require('../models/db');

const TARGET_VERSION = 'rh_transfer_v1';

function boundedArg(argv, prefix, fallback, minimum, maximum) {
  const matches = argv.filter((arg) => arg.startsWith(prefix));
  if (matches.length > 1) throw new Error(`${prefix.slice(0, -1)} cannot be repeated`);
  if (!matches.length) return fallback;
  const value = Number(matches[0].slice(prefix.length));
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${prefix.slice(0, -1)} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function parseArgs(argv = []) {
  const prefixes = ['--interval-seconds=', '--window-minutes='];
  const unknown = argv.filter((arg) => arg !== '--once'
    && !prefixes.some((prefix) => arg.startsWith(prefix)));
  if (unknown.length) throw new Error(`unknown argument: ${unknown[0]}`);
  return Object.freeze({
    once: argv.includes('--once'),
    intervalSeconds: boundedArg(argv, prefixes[0], 60, 5, 3600),
    windowMinutes: boundedArg(argv, prefixes[1], 15, 1, 120),
  });
}

async function loadSnapshot(database = db) {
  const result = await database.query(
    `WITH frontier AS MATERIALIZED (
       SELECT checkpoint_block
         FROM robinhood_wallet_transfer_cursors
        WHERE chain = 'robinhood' AND projection_version = $1 AND stream = 'live'
          AND lifecycle_state = 'running' AND checkpoint_block IS NOT NULL
     )
     SELECT clock_timestamp() AS sampled_at,
            frontier.checkpoint_block::text AS frontier_block,
            COUNT(*)::integer AS total,
            COUNT(*) FILTER (WHERE coverage.published_at IS NOT NULL)::integer AS published,
            COUNT(*) FILTER (WHERE coverage.status = 'pending')::integer AS pending,
            COUNT(*) FILTER (WHERE coverage.status = 'leased'
              AND coverage.lease_until > NOW())::integer AS active_leased,
            COUNT(*) FILTER (WHERE coverage.status = 'leased'
              AND coverage.lease_until <= NOW())::integer AS expired_leased,
            COUNT(*) FILTER (WHERE coverage.status = 'complete'
              AND coverage.published_at IS NULL)::integer AS awaiting_publish,
            COUNT(*) FILTER (WHERE coverage.status = 'failed')::integer AS failed,
            COALESCE(SUM(GREATEST(
              frontier.checkpoint_block - coverage.next_block + 1, 0
            )) FILTER (WHERE coverage.published_at IS NULL), 0)::text
              AS effective_remaining_token_blocks,
            COALESCE(SUM(GREATEST(
              coverage.next_block - coverage.source_from_block, 0
            )), 0)::text AS processed_token_blocks,
            EXTRACT(EPOCH FROM (clock_timestamp() - MAX(coverage.updated_at)))::float8
              AS progress_age_seconds
       FROM robinhood_wallet_transfer_token_coverage coverage
       CROSS JOIN frontier
      WHERE coverage.chain = 'robinhood' AND coverage.projection_version = $1
      GROUP BY frontier.checkpoint_block`,
    [TARGET_VERSION]
  );
  if (!result.rows[0]) throw new Error('Robinhood transfer LIVE frontier is unavailable');
  const row = result.rows[0];
  return Object.freeze({
    sampledAt: new Date(row.sampled_at), frontierBlock: BigInt(row.frontier_block),
    total: row.total, published: row.published, pending: row.pending,
    activeLeased: row.active_leased, expiredLeased: row.expired_leased,
    awaitingPublish: row.awaiting_publish, failed: row.failed,
    effectiveRemaining: BigInt(row.effective_remaining_token_blocks),
    processed: BigInt(row.processed_token_blocks),
    progressAgeSeconds: Number(row.progress_age_seconds),
  });
}

function rateWindow(samples, now, windowMinutes) {
  const cutoff = now.sampledAt.getTime() - (windowMinutes * 60_000);
  return samples.find((sample) => sample.sampledAt.getTime() >= cutoff) || samples[0];
}

function summarize(samples, windowMinutes) {
  const current = samples.at(-1);
  const baseline = rateWindow(samples, current, windowMinutes);
  const seconds = (current.sampledAt - baseline.sampledAt) / 1000;
  const advanced = current.processed - baseline.processed;
  const drained = baseline.effectiveRemaining - current.effectiveRemaining;
  const rate = seconds > 0 ? Number(drained) / seconds : null;
  const etaSeconds = rate > 0 ? Number(current.effectiveRemaining) / rate : null;
  return Object.freeze({ current, seconds, advanced, drained, rate, etaSeconds });
}

function compactInteger(value) {
  return BigInt(value).toLocaleString('en-US');
}

function duration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return 'sampling';
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(2)}h`;
}

function formatSummary(summary) {
  const { current } = summary;
  const unfinished = current.total - current.published;
  return [
    current.sampledAt.toISOString(),
    `published=${current.published}/${current.total}`,
    `unfinished=${unfinished}`,
    `pending=${current.pending}`,
    `leased=${current.activeLeased}`,
    `expired=${current.expiredLeased}`,
    `publishable=${current.awaitingPublish}`,
    `failed=${current.failed}`,
    `effective_remaining=${compactInteger(current.effectiveRemaining)}`,
    `net_drain=${compactInteger(summary.drained)}`,
    `window=${duration(summary.seconds)}`,
    `eta=${duration(summary.etaSeconds)}`,
    `progress_age=${duration(current.progressAgeSeconds)}`,
    `frontier=${current.frontierBlock}`,
  ].join(' | ');
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const args = parseArgs(argv);
  const database = deps.database || db;
  const logger = deps.logger || console;
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const samples = [];
  for (;;) {
    const snapshot = await loadSnapshot(database);
    samples.push(snapshot);
    const cutoff = snapshot.sampledAt.getTime() - (args.windowMinutes * 60_000);
    while (samples.length > 2 && samples[1].sampledAt.getTime() < cutoff) samples.shift();
    const summary = summarize(samples, args.windowMinutes);
    logger.log(formatSummary(summary));
    if (args.once || snapshot.published === snapshot.total) return summary;
    await sleep(args.intervalSeconds * 1000);
  }
}

if (require.main === module) main().catch((error) => {
  console.error('Robinhood token repair monitor failed:', error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = { formatSummary, loadSnapshot, main, parseArgs, summarize };
