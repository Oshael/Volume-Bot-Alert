'use strict';

require('dotenv').config();
const fs = require('node:fs/promises');
const path = require('node:path');
const db = require('../models/db');
const {
  createRobinhoodHeadCaptureStateRepository,
} = require('../models/robinhood-head-capture-state');

const CHECKPOINT_VERSION = 2;

function integer(value, fallback, minimum, maximum, label) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function parseArgs(argv = []) {
  const allowed = new Set([
    'write', 'page-batch', 'max-batches', 'pause-ms',
    'statement-timeout-ms', 'checkpoint-file', 'max-canonical-lag-blocks',
    'shard-count', 'shard-index', 'target-heap-blocks',
  ]);
  const values = {};
  for (const argument of argv) {
    const match = String(argument).match(/^--([^=]+)(?:=(.*))?$/);
    if (!match || !allowed.has(match[1])) throw new Error(`unknown argument: ${argument}`);
    values[match[1]] = match[2] ?? 'true';
  }
  const write = values.write === 'true';
  if (values.write != null && !write) throw new Error('--write does not accept a value');
  const checkpointFile = String(values['checkpoint-file'] || '').trim();
  if (write && !checkpointFile) throw new Error('--checkpoint-file is required with --write');
  const shardCount = integer(values['shard-count'], 1, 1, 8, 'shard-count');
  const shardIndex = integer(values['shard-index'], 0, 0, 7, 'shard-index');
  if (shardIndex >= shardCount) throw new Error('shard-index must be lower than shard-count');
  const targetHeapBlocks = values['target-heap-blocks'] == null ? null : integer(
    values['target-heap-blocks'], null, 1, Number.MAX_SAFE_INTEGER, 'target-heap-blocks'
  );
  if (shardCount > 1 && targetHeapBlocks == null) {
    throw new Error('--target-heap-blocks is required with multiple shards');
  }
  return Object.freeze({
    write,
    shardCount,
    shardIndex,
    targetHeapBlocks,
    pageBatch: integer(values['page-batch'], 2_048, 1, 65_536, 'page-batch'),
    maxBatches: integer(values['max-batches'], 1, 1, 10_000, 'max-batches'),
    pauseMs: integer(values['pause-ms'], 0, 0, 60_000, 'pause-ms'),
    statementTimeoutMs: integer(
      values['statement-timeout-ms'], 30_000, 1_000, 300_000, 'statement-timeout-ms'
    ),
    maxCanonicalLagBlocks: integer(
      values['max-canonical-lag-blocks'], 128, 0, 1_000_000, 'max-canonical-lag-blocks'
    ),
    checkpointFile: checkpointFile ? path.resolve(checkpointFile) : null,
  });
}

function checkpointStore(filename) {
  if (!filename) return Object.freeze({ load: async () => null, save: async () => {} });
  return Object.freeze({
    async load() {
      try {
        return JSON.parse(await fs.readFile(filename, 'utf8'));
      } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
      }
    },
    async save(value) {
      await fs.mkdir(path.dirname(filename), { recursive: true });
      const temporary = `${filename}.tmp-${process.pid}`;
      await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(temporary, filename);
    },
  });
}

function shardRange(totalHeapBlocks, shardCount, shardIndex) {
  return {
    startHeapBlock: Math.floor(totalHeapBlocks * shardIndex / shardCount),
    targetHeapBlocks: Math.floor(totalHeapBlocks * (shardIndex + 1) / shardCount),
  };
}

function hasValidProgress(saved) {
  const expected = shardRange(saved.sourceHeapBlocks, saved.shardCount, saved.shardIndex);
  return Number.isSafeInteger(saved.sourceHeapBlocks) && saved.sourceHeapBlocks >= 0
    && saved.startHeapBlock === expected.startHeapBlock
    && saved.targetHeapBlocks === expected.targetHeapBlocks
    && Number.isSafeInteger(saved.nextHeapBlock)
    && saved.nextHeapBlock >= saved.startHeapBlock
    && saved.nextHeapBlock <= saved.targetHeapBlocks
    && saved.completed === (saved.nextHeapBlock >= saved.targetHeapBlocks);
}

