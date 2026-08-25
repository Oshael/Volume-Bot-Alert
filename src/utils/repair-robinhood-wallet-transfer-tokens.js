require('dotenv').config();

const db = require('../models/db');
const {
  createRobinhoodWalletTransferTokenRepairRepository,
} = require('../models/robinhood-wallet-transfer-token-repair');
const {
  runRobinhoodWalletTransferTokenRepairRange,
} = require('../services/robinhood-wallet-transfer-token-repair-runner');
const {
  buildRuntime, runtimeOptions,
} = require('./backfill-robinhood-wallet-transfers');

const CONFIRM_FLAG = '--confirm-repair-robinhood-wallet-transfer-tokens';
const RETRY_FLAG = '--retry-failed';

function boundedArg(argv, prefix, fallback, min, max) {
  const matches = argv.filter((arg) => arg.startsWith(prefix));
  if (matches.length > 1) throw new Error(`${prefix.slice(0, -1)} cannot be repeated`);
  if (!matches.length) return fallback;
  const value = Number(matches[0].slice(prefix.length));
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${prefix.slice(0, -1)} must be between ${min} and ${max}`);
  }
  return value;
}

function parseArgs(argv = []) {
  const prefixes = [
    '--max-blocks=', '--max-operations=', '--pause-ms=', '--token-batch-size=',
    '--window-concurrency=', '--address-filter-limit=',
  ];
  const unknown = argv.filter((arg) => ![CONFIRM_FLAG, RETRY_FLAG].includes(arg)
    && !prefixes.some((prefix) => arg.startsWith(prefix)));
  if (unknown.length) throw new Error(`unknown argument: ${unknown[0]}`);
  const parsed = Object.freeze({
    confirm: argv.includes(CONFIRM_FLAG),
    retryFailed: argv.includes(RETRY_FLAG),
    maxBlocks: boundedArg(argv, prefixes[0], 500, 1, 5000),
    maxOperations: boundedArg(argv, prefixes[1], 1, 1, 10_000),
    pauseMs: boundedArg(argv, prefixes[2], 250, 0, 60_000),
    tokenBatchSize: boundedArg(argv, prefixes[3], 500, 1, 500),
    windowConcurrency: boundedArg(argv, prefixes[4], 1, 1, 16),
    addressFilterLimit: boundedArg(argv, prefixes[5], 100, 1, 1000),
  });
  if (parsed.retryFailed && !parsed.confirm) throw new Error(`${RETRY_FLAG} requires confirmation`);
  return parsed;
}

function withSharedWindowEstimate(plan, maxBlocks, concurrency) {
  const earliest = String(plan.earliest_pending_block ?? plan.earliest_source_block ?? '');
  const pendingThrough = BigInt(plan.latest_pending_block ?? plan.latest_source_block ?? 0);
  const liveThrough = BigInt(plan.sourceThroughBlock ?? 0);
  const latest = String(liveThrough > pendingThrough ? liveThrough : pendingThrough);
  if (!/^\d+$/.test(earliest) || !/^\d+$/.test(latest) || BigInt(latest) < BigInt(earliest)) {
    return plan;
  }
  const span = BigInt(latest) - BigInt(earliest) + 1n;
  const window = BigInt(maxBlocks);
  const scans = (span + window - 1n) / window;
  const unpublished = BigInt(plan.shadow_complete ?? 0) + BigInt(plan.pending ?? 0)
    + BigInt(plan.leased ?? 0) + BigInt(plan.failed ?? 0);
  const extensions = liveThrough > pendingThrough ? unpublished : 0n;
  const scanBatches = (scans + BigInt(concurrency) - 1n) / BigInt(concurrency);
  return Object.freeze({
    ...plan, sharedWindowBlockSpan: span.toString(),
    estimatedScanOperations: scans.toString(),
    estimatedConcurrentScanBatches: scanBatches.toString(),
    estimatedTotalOperations: (scanBatches + unpublished + extensions).toString(),
  });
}

async function runOperations(args, coverage, deps) {
  let runtime = deps.runtime;
  const operations = [];
  for (let index = 0; index < args.maxOperations; index += 1) {
    const pendingPromotion = await coverage.promoteNext();
    if (pendingPromotion) operations.push(pendingPromotion);
    else {
      runtime ||= await (deps.runtimeFactory || buildRuntime)(
        {
          ...(deps.options || runtimeOptions()),
          addressFilterLimit: args.addressFilterLimit,
        }, deps
      );
      const repair = await (deps.runRange || runRobinhoodWalletTransferTokenRepairRange)(
        { coverage, tickDeps: runtime.tickDeps }, {
          maxBlocks: args.maxBlocks, tokenBatchSize: args.tokenBatchSize,
          windowConcurrency: args.windowConcurrency,
        }
      );
      operations.push(repair);
      if (repair.status === 'caught-up') break;
      if (repair.status === 'shadow-complete') {
        const promoted = await coverage.promoteNext();
        if (promoted) operations.push(promoted);
      }
    }
    if (args.pauseMs && index + 1 < args.maxOperations) {
      await (deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(
        args.pauseMs
      );
    }
  }
  return operations;
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const args = parseArgs(argv);
  const database = deps.database || db;
  const coverage = (deps.repositoryFactory
    || createRobinhoodWalletTransferTokenRepairRepository)({ database });
  const plan = withSharedWindowEstimate(
    await coverage.plan(), args.maxBlocks, args.windowConcurrency
  );
  if (!args.confirm) {
    const report = { mode: 'read-only', plan, progress: await coverage.getProgress() };
    (deps.logger || console).log(JSON.stringify(report, null, 2));
    return report;
  }
  const initialized = await coverage.initialize();
  const recovered = await coverage.recover({ retryFailed: args.retryFailed });
  const operations = await runOperations(args, coverage, deps);
  const report = {
    mode: 'apply', plan, initialized, recovered, operations,
    progress: await coverage.getProgress(),
  };
  (deps.logger || console).log(JSON.stringify(report, null, 2));
  return report;
}

if (require.main === module) main().catch((error) => {
  console.error('Robinhood token-scoped transfer repair failed:', error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = { CONFIRM_FLAG, RETRY_FLAG, main, parseArgs, runOperations };
