require('dotenv').config();

const db = require('../models/db');
const {
  createRobinhoodWalletPositionTokenRepairRepository,
} = require('../models/robinhood-wallet-position-token-repair');
const {
  runRobinhoodWalletPositionTokenRepairRange,
} = require('../services/robinhood-wallet-position-token-repair-runner');
const { buildRuntime, runtimeOptions } = require('./backfill-robinhood-wallet-transfers');

const CONFIRM_FLAG = '--confirm-repair-robinhood-wallet-positions';
const RETRY_FLAG = '--retry-failed';

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
  const prefixes = [
    '--max-blocks=', '--max-operations=', '--pause-ms=', '--token-batch-size=',
    '--window-concurrency=', '--address-filter-limit=', '--max-attempts=', '--retry-ms=',
  ];
  const unknown = argv.filter((arg) => ![CONFIRM_FLAG, RETRY_FLAG].includes(arg)
    && !prefixes.some((prefix) => arg.startsWith(prefix)));
  if (unknown.length) throw new Error(`unknown argument: ${unknown[0]}`);
  const parsed = Object.freeze({
    confirm: argv.includes(CONFIRM_FLAG), retryFailed: argv.includes(RETRY_FLAG),
    maxBlocks: boundedArg(argv, prefixes[0], 5_000, 1, 5_000),
    maxOperations: boundedArg(argv, prefixes[1], 1, 1, 100_000),
    pauseMs: boundedArg(argv, prefixes[2], 250, 0, 60_000),
    tokenBatchSize: boundedArg(argv, prefixes[3], 500, 1, 500),
    windowConcurrency: boundedArg(argv, prefixes[4], 8, 1, 16),
    addressFilterLimit: boundedArg(argv, prefixes[5], 500, 1, 1_000),
    maxAttempts: boundedArg(argv, prefixes[6], 20, 1, 100),
    retryMs: boundedArg(argv, prefixes[7], 60_000, 1_000, 86_400_000),
  });
  if (parsed.retryFailed && !parsed.confirm) throw new Error(`${RETRY_FLAG} requires confirmation`);
  return parsed;
}

function isAcquisitionTimeout(error) {
  return /(?:connection terminated due to connection timeout|timeout exceeded when trying to connect)/i
    .test(String(error?.message || ''));
}

async function retryAcquisition(operation, execute, deps = {}) {
  let attempt = 0;
  for (;;) {
    try {
      return await execute();
    } catch (error) {
      if (!isAcquisitionTimeout(error)) throw error;
      attempt += 1;
      const delay = Math.min(5_000, 250 * (2 ** Math.min(attempt - 1, 5)));
      (deps.logger?.error || console.error)(
        `[PositionTokenRepair] DB acquisition retry operation=${operation}`
          + ` attempt=${attempt} delay=${delay}ms error=${error.message}`
      );
      await (deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(delay);
    }
  }
}

function resilientRepository(repository, deps) {
  return Object.freeze(Object.fromEntries(Object.entries(repository).map(([name, value]) => (
    typeof value === 'function'
      ? [name, (...args) => retryAcquisition(name, () => value(...args), deps)]
      : [name, value]
  ))));
}

function estimate(plan, args, preview = {}) {
  const from = plan.earliest_pending_block ?? preview.earliest_source_block;
  const through = plan.latest_pending_block ?? preview.latest_source_block;
  if (!/^\d+$/.test(String(from)) || !/^\d+$/.test(String(through))) return plan;
  const span = BigInt(through) - BigInt(from) + 1n;
  const windows = (span + BigInt(args.maxBlocks) - 1n) / BigInt(args.maxBlocks);
  const batches = (windows + BigInt(args.windowConcurrency) - 1n)
    / BigInt(args.windowConcurrency);
  return Object.freeze({
    ...plan, shared_window_block_span: span.toString(),
    estimated_scan_windows: windows.toString(),
    estimated_concurrent_batches: batches.toString(),
  });
}

async function runOperations(args, coverage, runtime, deps = {}) {
  const summary = {
    operations: 0, batches: 0, tokens: 0, windows: 0,
    positions: 0, completed: 0, retriedBatches: 0, caughtUp: false, lastResult: null,
  };
  for (let index = 0; index < args.maxOperations; index += 1) {
    const result = await (deps.runRange || runRobinhoodWalletPositionTokenRepairRange)({
      coverage, positions: runtime.tickDeps.positions,
      transactionPositions: runtime.tickDeps.transactionPositions,
      tickDeps: runtime.tickDeps,
    }, args);
    summary.operations += 1;
    summary.lastResult = result;
    if (result.status === 'caught-up') {
      summary.caughtUp = true;
      break;
    }
    if (result.status === 'batch-projected') {
      summary.batches += 1;
      summary.tokens += result.tokens;
      summary.windows += result.windows;
      summary.positions += result.positions;
      summary.completed += result.complete;
    } else if (result.status === 'batch-retried') summary.retriedBatches += 1;
    if ((index + 1) % 25 === 0) {
      (deps.logger || console).log(JSON.stringify({ progress: summary }));
    }
    if (args.pauseMs && index + 1 < args.maxOperations) {
      await (deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(
        args.pauseMs
      );
    }
  }
  return Object.freeze(summary);
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const args = parseArgs(argv);
  const database = deps.database || db;
  const base = (deps.repositoryFactory
    || createRobinhoodWalletPositionTokenRepairRepository)({ database });
  const coverage = resilientRepository(base, deps);
  if (!args.confirm) {
    const preview = await coverage.preview();
    const report = Object.freeze({
      mode: 'read-only', preview,
      plan: estimate(await coverage.plan(), args, preview),
    });
    (deps.logger || console).log(JSON.stringify(report, null, 2));
    return report;
  }
  const initialized = await coverage.initialize();
  const recovered = await coverage.recover({ retryFailed: args.retryFailed });
  const runtime = deps.runtime || await retryAcquisition(
    'buildRuntime', () => (deps.runtimeFactory || buildRuntime)({
      ...(deps.options || runtimeOptions()), addressFilterLimit: args.addressFilterLimit,
    }, deps), deps
  );
  const execution = await runOperations(args, coverage, runtime, deps);
  const report = Object.freeze({
    mode: 'apply-shadow', initialized, recovered, execution,
    plan: estimate(await coverage.plan(), args),
  });
  (deps.logger || console).log(JSON.stringify(report, null, 2));
  return report;
}

if (require.main === module) main().catch((error) => {
  console.error('Robinhood token-scoped position repair failed:', error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = { CONFIRM_FLAG, RETRY_FLAG, main, parseArgs, runOperations };
