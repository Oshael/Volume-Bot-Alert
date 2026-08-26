require('dotenv').config();

const db = require('../models/db');
const { createRobinhoodBundleFundingCandidateSource } = require(
  '../models/robinhood-bundle-funding-candidate-source'
);
const { planBundleFundingScan } = require('../services/robinhood-bundle-funding-scan-plan');
const { createEvmJsonRpcClient } = require('../services/evm-json-rpc-client');
const {
  createRobinhoodBundleFundingReader, preflightBundleFunding,
} = require('../services/robinhood-bundle-funding-reader');

const PREFIXES = Object.freeze([
  '--lookback-blocks=', '--source-from-block=', '--statement-timeout-ms=',
  '--batch-blocks=', '--concurrency=', '--samples=', '--max-hours=',
]);

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
  const unknown = argv.find((argument) => !PREFIXES.some((prefix) => (
    argument.startsWith(prefix)
  )));
  if (unknown) throw new Error(`unknown argument: ${unknown}`);
  const lookback = one(argv, '--lookback-blocks=');
  if (lookback == null) throw new Error('--lookback-blocks is required');
  const maxHours = Number(one(argv, '--max-hours=') ?? 5);
  if (!Number.isFinite(maxHours) || maxHours <= 0 || maxHours > 5) {
    throw new Error('--max-hours must be greater than 0 and at most 5');
  }
  const parsed = Object.freeze({
    lookbackBlocks: integer(lookback, null, 0, 50_000_000, '--lookback-blocks'),
    sourceFromBlock: integer(
      one(argv, '--source-from-block='), 0, 0, 50_000_000, '--source-from-block'
    ).toString(),
    statementTimeoutMs: integer(
      one(argv, '--statement-timeout-ms='), 120_000, 1_000, 900_000,
      '--statement-timeout-ms'
    ),
    batchBlocks: integer(one(argv, '--batch-blocks='), 50, 1, 100, '--batch-blocks'),
    concurrency: integer(one(argv, '--concurrency='), 8, 1, 16, '--concurrency'),
    sampleCount: integer(one(argv, '--samples='), 16, 1, 64, '--samples'),
    maxHours,
  });
  if (parsed.sampleCount < parsed.concurrency) {
    throw new Error('--samples must be greater than or equal to --concurrency');
  }
  return parsed;
}

function requiredEnvironment(env, name) {
  const value = String(env[name] || '').trim();
  if (!value) throw new Error(`missing required env ${name}`);
  return value;
}

function archiveClient(env, factory = createEvmJsonRpcClient) {
  return factory({
    providers: [{ name: 'robinhood-pc-archive', url: requiredEnvironment(env, 'RH_NODE_RPC_URL') }],
    timeoutMs: 60_000, maxRetries: 1,
  });
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const options = deps.options || parseArgs(argv);
  const database = deps.database || db;
  requiredEnvironment(deps.env || process.env, 'DATABASE_URL');
  const source = deps.source || createRobinhoodBundleFundingCandidateSource({
    database, statementTimeoutMs: options.statementTimeoutMs,
  });
  const loaded = await source.load();
  if (!loaded.ready) throw new Error(`bundle funding source unavailable: ${loaded.reason}`);
  const plan = (deps.planner || planBundleFundingScan)({
    sourceFromBlock: options.sourceFromBlock,
    sourceThroughBlock: loaded.completeThroughBlock,
    lookbackBlocks: options.lookbackBlocks,
    candidates: loaded.candidates,
  });
  const reader = deps.reader || createRobinhoodBundleFundingReader({
    rpcClient: deps.rpcClient || archiveClient(deps.env || process.env, deps.rpcClientFactory),
    candidateWallets: plan.candidates.map(({ walletAddress }) => walletAddress),
  });
  const preflight = await (deps.preflight || preflightBundleFunding)({
    ranges: plan.ranges, sourceThroughBlock: plan.sourceThroughBlock,
    batchBlocks: options.batchBlocks, concurrency: options.concurrency,
    sampleCount: options.sampleCount, maxHours: options.maxHours,
  }, { reader, now: deps.now });
  const report = Object.freeze({
    mode: 'preflight-read-only', source: 'postgresql-candidates+rpc-archive-full-block',
    approved: preflight.approved, anchorCoverageComplete: loaded.anchorCoverageComplete,
    missingAnchorTokens: loaded.missingAnchorTokens,
    ruleVersion: plan.ruleVersion, lookbackBlocks: plan.lookbackBlocks,
    candidateTokens: plan.candidateTokens, candidateWallets: plan.candidateWallets,
    mergedRanges: plan.mergedRanges, blocksToScan: plan.blocksToScan,
    ...preflight,
  });
  (deps.logger || console).log(JSON.stringify(report, null, 2));
  return report;
}

if (require.main === module) main().catch((error) => {
  console.error('Robinhood BUNDLED funding preflight failed:', error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = { archiveClient, main, parseArgs };
