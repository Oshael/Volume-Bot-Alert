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
    'write', 'batch-size', 'max-batches', 'pause-ms',
    'statement-timeout-ms', 'checkpoint-file', 'max-canonical-lag-blocks',
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
  return Object.freeze({
    write,
    batchSize: integer(values['batch-size'], 1_000, 1, 5_000, 'batch-size'),
    maxBatches: integer(values['max-batches'], 1, 1, 1_000, 'max-batches'),
    pauseMs: integer(values['pause-ms'], 250, 0, 60_000, 'pause-ms'),
    statementTimeoutMs: integer(
      values['statement-timeout-ms'], 30_000, 1_000, 300_000, 'statement-timeout-ms'
    ),
    maxCanonicalLagBlocks: integer(
      values['max-canonical-lag-blocks'], 128, 0, 1_000_000, 'max-canonical-lag-blocks'
    ),
    checkpointFile: checkpointFile ? path.resolve(checkpointFile) : null,
  });
}

function createCheckpointStore(filename) {
  if (!filename) return Object.freeze({ load: async () => null, save: async () => {} });
  return Object.freeze({
    async load() {
      try {
        return JSON.parse(await fs.readFile(filename, 'utf8'));
      } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw new Error(`Cannot read checkpoint ${filename}: ${error.message}`);
      }
    },
    async save(value) {
      await fs.mkdir(path.dirname(filename), { recursive: true });
      const temporary = `${filename}.tmp-${process.pid}`;
      try {
        await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
        await fs.rename(temporary, filename);
      } finally {
        await fs.unlink(temporary).catch((error) => {
          if (error?.code !== 'ENOENT') throw error;
        });
      }
    },
  });
}

function initialState(write) {
  return {
    version: CHECKPOINT_VERSION, mode: write ? 'write' : 'dry-run',
    cursor: null, completed: false, batches: 0, scanned: 0, inserted: 0,
  };
}

function restoreState(saved, options) {
  if (!saved) return initialState(options.write);
  const mode = options.write ? 'write' : 'dry-run';
  if (saved.version !== CHECKPOINT_VERSION || saved.mode !== mode) {
    throw new Error('checkpoint does not match this execution mode or version');
  }
  if (saved.completed === true) return saved;
  if (saved.cursor != null) {
    const hash = String(saved.cursor.transactionHash || '');
    const logIndex = String(saved.cursor.logIndex ?? '');
    if (!/^0x[0-9a-f]{64}$/.test(hash) || !/^\d+$/.test(logIndex)) {
      throw new Error('checkpoint cursor is invalid');
    }
  }
  return saved;
}

async function runBackfill(options, deps = {}) {
  const repository = deps.repository || createRobinhoodHeadCaptureStateRepository({
    database: deps.database || db,
  });
  const checkpoint = deps.checkpoint || createCheckpointStore(options.checkpointFile);
  const pause = deps.pause || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const logger = deps.logger || console;
  await repository.assertMirrorReady();
  const state = restoreState(await checkpoint.load(), options);
  let blocked = null;
  for (let index = 0; index < options.maxBatches && !state.completed; index += 1) {
    await repository.assertMaintenanceAllowed(options.maxCanonicalLagBlocks);
    const batch = await repository.processBatch({
      after: state.cursor, limit: options.batchSize, write: options.write,
      statementTimeoutMs: options.statementTimeoutMs,
    });
    if (batch.missing > 0 || batch.divergent > 0) {
      blocked = { missing: batch.missing, divergent: batch.divergent };
      break;
    }
    state.cursor = batch.next;
    state.completed = batch.complete;
    state.batches += 1;
    state.scanned += batch.scanned;
    state.inserted += batch.inserted;
    state.updatedAt = new Date().toISOString();
    await checkpoint.save(state);
    logger.log(JSON.stringify({ phase: 'batch', mode: state.mode,
      batch: state.batches, ...batch }));
    if (!state.completed && index + 1 < options.maxBatches && options.pauseMs > 0) {
      await pause(options.pauseMs);
    }
  }
  const report = Object.freeze({
    phase: 'summary', mode: state.mode, completed: state.completed,
    approved: options.write && state.completed && blocked == null,
    blocked, batches: state.batches, scanned: state.scanned,
    inserted: state.inserted, cursor: state.cursor,
  });
  logger.log(JSON.stringify(report));
  return report;
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const options = deps.options || parseArgs(argv);
  try {
    return await runBackfill(options, deps);
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

module.exports = {
  CHECKPOINT_VERSION, createCheckpointStore, main, parseArgs, restoreState, runBackfill,
};
