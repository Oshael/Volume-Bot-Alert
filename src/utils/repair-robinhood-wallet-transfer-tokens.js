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
const LIVE_LEASE_KEY = 'robinhood-wallet-transfer-live-worker';

function isConnectionAcquisitionTimeout(error) {
  return /(?:connection terminated due to connection timeout|timeout exceeded when trying to connect)/i
    .test(String(error?.message || ''));
}

async function retryConnectionAcquisition(operation, execute, deps = {}) {
  let attempt = 0;
  while (true) {
    try {
      return await execute();
    } catch (error) {
      if (!isConnectionAcquisitionTimeout(error)) throw error;
      attempt += 1;
      const delayMs = Math.min(5_000, 250 * (2 ** Math.min(attempt - 1, 5)));
      (deps.logger?.error || deps.logger?.log || console.error).call(
        deps.logger || console,
        `[TokenRepair] DB acquisition retry operation=${operation}`
          + ` attempt=${attempt} delay=${delayMs}ms error=${error.message}`
      );
      await (deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(delayMs);
    }
  }
}

function resilientCoverageRepository(repository, deps = {}) {
  return Object.freeze(Object.fromEntries(Object.entries(repository).map(([property, value]) => (
    typeof value !== 'function' ? [property, value] : [property, (...args) => (
      retryConnectionAcquisition(property, () => value.apply(repository, args), deps)
    )]
  ))));
}

async function requirePausedLiveFrontier(database, expected = null) {
  const result = await database.query(
    `SELECT cursor.next_block::text,
            cursor.checkpoint_block::text,
            cursor.checkpoint_hash,
            cursor.lifecycle_state,
            EXISTS (
              SELECT 1 FROM worker_leases lease
               WHERE lease.lease_key = $3 AND lease.lease_until > NOW()
            ) AS live_worker_active
       FROM robinhood_wallet_transfer_cursors cursor
      WHERE cursor.chain = $1 AND cursor.projection_version = $2
        AND cursor.stream = 'live'`,
    ['robinhood', 'rh_transfer_v1', LIVE_LEASE_KEY]
  );
  const row = result.rows[0];
  if (!row || row.lifecycle_state !== 'running' || row.next_block == null
      || row.checkpoint_block == null
      || row.checkpoint_hash == null
      || BigInt(row.next_block) !== BigInt(row.checkpoint_block) + 1n) {
    const error = new Error('Robinhood transfer LIVE cursor is unavailable');
    error.code = 'token_repair_live_cursor_unavailable';
    throw error;
  }
  if (row.live_worker_active) {
    const error = new Error(
      'Robinhood transfer LIVE worker must be paused before token repair apply'
    );
    error.code = 'token_repair_live_worker_active';
    throw error;
  }
  const frontier = Object.freeze({
    block: String(row.checkpoint_block), hash: String(row.checkpoint_hash),
  });
  if (expected && (frontier.block !== expected.block || frontier.hash !== expected.hash)) {
    const error = new Error('Robinhood transfer LIVE frontier moved during token repair');
    error.code = 'token_repair_live_frontier_moved';
    throw error;
  }
  return frontier;
}

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
    await deps.assertPausedFrontier?.();
    const pendingPromotion = await coverage.promoteNext();
    if (pendingPromotion) operations.push(pendingPromotion);
    else {
      runtime ||= await retryConnectionAcquisition(
        'buildRuntime', () => (deps.runtimeFactory || buildRuntime)(
          {
            ...(deps.options || runtimeOptions()),
            addressFilterLimit: args.addressFilterLimit,
          }, deps
        ), deps
      );
      const repair = await (deps.runRange || runRobinhoodWalletTransferTokenRepairRange)(
        { coverage, tickDeps: runtime.tickDeps, logger: deps.logger, sleep: deps.sleep }, {
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
  const baseCoverage = (deps.repositoryFactory
    || createRobinhoodWalletTransferTokenRepairRepository)({ database });
  const coverage = resilientCoverageRepository(baseCoverage, deps);
  const plan = withSharedWindowEstimate(
    await coverage.plan(), args.maxBlocks, args.windowConcurrency
  );
  if (!args.confirm) {
    const report = { mode: 'read-only', plan, progress: await coverage.getProgress() };
    (deps.logger || console).log(JSON.stringify(report, null, 2));
    return report;
  }
  const frontierGuard = deps.frontierGuard || requirePausedLiveFrontier;
  const pausedFrontier = await retryConnectionAcquisition(
    'requirePausedLiveFrontier', () => frontierGuard(database), deps
  );
  const initialized = await coverage.initialize();
  const recovered = await coverage.recover({ retryFailed: args.retryFailed });
  const assertPausedFrontier = () => retryConnectionAcquisition(
    'assertPausedLiveFrontier', () => frontierGuard(database, pausedFrontier), deps
  );
  const operations = await runOperations(args, coverage, {
    ...deps, assertPausedFrontier,
  });
  const report = {
    mode: 'apply', plan, pausedFrontier, initialized, recovered, operations,
    progress: await coverage.getProgress(),
  };
  (deps.logger || console).log(JSON.stringify(report, null, 2));
  return report;
}

if (require.main === module) main().catch((error) => {
  console.error('Robinhood token-scoped transfer repair failed:', error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = {
  CONFIRM_FLAG, RETRY_FLAG, main, parseArgs, requirePausedLiveFrontier, runOperations,
};
