require('dotenv').config();

const db = require('../models/db');
const {
  createRobinhoodPossibleBundleSource,
} = require('../models/robinhood-possible-bundle-source');
const {
  createRobinhoodPossibleBundleRunner,
} = require('../services/robinhood-possible-bundle-runner');

const VALUE_ARGUMENTS = new Set([
  'run-id', 'minimum-value-wei', 'limit', 'concurrency', 'after-token',
  'statement-timeout-ms',
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
  return Object.freeze({
    apply: values.apply === true,
    runId: String(integer(values['run-id'], null, 1, Number.MAX_SAFE_INTEGER, '--run-id')),
    minimumValueWei: values['minimum-value-wei'],
    limit: integer(values.limit, 25, 1, 100, '--limit'),
    concurrency: integer(values.concurrency, 2, 1, 4, '--concurrency'),
    afterToken: values['after-token'] || null,
    statementTimeoutMs: integer(
      values['statement-timeout-ms'], 120_000, 1_000, 900_000, '--statement-timeout-ms'
    ),
  });
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const options = deps.options || parseArgs(argv);
  const database = deps.database || db;
  const logger = deps.logger || console;
  if (options.apply) {
    const runner = deps.runner || createRobinhoodPossibleBundleRunner({
      database, statementTimeoutMs: options.statementTimeoutMs,
    });
    const report = await runner.runPage(options);
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

module.exports = { main, parseArgs };
