require('dotenv').config();

const db = require('../models/db');
const {
  createRobinhoodInsiderShadowAuditor,
} = require('../services/robinhood-insider-shadow-auditor');

const PREFIXES = Object.freeze({
  '--limit=': 'sampleLimit', '--seed=': 'seed', '--statement-timeout-ms=': 'statementTimeoutMs',
});

function one(argv, prefix) {
  const values = argv.filter((value) => value.startsWith(prefix));
  if (values.length > 1) throw new Error(`${prefix.slice(0, -1)} cannot be repeated`);
  return values[0]?.slice(prefix.length) ?? null;
}

function integer(value, fallback, minimum, maximum, label) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function parseArgs(argv = []) {
  const unknown = argv.find((argument) => !Object.keys(PREFIXES).some((prefix) => (
    argument.startsWith(prefix)
  )));
  if (unknown) throw new Error(`unknown argument: ${unknown}`);
  const seed = one(argv, '--seed=') ?? 'default';
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(seed)) throw new Error('--seed is invalid');
  return Object.freeze({
    sampleLimit: integer(one(argv, '--limit='), 20, 1, 100, '--limit'), seed,
    statementTimeoutMs: integer(
      one(argv, '--statement-timeout-ms='), 10_000, 100, 30_000, '--statement-timeout-ms'
    ),
  });
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const options = parseArgs(argv);
  const auditor = (deps.auditorFactory || createRobinhoodInsiderShadowAuditor)({
    database: deps.database || db,
  });
  const report = await auditor.audit(options);
  (deps.logger || console).log(JSON.stringify(report, null, 2));
  return report;
}

if (require.main === module) main().catch((error) => {
  console.error('Robinhood INSIDER shadow audit failed:', error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = { main, parseArgs };
