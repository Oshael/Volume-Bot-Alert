require('dotenv').config();

const db = require('../models/db');
const {
  createRobinhoodDirectionalDeploymentGapRepository,
} = require('../models/robinhood-directional-deployment-gap');
const { createRobinhoodTokenAttributionRepository } = require('../models/robinhood-token-attribution');
const {
  createRobinhoodBlockscoutMetadataClient, DEFAULT_API_URL, DEFAULT_PRO_API_URL,
  requestWithRetry,
} = require('../services/robinhood-blockscout-metadata');
const { createEvmJsonRpcClient } = require('../services/evm-json-rpc-client');
const {
  createRobinhoodHolderDeploymentVerifier,
} = require('../services/robinhood-holder-deployment-verifier');

const CONFIRM_FLAG = '--confirm-resolve-robinhood-directional-deployments';

function bounded(value, fallback, minimum, maximum, label) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function parseArgs(argv = []) {
  const values = {};
  for (const argument of argv) {
    if (argument === CONFIRM_FLAG) {
      if (values.confirm) throw new Error(`${CONFIRM_FLAG} cannot be repeated`);
      values.confirm = true;
      continue;
    }
    const match = argument.match(/^--(run-id|limit|batch-size|concurrency|timeout-ms)=(.+)$/);
    if (!match) throw new Error(`unknown argument: ${argument}`);
    if (values[match[1]] !== undefined) throw new Error(`--${match[1]} cannot be repeated`);
    values[match[1]] = match[2];
  }
  if (!/^\d+$/.test(String(values['run-id'] ?? ''))) throw new Error('--run-id is required');
  return Object.freeze({
    confirm: values.confirm === true, runId: values['run-id'],
    limit: bounded(values.limit, 1000, 1, 5000, '--limit'),
    batchSize: bounded(values['batch-size'], 10, 1, 10, '--batch-size'),
    concurrency: bounded(values.concurrency, 4, 1, 8, '--concurrency'),
    timeoutMs: bounded(values['timeout-ms'], 30_000, 1000, 60_000, '--timeout-ms'),
  });
}

function chunks(items, size) {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) => (
    items.slice(index * size, (index + 1) * size)
  ));
}

async function mapConcurrent(items, concurrency, operation) {
  let cursor = 0;
  const results = new Array(items.length);
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await operation(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

async function resolveBatch(deps, candidates, options) {
  const response = await requestWithRetry(
    () => deps.blockscout.getContractCreators(candidates.map((item) => item.tokenAddress)),
    { requestRetries: 2, retryDelayMs: 500 }, deps.sleep,
  );
  const hints = new Map(response.value.map((item) => [item.tokenAddress, item]));
  const outcomes = await mapConcurrent(candidates, options.concurrency, async (candidate) => {
    const hint = hints.get(candidate.tokenAddress);
    if (!hint?.transactionHash || hint.creatorAddress !== candidate.creatorAddress) {
      return { candidate, error: 'blockscout_deployment_hint_incomplete' };
    }
    try {
      return { candidate, deployment: await deps.verifier.verifyDirectDeployment(hint) };
    } catch (error) {
      return { candidate, error: String(error.code || error.message || 'verification_failed') };
    }
  });
  const verified = outcomes.flatMap((outcome) => outcome.deployment ? [outcome.deployment] : []);
  if (verified.length) await deps.attributions.recordVerifiedDirectDeployments(verified);
  const failed = outcomes.filter((outcome) => outcome.error);
  for (const outcome of failed) {
    await deps.attributions.recordDirectVerificationFailure({
      tokenAddress: outcome.candidate.tokenAddress, error: outcome.error,
    });
  }
  return { verified: verified.length, failed: failed.length, retries: response.retries };
}

function buildRuntime(options, deps = {}) {
  const env = deps.env || process.env;
  const rpcUrl = String(env.RH_NODE_RPC_URL || '').trim();
  if (!rpcUrl) throw new Error('RH_NODE_RPC_URL is required');
  const apiKey = String(env.ROBINHOOD_BLOCKSCOUT_API_KEY || '').trim();
  const apiUrl = String(env.ROBINHOOD_BLOCKSCOUT_API_URL
    || (apiKey ? DEFAULT_PRO_API_URL : DEFAULT_API_URL)).trim();
  const database = deps.database || db;
  const rpcClient = (deps.rpcClientFactory || createEvmJsonRpcClient)({
    providers: [{ name: 'robinhood-pc-archive', url: rpcUrl }],
    timeoutMs: options.timeoutMs, maxRetries: 1,
  });
  return Object.freeze({
    gaps: createRobinhoodDirectionalDeploymentGapRepository({ database }),
    attributions: createRobinhoodTokenAttributionRepository({ database }),
    blockscout: (deps.blockscoutFactory || createRobinhoodBlockscoutMetadataClient)({
      apiKey, apiUrl, timeoutMs: Math.min(options.timeoutMs, 15_000),
    }),
    verifier: createRobinhoodHolderDeploymentVerifier({ rpcClient }),
    sleep: deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  });
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const options = deps.options || parseArgs(argv);
  const gaps = deps.runtime?.gaps || deps.gaps
    || createRobinhoodDirectionalDeploymentGapRepository({ database: deps.database || db });
  const plan = await gaps.plan(options.runId);
  if (!options.confirm) {
    const report = { mode: 'read-only', runId: options.runId, plan };
    (deps.logger || console).log(JSON.stringify(report, null, 2));
    return report;
  }
  const runtime = deps.runtime || buildRuntime(options, deps);
  const candidates = await runtime.gaps.listVerificationCandidates({
    runId: options.runId, limit: options.limit,
  });
  const summary = { candidates: candidates.length, verified: 0, failed: 0, retries: 0 };
  for (const batch of chunks(candidates, options.batchSize)) {
    const result = await resolveBatch(runtime, batch, options);
    summary.verified += result.verified;
    summary.failed += result.failed;
    summary.retries += result.retries;
  }
  const report = { mode: 'apply', runId: options.runId, plan, summary };
  (deps.logger || console).log(JSON.stringify(report, null, 2));
  return report;
}

if (require.main === module) main().catch((error) => {
  console.error('Robinhood directional deployment resolution failed:', error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = { CONFIRM_FLAG, main, parseArgs, resolveBatch };
