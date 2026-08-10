/** Resolve token creators through Blockscout. Dry-run unless confirmation is explicit. */
const db = require('../models/db');
const { createRobinhoodTokenAttributionRepository } = require('../models/robinhood-token-attribution');
const {
  createRobinhoodBlockscoutMetadataClient,
  DEFAULT_API_URL,
  DEFAULT_PRO_API_URL,
  requestWithRetry,
  __private: { isRetryableProviderError },
} = require('../services/robinhood-blockscout-metadata');

const CONFIRM = '--confirm-backfill-robinhood-token-creators';

function boundedInteger(value, name, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be ${minimum}..${maximum}`);
  }
  return parsed;
}

function parseArgs(argv = process.argv.slice(2), env = process.env) {
  const read = (name, fallback) => {
    const index = argv.indexOf(name);
    return index < 0 ? fallback : argv[index + 1];
  };
  const limit = boundedInteger(read('--limit', 1000), '--limit', 1, 10000);
  const sleepMs = boundedInteger(read('--sleep-ms', 500), '--sleep-ms', 0, 60000);
  const retryHours = Number(read('--retry-hours', 24));
  const requestRetries = boundedInteger(
    read('--request-retries', 2), '--request-retries', 0, 5,
  );
  const retryDelayMs = boundedInteger(
    read('--retry-delay-ms', 500), '--retry-delay-ms', 0, 60000,
  );
  const timeoutMs = boundedInteger(read('--timeout-ms', 10000), '--timeout-ms', 1000, 15000);
  const batchSize = boundedInteger(read('--batch-size', 10), '--batch-size', 1, 10);
  const concurrency = boundedInteger(read('--concurrency', 2), '--concurrency', 1, 5);
  const apiKey = String(env.ROBINHOOD_BLOCKSCOUT_API_KEY || '').trim() || null;
  const apiUrl = String(env.ROBINHOOD_BLOCKSCOUT_API_URL || (
    apiKey ? DEFAULT_PRO_API_URL : DEFAULT_API_URL
  )).trim();
  if (!Number.isFinite(retryHours) || retryHours < 0) throw new Error('--retry-hours must be >= 0');
  return {
    apply: argv.includes(CONFIRM), limit, sleepMs, retryHours,
    requestRetries, retryDelayMs, timeoutMs, batchSize, concurrency,
    apiKey, apiUrl,
  };
}

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function resolveCreatorBatchWithRetry(client, tokenAddresses, options, wait = delay) {
  const result = await requestWithRetry(
    () => client.getContractCreators(tokenAddresses), options, wait,
  );
  return { creators: result.value, retries: result.retries };
}

function chunks(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

async function run(deps = {}) {
  const options = deps.options || parseArgs();
  const repository = deps.repository || createRobinhoodTokenAttributionRepository();
  const retryBefore = new Date(Date.now() - options.retryHours * 3600000);
  const selection = await repository.listCreatorCandidates({
    limit: options.limit, retryBefore, includeEligible: !options.apply,
  });
  const { candidates } = selection;
  const batches = chunks(candidates, options.batchSize ?? 10);
  const summary = {
    apply: options.apply, eligible: selection.eligible, candidates: candidates.length,
    batches: batches.length, requests: 0,
    resolved: 0, unresolved: 0, failed: 0, retried: 0,
    creditsRemaining: null, stopReason: null,
  };
  if (!options.apply) return summary;
  const clientFactory = deps.clientFactory || createRobinhoodBlockscoutMetadataClient;
  const clientOptions = { timeoutMs: options.timeoutMs ?? 10000 };
  if (options.apiKey) clientOptions.apiKey = options.apiKey;
  if (options.apiUrl) clientOptions.apiUrl = options.apiUrl;
  const client = deps.client || clientFactory(clientOptions);

  const persistAttempts = async (attempts) => {
    if (typeof repository.recordAttempts === 'function') return repository.recordAttempts(attempts);
    return Promise.all(attempts.map((attempt) => repository.recordAttempt(attempt)));
  };
  const processBatch = async (batch) => {
    let resolved;
    try {
      resolved = await resolveCreatorBatchWithRetry(
        client, batch.map((candidate) => candidate.tokenAddress), options, deps.delay || delay,
      );
      summary.retried += resolved.retries;
      summary.requests += resolved.retries + 1;
    } catch (error) {
      summary.retried += error.requestRetriesUsed || 0;
      summary.requests += (error.requestRetriesUsed || 0) + 1;
      const creditsRemaining = error.creditsRemaining
        ?? client.getCreditsRemaining?.()
        ?? null;
      if (error.code === 'credits_exhausted' || creditsRemaining === 0) {
        summary.creditsRemaining = 0;
        summary.stopReason = 'credits_exhausted';
        return;
      }
      await persistAttempts(batch.map((candidate) => ({ ...candidate, error: error.message })));
      summary.failed += batch.length;
      return;
    }
    const byToken = new Map(resolved.creators.map((item) => [item.tokenAddress, item.creatorAddress]));
    const attempts = batch.map((candidate) => ({
      ...candidate, creatorAddress: byToken.get(candidate.tokenAddress) || null,
    }));
    await persistAttempts(attempts);
    summary.resolved += attempts.filter((attempt) => attempt.creatorAddress).length;
    summary.unresolved += attempts.filter((attempt) => !attempt.creatorAddress).length;
    const creditsRemaining = client.getCreditsRemaining?.() ?? null;
    if (creditsRemaining != null) summary.creditsRemaining = creditsRemaining;
    if (creditsRemaining === 0) summary.stopReason = 'credits_exhausted';
  };

  let nextBatch = 0;
  const worker = async () => {
    while (nextBatch < batches.length && summary.stopReason == null) {
      const batch = batches[nextBatch];
      nextBatch += 1;
      await processBatch(batch);
      if (options.sleepMs) await (deps.delay || delay)(options.sleepMs);
    }
  };
  const workerCount = Math.min(options.concurrency ?? 2, batches.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return summary;
}

async function main() {
  try { console.log(JSON.stringify(await run(), null, 2)); }
  catch (error) { console.error('creator backfill failed:', error.message); process.exitCode = 1; }
  finally { await db.pool.end().catch(() => {}); }
}

if (require.main === module) void main();

module.exports = {
  CONFIRM, parseArgs, run,
  __private: { chunks, isRetryableProviderError, resolveCreatorBatchWithRetry },
};
