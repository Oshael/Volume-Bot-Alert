'use strict';

require('dotenv').config();
const fs = require('node:fs/promises');
const path = require('node:path');
const db = require('../models/db');
const {
  createRobinhoodHeadCaptureStateRepository,
} = require('../models/robinhood-head-capture-state');

const CHECKPOINT_VERSION = 1;

function integer(value, fallback, minimum, maximum, label) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function parseArgs(argv = []) {
  const allowed = new Set([
    'write', 'checkpoint-file', 'page-batch', 'max-batches', 'pause-ms',
    'statement-timeout-ms', 'max-canonical-lag-blocks',
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
  if (!write && checkpointFile) throw new Error('--checkpoint-file requires --write');
  return Object.freeze({
    write,
    checkpointFile: checkpointFile ? path.resolve(checkpointFile) : null,
    pageBatch: integer(values['page-batch'], 256, 1, 4_096, 'page-batch'),
    maxBatches: integer(values['max-batches'], 1, 1, 10_000, 'max-batches'),
    pauseMs: integer(values['pause-ms'], 500, 0, 60_000, 'pause-ms'),
    statementTimeoutMs: integer(
      values['statement-timeout-ms'], 30_000, 1_000, 300_000, 'statement-timeout-ms'
    ),
    maxCanonicalLagBlocks: integer(
      values['max-canonical-lag-blocks'], 128, 0, 1_000_000, 'max-canonical-lag-blocks'
    ),
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

function restore(saved, source, options) {
  if (!Number.isSafeInteger(source.heapBlocks) || source.heapBlocks < 0) {
    throw new Error('head state heap size is invalid');
  }
  if (!saved) return {
    version: CHECKPOINT_VERSION, scan: 'head-routing',
    mode: options.write ? 'write' : 'dry-run',
    relationFileNode: source.relationFileNode,
    targetHeapBlocks: source.heapBlocks, nextHeapBlock: 0,
    completed: source.heapBlocks === 0, batches: 0, candidates: 0, updated: 0,
  };
  if (!options.write || saved.version !== CHECKPOINT_VERSION
      || saved.scan !== 'head-routing' || saved.mode !== 'write') {
    throw new Error('routing checkpoint mode or version is invalid');
  }
  if (saved.relationFileNode !== source.relationFileNode) {
    throw new Error('head state relation was rewritten; use a new routing checkpoint');
  }
  if (!Number.isSafeInteger(saved.targetHeapBlocks) || saved.targetHeapBlocks < 0
      || !Number.isSafeInteger(saved.nextHeapBlock) || saved.nextHeapBlock < 0
      || saved.nextHeapBlock > saved.targetHeapBlocks
      || saved.completed !== (saved.nextHeapBlock >= saved.targetHeapBlocks)) {
    throw new Error('routing checkpoint progress is invalid');
  }
  return saved;
}

async function runRoutingBackfill(options, deps = {}) {
  const repository = deps.repository || createRobinhoodHeadCaptureStateRepository({
    database: deps.database || db,
  });
  const store = deps.checkpoint || checkpointStore(options.checkpointFile);
  const pause = deps.pause || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const logger = deps.logger || console;
  await repository.assertRoutingMirrorReady();
  const source = await repository.describeRoutingPhysicalSource();
  const state = restore(await store.load(), source, options);
  for (let index = 0; index < options.maxBatches && !state.completed; index += 1) {
    const current = await repository.describeRoutingPhysicalSource();
    if (current.relationFileNode !== state.relationFileNode) {
      throw new Error('head state relation was rewritten during routing backfill');
    }
    await repository.assertMaintenanceAllowed(options.maxCanonicalLagBlocks);
    const endBlock = Math.min(state.nextHeapBlock + options.pageBatch, state.targetHeapBlocks);
    const batch = await repository.processRoutingPhysicalBatch({
      startBlock: state.nextHeapBlock, endBlock, write: options.write,
      statementTimeoutMs: options.statementTimeoutMs,
    });
    state.nextHeapBlock = endBlock;
    state.completed = endBlock >= state.targetHeapBlocks;
    state.batches += 1;
    state.candidates += batch.candidates;
    state.updated += batch.updated;
    state.updatedAt = new Date().toISOString();
    if (options.write) await store.save(state);
    logger.log(JSON.stringify({ phase: 'batch', scan: 'head-routing', ...batch,
      batch: state.batches, completed: state.completed }));
    if (!state.completed && index + 1 < options.maxBatches && options.pauseMs > 0) {
      await pause(options.pauseMs);
    }
  }
  const report = Object.freeze({
    phase: 'summary', scan: 'head-routing', mode: options.write ? 'write' : 'dry-run',
    completed: state.completed, requiresFinalAudit: true,
    batches: state.batches, candidates: state.candidates, updated: state.updated,
    nextHeapBlock: state.nextHeapBlock, targetHeapBlocks: state.targetHeapBlocks,
  });
  logger.log(JSON.stringify(report));
  return report;
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const options = deps.options || parseArgs(argv);
  try {
    return await runRoutingBackfill(options, deps);
  } finally {
    if (!deps.database && !deps.repository) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) main().catch((error) => {
  console.error(JSON.stringify({ phase: 'error', message: error.message }));
  process.exitCode = 1;
});

module.exports = { CHECKPOINT_VERSION, main, parseArgs, restore, runRoutingBackfill };