function restore(saved, source, options) {
  const totalHeapBlocks = options.targetHeapBlocks ?? source.heapBlocks;
  const { startHeapBlock, targetHeapBlocks } = shardRange(
    totalHeapBlocks, options.shardCount, options.shardIndex
  );
  if (!saved) return {
    version: CHECKPOINT_VERSION, mode: options.write ? 'write' : 'dry-run',
    relationFileNode: source.relationFileNode, shardCount: options.shardCount,
    shardIndex: options.shardIndex, sourceHeapBlocks: totalHeapBlocks,
    startHeapBlock, targetHeapBlocks,
    nextHeapBlock: startHeapBlock, completed: startHeapBlock >= targetHeapBlocks,
    batches: 0, scanned: 0, inserted: 0,
  };
  if (saved.version !== CHECKPOINT_VERSION
      || saved.mode !== (options.write ? 'write' : 'dry-run')) {
    throw new Error('physical checkpoint does not match this execution mode or version');
  }
  if (saved.shardCount !== options.shardCount || saved.shardIndex !== options.shardIndex
      || (options.targetHeapBlocks != null
        && saved.sourceHeapBlocks !== options.targetHeapBlocks)) {
    throw new Error('physical checkpoint does not match this shard');
  }
  if (saved.relationFileNode !== source.relationFileNode) {
    throw new Error('head captures relation was rewritten; use a new physical checkpoint');
  }
  if (!hasValidProgress(saved)) {
    throw new Error('physical checkpoint progress is invalid');
  }
  return saved;
}

async function runPhysicalBackfill(options, deps = {}) {
  const repository = deps.repository || createRobinhoodHeadCaptureStateRepository({
    database: deps.database || db,
  });
  const store = deps.checkpoint || checkpointStore(options.checkpointFile);
  const pause = deps.pause || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const logger = deps.logger || console;
  await repository.assertMirrorReady();
  const source = await repository.describePhysicalSource();
  const state = restore(await store.load(), source, options);
  let blocked = null;
  for (let index = 0; index < options.maxBatches && !state.completed; index += 1) {
    const current = await repository.describePhysicalSource();
    if (current.relationFileNode !== state.relationFileNode) {
      throw new Error('head captures relation was rewritten during physical backfill');
    }
    await repository.assertMaintenanceAllowed(options.maxCanonicalLagBlocks);
    const endBlock = Math.min(
      state.nextHeapBlock + options.pageBatch, state.targetHeapBlocks
    );
    const batch = await repository.processPhysicalBatch({
      startBlock: state.nextHeapBlock, endBlock, write: options.write,
      statementTimeoutMs: options.statementTimeoutMs,
    });
    if (batch.missing > 0 || batch.divergent > 0) {
      blocked = { missing: batch.missing, divergent: batch.divergent };
      break;
    }
    state.nextHeapBlock = endBlock;
    state.completed = endBlock >= state.targetHeapBlocks;
    state.batches += 1;
    state.scanned += batch.scanned;
    state.inserted += batch.inserted;
    state.updatedAt = new Date().toISOString();
    if (options.write) await store.save(state);
    logger.log(JSON.stringify({ phase: 'batch', scan: 'physical', ...batch,
      shardCount: state.shardCount, shardIndex: state.shardIndex,
      batch: state.batches, completed: state.completed }));
    if (!state.completed && index + 1 < options.maxBatches && options.pauseMs > 0) {
      await pause(options.pauseMs);
    }
  }
  const report = Object.freeze({
    phase: 'summary', scan: 'physical', mode: state.mode,
    shardCount: state.shardCount, shardIndex: state.shardIndex,
    completed: state.completed, approved: options.write && state.completed && blocked == null,
    blocked, batches: state.batches, scanned: state.scanned, inserted: state.inserted,
    sourceHeapBlocks: state.sourceHeapBlocks, startHeapBlock: state.startHeapBlock,
    nextHeapBlock: state.nextHeapBlock, targetHeapBlocks: state.targetHeapBlocks,
  });
  logger.log(JSON.stringify(report));
  return report;
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const options = deps.options || parseArgs(argv);
  try {
    return await runPhysicalBackfill(options, deps);
  } finally {
    if (!deps.database && !deps.repository) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) main().then((report) => {
  if (report.blocked) process.exitCode = 2;
}).catch((error) => {
  console.error(JSON.stringify({ phase: 'error', message: error.message }));
  process.exitCode = 1;
});

module.exports = { CHECKPOINT_VERSION, main, parseArgs, restore, runPhysicalBackfill };
