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

function modeFromOptions(options) {
  if (options.audit) return 'audit';
  return options.write ? 'write' : 'dry-run';
}

function parseRunMode(values) {
  const write = values.write === 'true';
  const audit = values.audit === 'true';
  if (values.write != null && !write) throw new Error('--write does not accept a value');
  if (values.audit != null && !audit) throw new Error('--audit does not accept a value');
  if (write && audit) throw new Error('--write and --audit are mutually exclusive');
  const checkpointFile = String(values['checkpoint-file'] || '').trim();
  if ((write || audit) && !checkpointFile) {
    throw new Error('--checkpoint-file is required with --write or --audit');
  }
  if (!write && !audit && checkpointFile) {
    throw new Error('--checkpoint-file requires --write or --audit');
  }
  return { write, audit, checkpointFile: checkpointFile ? path.resolve(checkpointFile) : null };
}

function parseArgs(argv = []) {
  const allowed = new Set([
    'write', 'audit', 'checkpoint-file', 'page-batch', 'max-batches', 'pause-ms',
    'statement-timeout-ms', 'max-canonical-lag-blocks',
  ]);
  const values = {};
  for (const argument of argv) {
    const match = String(argument).match(/^--([^=]+)(?:=(.*))?$/);
    if (!match || !allowed.has(match[1])) throw new Error(`unknown argument: ${argument}`);
    values[match[1]] = match[2] ?? 'true';
  }
  return Object.freeze({
    ...parseRunMode(values),
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

function hasValidProgress(saved) {
  return Number.isSafeInteger(saved.targetHeapBlocks) && saved.targetHeapBlocks >= 0
    && Number.isSafeInteger(saved.nextHeapBlock) && saved.nextHeapBlock >= 0
    && saved.nextHeapBlock <= saved.targetHeapBlocks
    && saved.completed === (saved.nextHeapBlock >= saved.targetHeapBlocks);
}

function restore(saved, source, options) {
  if (!Number.isSafeInteger(source.heapBlocks) || source.heapBlocks < 0) {
    throw new Error('head state heap size is invalid');
  }
  if (!saved) return {
    version: CHECKPOINT_VERSION, scan: 'head-routing',
    mode: modeFromOptions(options),
    relationFileNode: source.relationFileNode,
    targetHeapBlocks: source.heapBlocks, nextHeapBlock: 0,
    completed: source.heapBlocks === 0, batches: 0, candidates: 0, updated: 0,
    active: 0, missingPayload: 0, divergent: 0, incomplete: 0,
  };
  const mode = modeFromOptions(options);
  if (mode === 'dry-run' || saved.version !== CHECKPOINT_VERSION
      || saved.scan !== 'head-routing' || saved.mode !== mode) {
    throw new Error('routing checkpoint mode or version is invalid');
  }
  if (saved.relationFileNode !== source.relationFileNode) {
    throw new Error('head state relation was rewritten; use a new routing checkpoint');
  }
  if (!hasValidProgress(saved)) {
    throw new Error('routing checkpoint progress is invalid');
  }
  return saved;
}

function recordBatch(state, batch, options, endBlock) {
  state.nextHeapBlock = endBlock;
  state.completed = endBlock >= state.targetHeapBlocks;
  state.batches += 1;
  if (options.audit) {
    for (const field of ['active', 'missingPayload', 'divergent', 'incomplete']) {
      state[field] += batch[field];
    }
  } else {
    state.candidates += batch.candidates;
    state.updated += batch.updated;
  }
  state.updatedAt = new Date().toISOString();
}

async function runOneBatch({ repository, store, logger, state, options }) {
  const current = await repository.describeRoutingPhysicalSource();
  if (current.relationFileNode !== state.relationFileNode) {
    throw new Error('head state relation was rewritten during routing backfill');
  }
  await repository.assertMaintenanceAllowed(options.maxCanonicalLagBlocks);
  const endBlock = Math.min(state.nextHeapBlock + options.pageBatch, state.targetHeapBlocks);
  const batchInput = {
    startBlock: state.nextHeapBlock, endBlock, write: options.write,
    statementTimeoutMs: options.statementTimeoutMs,
  };
  const batch = options.audit
    ? await repository.auditRoutingPhysicalBatch(batchInput)
    : await repository.processRoutingPhysicalBatch(batchInput);
  recordBatch(state, batch, options, endBlock);
  if (options.write || options.audit) await store.save(state);
  logger.log(JSON.stringify({ phase: 'batch', scan: 'head-routing', ...batch,
    batch: state.batches, completed: state.completed }));
}

function buildReport(state, options) {
  const parityObserved = options.audit && state.completed
    && state.missingPayload === 0 && state.divergent === 0 && state.incomplete === 0;
  return Object.freeze({
    phase: 'summary', scan: 'head-routing', mode: state.mode,
    completed: state.completed, requiresFinalAudit: !parityObserved,
    requiresPointInTimeGate: true, parityObserved,
    batches: state.batches, candidates: state.candidates, updated: state.updated,
    active: state.active, missingPayload: state.missingPayload,
    divergent: state.divergent, incomplete: state.incomplete,
    nextHeapBlock: state.nextHeapBlock, targetHeapBlocks: state.targetHeapBlocks,
  });
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
    await runOneBatch({ repository, store, logger, state, options });
    if (!state.completed && index + 1 < options.maxBatches && options.pauseMs > 0) {
      await pause(options.pauseMs);
    }
  }
  const report = buildReport(state, options);
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

if (require.main === module) main().then((report) => {
  if (report.mode === 'audit' && report.completed && !report.parityObserved) {
    process.exitCode = 2;
  }
}).catch((error) => {
  console.error(JSON.stringify({ phase: 'error', message: error.message }));
  process.exitCode = 1;
});

module.exports = { CHECKPOINT_VERSION, main, parseArgs, restore, runRoutingBackfill };
