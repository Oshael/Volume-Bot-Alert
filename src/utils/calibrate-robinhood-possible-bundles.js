require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const db = require('../models/db');
const {
  createRobinhoodPossibleBundleCalibrator,
} = require('../services/robinhood-possible-bundle-calibrator');

const VALUE_ARGUMENTS = new Set([
  'run-id', 'thresholds-wei', 'page-size', 'concurrency', 'max-pages',
  'after-token', 'statement-timeout-ms', 'checkpoint-file',
]);

function integer(value, fallback, minimum, maximum, label) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function parseArgs(argv = []) {
  const values = {};
  for (const argument of argv) {
    const match = argument.match(/^--([a-z-]+)=(.+)$/);
    if (!match || !VALUE_ARGUMENTS.has(match[1]) || values[match[1]] != null) {
      throw new Error(`unknown or repeated argument: ${argument}`);
    }
    values[match[1]] = match[2];
  }
  if (values['run-id'] == null) throw new Error('--run-id is required');
  if (values['thresholds-wei'] == null) throw new Error('--thresholds-wei is required');
  const maxPages = integer(values['max-pages'], 1, 1, 1_000, '--max-pages');
  if (maxPages > 1 && values['checkpoint-file'] == null) {
    throw new Error('--checkpoint-file is required when --max-pages is greater than 1');
  }
  return Object.freeze({
    runId: String(integer(values['run-id'], null, 1, Number.MAX_SAFE_INTEGER, '--run-id')),
    thresholdsWei: values['thresholds-wei'].split(','),
    pageSize: integer(values['page-size'], 100, 1, 100, '--page-size'),
    concurrency: integer(values.concurrency, 4, 1, 4, '--concurrency'),
    maxPages,
    afterToken: values['after-token'] || null,
    checkpointFile: values['checkpoint-file'] ? path.resolve(values['checkpoint-file']) : null,
    statementTimeoutMs: integer(
      values['statement-timeout-ms'], 120_000, 1_000, 900_000, '--statement-timeout-ms'
    ),
  });
}

function readCheckpoint(file) {
  if (!file || !fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeCheckpoint(file, value) {
  if (!file) return;
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const options = deps.options || parseArgs(argv);
  const database = deps.database || db;
  const logger = deps.logger || console;
  const loadCheckpoint = deps.readCheckpoint || readCheckpoint;
  const persistCheckpoint = deps.writeCheckpoint || writeCheckpoint;
  const resume = loadCheckpoint(options.checkpointFile);
  const calibrator = deps.calibrator || createRobinhoodPossibleBundleCalibrator({
    database, statementTimeoutMs: options.statementTimeoutMs,
  });
  const report = await calibrator.audit({ ...options, resume,
    onProgress: async (progress) => {
      persistCheckpoint(options.checkpointFile, progress);
      logger.error?.(`[PossibleBundleCalibration] ${JSON.stringify({
        pages: progress.pages, evaluatedTokens: progress.evaluatedTokens,
        totalCandidateTokens: progress.totalCandidateTokens,
        progressBps: progress.progressBps, elapsedMs: progress.elapsedMs,
        estimatedRemainingMs: progress.estimatedRemainingMs,
      })}`);
    } });
  if (!report.blocked) persistCheckpoint(options.checkpointFile, report);
  logger.log(JSON.stringify(report, null, 2));
  return report;
}

if (require.main === module) main().catch((error) => {
  console.error('[PossibleBundleCalibration] Fatal:', error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = { main, parseArgs, __private: { readCheckpoint, writeCheckpoint } };
