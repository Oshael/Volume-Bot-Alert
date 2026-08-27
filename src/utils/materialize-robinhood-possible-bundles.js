require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const db = require('../models/db');
const {
  createRobinhoodPossibleBundleSource,
} = require('../models/robinhood-possible-bundle-source');
const {
  createRobinhoodPossibleBundleRunner,
} = require('../services/robinhood-possible-bundle-runner');

const VALUE_ARGUMENTS = new Set([
  'run-id', 'minimum-value-wei', 'limit', 'concurrency', 'after-token',
  'statement-timeout-ms', 'max-pages', 'checkpoint-file',
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
    if (argument === '--apply') {
      if (values.apply) throw new Error('repeated argument: --apply');
      values.apply = true;
      continue;
    }
    const match = argument.match(/^--([a-z-]+)=(.+)$/);
    if (!match || !VALUE_ARGUMENTS.has(match[1]) || values[match[1]] != null) {
      throw new Error(`unknown or repeated argument: ${argument}`);
    }
    values[match[1]] = match[2];
  }
  if (values['run-id'] == null) throw new Error('--run-id is required');
  if (!/^\d+$/.test(String(values['minimum-value-wei'] ?? ''))
      || BigInt(values['minimum-value-wei']) < 1n) {
    throw new Error('--minimum-value-wei must be positive');
  }
  const maxPages = integer(values['max-pages'], 1, 1, 1_000, '--max-pages');
  if (maxPages > 1 && values.apply !== true) {
    throw new Error('--max-pages greater than 1 requires --apply');
  }
  if (maxPages > 1 && values['checkpoint-file'] == null) {
    throw new Error('--checkpoint-file is required when --max-pages is greater than 1');
  }
  return Object.freeze({
    apply: values.apply === true,
    runId: String(integer(values['run-id'], null, 1, Number.MAX_SAFE_INTEGER, '--run-id')),
    minimumValueWei: values['minimum-value-wei'],
    limit: integer(values.limit, 25, 1, 100, '--limit'),
    concurrency: integer(values.concurrency, 2, 1, 4, '--concurrency'),
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
  if (options.apply) {
    const runner = deps.runner || createRobinhoodPossibleBundleRunner({
      database, statementTimeoutMs: options.statementTimeoutMs,
    });
    let report;
    if (options.maxPages > 1 || options.checkpointFile) {
      const loadCheckpoint = deps.readCheckpoint || readCheckpoint;
      const persistCheckpoint = deps.writeCheckpoint || writeCheckpoint;
      report = await runner.runCampaign({ ...options,
        resume: loadCheckpoint(options.checkpointFile),
        onProgress: async (progress) => {
          persistCheckpoint(options.checkpointFile, progress);
          logger.error?.(`[PossibleBundleShadow] ${JSON.stringify({
            pages: progress.pages, completed: progress.completed,
            totalCandidateTokens: progress.totalCandidateTokens,
            progressBps: progress.progressBps, elapsedMs: progress.elapsedMs,
            estimatedRemainingMs: progress.estimatedRemainingMs,
          })}`);
        } });
      if (!report.blocked) persistCheckpoint(options.checkpointFile, report);
    } else report = await runner.runPage(options);
    logger.log(JSON.stringify(report, null, 2));
    return report;
  }
  const source = deps.source || createRobinhoodPossibleBundleSource({
    database, statementTimeoutMs: options.statementTimeoutMs,
  });
  const tokens = await source.listSeedTokens(options);
  const report = Object.freeze({ mode: 'read-only', runId: options.runId,
    minimumValueWei: options.minimumValueWei, pageCandidates: tokens.length,
    pageAfterToken: options.afterToken, nextToken: tokens.at(-1) || null,
    exhausted: tokens.length < options.limit });
  logger.log(JSON.stringify(report, null, 2));
  return report;
}

if (require.main === module) main().catch((error) => {
  console.error('[PossibleBundleShadow] Fatal:', error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = { main, parseArgs, __private: { readCheckpoint, writeCheckpoint } };
