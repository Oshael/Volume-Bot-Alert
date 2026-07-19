const fs = require('node:fs/promises');
const path = require('node:path');
const db = require('../models/db');
const { createRobinhoodMarketAggregateRepository } = require('../models/robinhood-market-aggregate');
const PHASES = Object.freeze({
  fine: { table: 'robinhood_market_buckets_1m', granularities: [5, 15, 30], sourceMinutes: 1 },
  coarse: { table: 'robinhood_market_buckets_1h', granularities: [60, 240, 1440], sourceMinutes: 60 },
});
const PHASE_ORDER = Object.freeze(Object.keys(PHASES));
function integer(value, name, fallback, minimum, maximum) {
  if (value == null || value === '') return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}
function dateValue(value, name) {
  if (value == null || value === '') return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${name} must be a valid timestamp`);
  return parsed;
}
function parseCliArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) continue;
    const next = argv[index + 1];
    args[key.slice(2)] = !next || next.startsWith('--') ? true : next;
    if (args[key.slice(2)] !== true) index += 1;
  }
  const mode = String(args.mode || 'dry-run').trim().toLowerCase();
  if (!['dry-run', 'write'].includes(mode)) throw new Error('mode must be dry-run or write');
  const from = dateValue(args.from, 'from');
  const to = dateValue(args.to, 'to');
  if (from && to && from >= to) throw new Error('from must be before to');
  const checkpointFile = String(args.checkpoint || '').trim() || null;
  if (mode === 'write' && !checkpointFile) {
    throw new Error('write mode requires --checkpoint <file>');
  }
  return {
    mode,
    from,
    to,
    checkpointFile: checkpointFile ? path.resolve(checkpointFile) : null,
    tokenLimit: integer(args.tokenLimit, 'tokenLimit', 25, 1, 100),
    maxChunks: integer(args.maxChunks, 'maxChunks', 1, 1, 100_000),
    statementTimeoutMs: integer(args.statementTimeoutMs, 'statementTimeoutMs', 10_000, 1000, 60_000),
    sleepMs: integer(args.sleepMs, 'sleepMs', 250, 0, 60_000),
    fineWindowHours: integer(args.fineWindowHours, 'fineWindowHours', 1, 1, 24),
    coarseWindowHours: integer(args.coarseWindowHours, 'coarseWindowHours', 24, 1, 24 * 31),
  };
}
async function readCheckpoint(file) {
  if (!file) return null;
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
async function writeCheckpoint(file, checkpoint) {
  if (!file) return;
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, file);
}
function queryRunner(database, statementTimeoutMs) {
  if (typeof database.queryWithStatementTimeout === 'function') {
    return (sql, params) => database.queryWithStatementTimeout(sql, params, statementTimeoutMs);
  }
  return (sql, params) => database.query(sql, params);
}
async function sourceBounds(phase, execute) {
  const definition = PHASES[phase];
  const result = await execute(
    `SELECT MIN(bucket_ts) AS min_ts, MAX(bucket_ts) AS max_ts
     FROM ${definition.table} WHERE chain = 'robinhood'`,
    []
  );
  const row = result.rows[0] || {};
  return {
    min: row.min_ts ? new Date(row.min_ts) : null,
    max: row.max_ts ? new Date(row.max_ts) : null,
  };
}
async function listSourceRows(input, execute) {
  const definition = PHASES[input.phase];
  const result = await execute(
    `WITH candidate_tokens AS (
       SELECT token_address
       FROM ${definition.table}
       WHERE chain = 'robinhood'
         AND bucket_ts >= $1::timestamptz AND bucket_ts < $2::timestamptz
         AND ($3::text IS NULL OR token_address > $3::text)
       GROUP BY token_address
       ORDER BY token_address ASC
       LIMIT $4::int
     )
     SELECT source.token_address, source.bucket_ts
     FROM ${definition.table} source
     INNER JOIN candidate_tokens token USING (token_address)
     WHERE source.chain = 'robinhood'
       AND source.bucket_ts >= $1::timestamptz AND source.bucket_ts < $2::timestamptz
     GROUP BY source.token_address, source.bucket_ts
     ORDER BY source.token_address ASC, source.bucket_ts ASC`,
    [input.windowStart, input.windowEnd, input.afterToken, input.tokenLimit]
  );
  return result.rows;
}

function buildTargets(rows, phase) {
  const targets = new Map();
  for (const row of rows) {
    const sourceMs = new Date(row.bucket_ts).getTime();
    for (const granularityMinutes of PHASES[phase].granularities) {
      const widthMs = granularityMinutes * 60_000;
      const bucketTs = new Date(Math.floor(sourceMs / widthMs) * widthMs).toISOString();
      const key = `${row.token_address}:${granularityMinutes}:${bucketTs}`;
      targets.set(key, { tokenAddress: row.token_address, granularityMinutes, bucketTs });
    }
  }
  return [...targets.values()].sort((left, right) => (
    left.tokenAddress.localeCompare(right.tokenAddress)
      || left.bucketTs.localeCompare(right.bucketTs)
      || left.granularityMinutes - right.granularityMinutes
  ));
}

function phaseWindowHours(options, phase) {
  return phase === 'fine' ? options.fineWindowHours : options.coarseWindowHours;
}

function resolvePhaseRange(options, checkpoint, phase, bounds) {
  if (!bounds.min || !bounds.max) return null;
  const asOfMs = new Date(checkpoint.asOf).getTime();
  const configuredStart = options.from?.getTime() ?? bounds.min.getTime();
  return {
    startMs: Math.max(bounds.min.getTime(), configuredStart),
    endMs: Math.min(asOfMs, bounds.max.getTime() + PHASES[phase].sourceMinutes * 60 * 1000),
  };
}

function nextPhase(phase) {
  return PHASE_ORDER[PHASE_ORDER.indexOf(phase) + 1] || null;
}
function assertCheckpoint(checkpoint) {
  if (checkpoint.version !== 2 || (checkpoint.cursor?.phase != null && !PHASES[checkpoint.cursor.phase])) {
    throw new Error('checkpoint is incompatible');
  }
}

function remainingRanges(options, checkpoint, ranges) {
  if (!checkpoint.cursor.phase) return 0;
  let remaining = 0;
  for (const phase of PHASE_ORDER) {
    const range = ranges[phase];
    if (!range || PHASE_ORDER.indexOf(phase) < PHASE_ORDER.indexOf(checkpoint.cursor.phase)) continue;
    const cursorMs = phase === checkpoint.cursor.phase && checkpoint.cursor.windowStart
      ? new Date(checkpoint.cursor.windowStart).getTime() : range.startMs;
    const widthMs = phaseWindowHours(options, phase) * 60 * 60 * 1000;
    remaining += Math.max(0, Math.ceil((range.endMs - cursorMs) / widthMs));
  }
  return remaining;
}

async function applyTargets(targets, repository, summary) {
  for (const target of targets) {
    try {
      const row = await repository.refreshBucket(target);
      if (row?.updated_at) summary.written += 1;
      else summary.skipped += 1;
    } catch (error) {
      summary.failed += 1;
      const wrapped = new Error(`aggregate target failed: ${error.message}`);
      wrapped.summary = summary;
      throw wrapped;
    }
  }
}

async function processNextChunk(context) {
  const { options, checkpoint, phaseBounds, execute, repository, summary, save } = context;
  const phase = checkpoint.cursor.phase;
  const range = phaseBounds[phase];
  if (!range) {
    checkpoint.cursor = { phase: nextPhase(phase), windowStart: null, afterToken: null };
    return false;
  }
  const windowMs = phaseWindowHours(options, phase) * 60 * 60 * 1000;
  const windowStartMs = checkpoint.cursor.windowStart
    ? new Date(checkpoint.cursor.windowStart).getTime() : range.startMs;
  if (windowStartMs >= range.endMs) {
    checkpoint.cursor = { phase: nextPhase(phase), windowStart: null, afterToken: null };
    return false;
  }
  const windowEndMs = Math.min(windowStartMs + windowMs, range.endMs);
  const rows = await listSourceRows({
    phase,
    windowStart: new Date(windowStartMs).toISOString(),
    windowEnd: new Date(windowEndMs).toISOString(),
    afterToken: checkpoint.cursor.afterToken,
    tokenLimit: options.tokenLimit,
  }, execute).catch((error) => {
    summary.failed += 1;
    error.summary = summary;
    throw error;
  });
  summary.chunks += 1;
  summary.scanned += rows.length;
  const tokens = [...new Set(rows.map((row) => row.token_address))];
  const targets = buildTargets(rows, phase);
  if (options.mode === 'write') await applyTargets(targets, repository, summary);
  else summary.skipped += targets.length;
  checkpoint.cursor = tokens.length >= options.tokenLimit
    ? { phase, windowStart: new Date(windowStartMs).toISOString(), afterToken: tokens.at(-1) }
    : { phase, windowStart: new Date(windowEndMs).toISOString(), afterToken: null };
  await save(options.checkpointFile, checkpoint);
  return true;
}

async function runBackfill(options, deps = {}) {
  const database = deps.database || db;
  const execute = queryRunner(database, options.statementTimeoutMs);
  const repository = deps.repository || createRobinhoodMarketAggregateRepository({ query: execute });
  const load = deps.readCheckpoint || readCheckpoint;
  const save = deps.writeCheckpoint || writeCheckpoint;
  const checkpoint = await load(options.checkpointFile) || {
    version: 2,
    asOf: (options.to || new Date()).toISOString(),
    cursor: { phase: 'fine', windowStart: null, afterToken: null },
  };
  assertCheckpoint(checkpoint);
  const phaseBounds = Object.fromEntries(await Promise.all(PHASE_ORDER.map(async (phase) => (
    [phase, resolvePhaseRange(options, checkpoint, phase, await sourceBounds(phase, execute))]
  ))));
  const summary = {
    mode: options.mode, scanned: 0, written: 0, skipped: 0, failed: 0,
    chunks: 0, remainingRanges: 0, paused: false, nextCursor: null,
  };

  while (checkpoint.cursor.phase && summary.chunks < options.maxChunks) {
    const processed = await processNextChunk({
      options, checkpoint, phaseBounds, execute, repository, summary, save,
    });
    if (!processed) continue;
    if (deps.shouldPause?.()) break;
    if (options.sleepMs > 0 && summary.chunks < options.maxChunks) {
      await (deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(options.sleepMs);
    }
  }
  await save(options.checkpointFile, checkpoint);
  summary.remainingRanges = remainingRanges(options, checkpoint, phaseBounds);
  summary.paused = Boolean(checkpoint.cursor.phase);
  summary.nextCursor = checkpoint.cursor;
  return summary;
}

async function run() {
  let pauseRequested = false;
  const requestPause = () => { pauseRequested = true; };
  process.once('SIGINT', requestPause);
  process.once('SIGTERM', requestPause);
  try {
    const options = parseCliArgs();
    const summary = await runBackfill(options, { shouldPause: () => pauseRequested });
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    console.error('[RobinhoodAggregateBackfill]', error.message);
    if (error.summary) console.error(JSON.stringify(error.summary, null, 2));
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', requestPause);
    process.removeListener('SIGTERM', requestPause);
    await db.pool.end().catch(() => {});
  }
}

if (require.main === module) void run();

module.exports = {
  run,
  __private: { buildTargets, listSourceRows, parseCliArgs, runBackfill },
};
