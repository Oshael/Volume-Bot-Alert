require('dotenv').config();

const db = require('../models/db');
const {
  createRobinhoodHeadProcessingRepository,
} = require('../models/robinhood-head-processing');

const APPLY_FLAG = '--apply';
const BATCH_SIZE_PREFIX = '--batch-size=';
const MAX_BATCHES_PREFIX = '--max-batches=';
const THROUGH_BLOCK_PREFIX = '--through-block=';

function boundedInteger(value, fallback, minimum, maximum, label) {
  const parsed = value == null || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function optionValue(argv, prefix) {
  const matches = argv.filter((argument) => argument.startsWith(prefix));
  if (matches.length > 1) throw new Error(`${prefix.slice(0, -1)} was provided more than once`);
  return matches[0]?.slice(prefix.length) ?? null;
}

function parseArgs(argv = []) {
  const known = new Set([APPLY_FLAG]);
  for (const argument of argv) {
    if (known.has(argument)
      || [BATCH_SIZE_PREFIX, MAX_BATCHES_PREFIX, THROUGH_BLOCK_PREFIX]
        .some((prefix) => argument.startsWith(prefix))) continue;
    throw new Error(`Unknown argument: ${argument}`);
  }
  const apply = argv.includes(APPLY_FLAG);
  const batchSize = boundedInteger(
    optionValue(argv, BATCH_SIZE_PREFIX), 10_000, 1, 50_000, 'batch size'
  );
  const maxBatches = boundedInteger(
    optionValue(argv, MAX_BATCHES_PREFIX), 1, 1, 1000, 'max batches'
  );
  const throughBlock = optionValue(argv, THROUGH_BLOCK_PREFIX);
  if (throughBlock != null && !/^\d+$/.test(throughBlock)) {
    throw new Error('through block must be a non-negative integer');
  }
  if (apply && throughBlock == null) {
    throw new Error('--through-block is required with --apply');
  }
  return Object.freeze({ apply, batchSize, maxBatches, throughBlock });
}

async function runBlockedRecovery(input = {}) {
  const repository = input.repository;
  if (typeof repository?.previewBlockedRecovery !== 'function'
    || typeof repository?.requeueBlockedRecoveryBatch !== 'function') {
    throw new TypeError('Robinhood processing repository is required');
  }
  const options = Object.freeze({
    apply: input.apply === true,
    batchSize: boundedInteger(input.batchSize, 10_000, 1, 50_000, 'batch size'),
    maxBatches: boundedInteger(input.maxBatches, 1, 1, 1000, 'max batches'),
    throughBlock: input.throughBlock == null ? null : String(input.throughBlock),
  });
  if (options.apply && !/^\d+$/.test(options.throughBlock || '')) {
    throw new Error('throughBlock is required for confirmed recovery');
  }
  const before = await repository.previewBlockedRecovery({
    limit: options.batchSize,
    throughBlock: options.throughBlock,
  });
  if (!options.apply) return Object.freeze({ mode: 'dry-run', options, before });
  if (before.workerActive) throw new Error('Robinhood processing worker must be stopped');

  const batches = [];
  let requeued = 0;
  for (let index = 0; index < options.maxBatches; index += 1) {
    const batch = await repository.requeueBlockedRecoveryBatch({
      limit: options.batchSize,
      throughBlock: options.throughBlock,
    });
    batches.push(Object.freeze({ batch: index + 1, ...batch }));
    requeued += batch.requeued;
    input.onProgress?.(batches.at(-1));
    if (batch.requeued < options.batchSize) break;
  }
  const after = await repository.previewBlockedRecovery({
    limit: options.batchSize,
    throughBlock: options.throughBlock,
  });
  return Object.freeze({
    mode: 'apply', options, before, batches: Object.freeze(batches), requeued, after,
  });
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const repository = createRobinhoodHeadProcessingRepository({ database: db });
  const result = await runBlockedRecovery({
    repository,
    ...options,
    onProgress: (batch) => console.error(
      `[RobinhoodProcessingRecovery] batch=${batch.batch} requeued=${batch.requeued}`
    ),
  });
  console.log(JSON.stringify(result, null, 2));
  if (!options.apply) {
    console.error('Dry-run only. Review the frontier and rerun with --apply --through-block=<N>.');
  }
  return result;
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[RobinhoodProcessingRecovery] Failed:', error.message);
    process.exitCode = 1;
  }).finally(() => db.pool.end().catch(() => {}));
}

module.exports = { parseArgs, runBlockedRecovery };
