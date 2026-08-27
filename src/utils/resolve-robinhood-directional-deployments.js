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
const {
  createRobinhoodArchiveDeploymentDiscovery,
} = require('../services/robinhood-archive-deployment-discovery');

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

function failureReason(error, fallback = 'verification_failed') {
  const code = String(error?.code || fallback);
  if (error?.httpStatus != null) return `${code}:${error.httpStatus}`;
  const message = String(error?.message || '').trim();
  return message && message !== code ? `${code}:${message}` : code;
}

async function verifyHints(deps, candidates, options, hints) {
  const outcomes = await mapConcurrent(candidates, options.concurrency, async (candidate) => {
    const hint = hints.get(candidate.tokenAddress);
    if (!hint) return { candidate, error: 'blockscout_address_not_found' };
    if (!hint.creatorAddress) return { candidate, error: 'blockscout_creator_missing' };
    if (!hint.transactionHash) return { candidate, error: 'blockscout_creation_transaction_missing' };
    try {
      return { candidate, deployment: await deps.verifier.verifyDirectDeployment(hint) };
    } catch (error) {
      if (error?.code === 'holder_deployment_evidence_invalid' && deps.deploymentDiscovery) {
        try {
          const discovered = await deps.deploymentDiscovery.discover(hint);
          return {
            candidate,
            deployment: await deps.verifier.verifyDirectDeployment(discovered),
          };
        } catch (discoveryFailure) {
          return { candidate, error: `deployment_discovery:${failureReason(discoveryFailure)}` };
        }
      }
      return { candidate, error: `deployment_verification:${failureReason(error)}` };
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
  return { verified: verified.length, failed: failed.length };
}

async function resolveNativeBatch(deps, candidates, options) {
  const lookups = await mapConcurrent(candidates, options.concurrency, async (candidate) => {
    try {
      const response = await requestWithRetry(
        () => deps.blockscout.getContractCreation(candidate.tokenAddress),
        { requestRetries: 2, retryDelayMs: 500 }, deps.sleep,
      );
      return { candidate, hint: response.value, retries: response.retries, providerFailure: false };
    } catch (error) {
      await deps.attributions.recordDirectVerificationFailure({
        tokenAddress: candidate.tokenAddress,
        error: `contract_creation_lookup:${failureReason(error, 'blockscout_provider_failure')}`,
      });
      return {
        candidate, hint: null, retries: error.requestRetriesUsed || 0, providerFailure: true,
      };
    }
  });
  const available = lookups.filter((lookup) => !lookup.providerFailure);
  const hints = new Map(available.map((lookup) => [lookup.candidate.tokenAddress, lookup.hint]));
  const verified = await verifyHints(
    deps, available.map((lookup) => lookup.candidate), options, hints,
  );
  const providerFailures = lookups.length - available.length;
  return {
    verified: verified.verified,
    failed: verified.failed + providerFailures,
    retries: lookups.reduce((total, lookup) => total + lookup.retries, 0),
    splits: 0,
    providerFailures,
  };
}

async function resolveBatch(deps, candidates, options) {
  if (typeof deps.blockscout.getContractCreation === 'function') {
    return resolveNativeBatch(deps, candidates, options);
  }
  let response;
  try {
    response = await requestWithRetry(
      () => deps.blockscout.getContractCreators(candidates.map((item) => item.tokenAddress)),
      { requestRetries: candidates.length > 1 ? 0 : 2, retryDelayMs: 500 }, deps.sleep,
    );
  } catch (error) {
    if (error.retryable === true && candidates.length > 1) {
      const middle = Math.ceil(candidates.length / 2);
      const parts = [];
      parts.push(await resolveBatch(deps, candidates.slice(0, middle), options));
      parts.push(await resolveBatch(deps, candidates.slice(middle), options));
      return parts.reduce((total, part) => ({
        verified: total.verified + part.verified,
        failed: total.failed + part.failed,
        retries: total.retries + part.retries,
        splits: total.splits + part.splits,
        providerFailures: total.providerFailures + part.providerFailures,
      }), { verified: 0, failed: 0, retries: 0, splits: 1, providerFailures: 0 });
    }
    if (error.retryable !== true) throw error;
    await deps.attributions.recordDirectVerificationFailure({
      tokenAddress: candidates[0].tokenAddress,
      error: failureReason(error, 'blockscout_provider_failure'),
    });
    return {
      verified: 0, failed: 1, retries: error.requestRetriesUsed || 0,
      splits: 0, providerFailures: 1,
    };
  }
  const verified = await verifyHints(
    deps, candidates, options,
    new Map(response.value.map((item) => [item.tokenAddress, item])),
  );
  return {
    verified: verified.verified, failed: verified.failed, retries: response.retries,
    splits: 0, providerFailures: 0,
  };
}

function buildRuntime(options, deps = {}) {
  const env = deps.env || process.env;
  const rpcUrl = String(env.RH_NODE_RPC_URL || '').trim();
  if (!rpcUrl) throw new Error('RH_NODE_RPC_URL is required');
  const apiKey = String(env.ROBINHOOD_BLOCKSCOUT_API_KEY || '').trim();
  const apiUrl = String(env.ROBINHOOD_BLOCKSCOUT_API_URL
    || (apiKey ? DEFAULT_PRO_API_URL : DEFAULT_API_URL)).trim();
  const database = deps.database || db;
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const rpcClient = (deps.rpcClientFactory || createEvmJsonRpcClient)({
    providers: [{ name: 'robinhood-pc-archive', url: rpcUrl }],
    timeoutMs: options.timeoutMs, maxRetries: 1,
  });
  const blockscout = (deps.blockscoutFactory || createRobinhoodBlockscoutMetadataClient)({
    apiKey, apiUrl, timeoutMs: options.timeoutMs,
  });
  const deploymentDiscovery = createRobinhoodArchiveDeploymentDiscovery({
    rpcClient,
    blockCreationLookup: async (tokenAddress, blockNumber) => (await requestWithRetry(
      () => blockscout.getContractCreationAtBlock(tokenAddress, blockNumber),
      { requestRetries: 2, retryDelayMs: 500 }, sleep,
    )).value,
  });
  return Object.freeze({
    gaps: createRobinhoodDirectionalDeploymentGapRepository({ database }),
    attributions: createRobinhoodTokenAttributionRepository({ database }),
    blockscout,
    verifier: createRobinhoodHolderDeploymentVerifier({
      rpcClient,
      internalCreationLookup: async (hint) => (await requestWithRetry(
        () => blockscout.getInternalContractCreation(hint.transactionHash, hint.tokenAddress),
        { requestRetries: 2, retryDelayMs: 500 }, sleep,
      )).value,
    }),
    deploymentDiscovery,
    sleep,
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
  const summary = {
    candidates: candidates.length, verified: 0, failed: 0, retries: 0,
    splits: 0, providerFailures: 0,
  };
  for (const batch of chunks(candidates, options.batchSize)) {
    const result = await resolveBatch(runtime, batch, options);
    summary.verified += result.verified;
    summary.failed += result.failed;
    summary.retries += result.retries;
    summary.splits += result.splits;
    summary.providerFailures += result.providerFailures;
  }
  const report = { mode: 'apply', runId: options.runId, plan, summary };
  (deps.logger || console).log(JSON.stringify(report, null, 2));
  return report;
}

if (require.main === module) main().catch((error) => {
  console.error('Robinhood directional deployment resolution failed:', error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = {
  CONFIRM_FLAG, main, parseArgs, resolveBatch,
  __private: { buildRuntime },
};
