require('dotenv').config();

const db = require('../models/db');
const {
  createRobinhoodBundleFundingCandidateSource,
} = require('../models/robinhood-bundle-funding-candidate-source');
const {
  planBundleFundingScan,
} = require('../services/robinhood-bundle-funding-scan-plan');

const PREFIXES = Object.freeze([
  '--lookback-blocks=', '--source-from-block=', '--statement-timeout-ms=',
]);

function one(argv, prefix) {
  const values = argv.filter((value) => value.startsWith(prefix));
  if (values.length > 1) throw new Error(`${prefix.slice(0, -1)} cannot be repeated`);
  return values[0]?.slice(prefix.length) ?? null;
}

function integer(value, fallback, minimum, maximum, label) {
  if (value != null && String(value).trim() === '') throw new Error(`${label} is required`);
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function lookbacks(value) {
  if (value == null) throw new Error('--lookback-blocks is required');
  const values = value.split(',').map((item) => integer(
    item, null, 0, 50_000_000, '--lookback-blocks'
  ));
  if (!values.length || values.length > 8) {
    throw new Error('--lookback-blocks must contain between 1 and 8 values');
  }
  return Object.freeze([...new Set(values)].sort((left, right) => left - right));
}

function parseArgs(argv = []) {
  const unknown = argv.find((argument) => !PREFIXES.some((prefix) => (
    argument.startsWith(prefix)
  )));
  if (unknown) throw new Error(`unknown argument: ${unknown}`);
  return Object.freeze({
    lookbackBlocks: lookbacks(one(argv, '--lookback-blocks=')),
    sourceFromBlock: integer(
      one(argv, '--source-from-block='), 0, 0, 50_000_000, '--source-from-block'
    ).toString(),
    statementTimeoutMs: integer(
      one(argv, '--statement-timeout-ms='), 120_000,
      1_000, 900_000, '--statement-timeout-ms'
    ),
  });
}

function summarize(plan) {
  const { candidates: _candidates, ranges: _ranges, ...summary } = plan;
  return Object.freeze(summary);
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const options = deps.options || parseArgs(argv);
  const source = deps.source || createRobinhoodBundleFundingCandidateSource({
    database: deps.database || db,
    statementTimeoutMs: options.statementTimeoutMs,
  });
  const loaded = await source.load();
  if (!loaded.ready) throw new Error(`bundle funding source unavailable: ${loaded.reason}`);
  const plans = options.lookbackBlocks.map((lookbackBlocks) => summarize(
    (deps.planner || planBundleFundingScan)({
      sourceFromBlock: options.sourceFromBlock,
      sourceThroughBlock: loaded.completeThroughBlock,
      lookbackBlocks,
      candidates: loaded.candidates,
    })
  ));
  const report = Object.freeze({
    mode: 'read-only', source: 'postgresql-first-buy-launch-anchor',
    completeThroughBlock: loaded.completeThroughBlock,
    firstBuyTokens: loaded.firstBuyTokens,
    anchoredTokens: loaded.anchoredTokens,
    missingAnchorTokens: loaded.missingAnchorTokens,
    anchorCoverageComplete: loaded.anchorCoverageComplete,
    sourceCandidateRows: loaded.candidates.length,
    plans: Object.freeze(plans),
  });
  (deps.logger || console).log(JSON.stringify(report, null, 2));
  return report;
}

if (require.main === module) main().catch((error) => {
  console.error('Robinhood BUNDLED funding plan failed:', error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = { main, parseArgs, summarize };
