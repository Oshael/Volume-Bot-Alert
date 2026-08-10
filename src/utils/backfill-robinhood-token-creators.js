/** Resolve token creators through Blockscout. Dry-run unless confirmation is explicit. */
const db = require('../models/db');
const { createRobinhoodTokenAttributionRepository } = require('../models/robinhood-token-attribution');
const { createRobinhoodBlockscoutMetadataClient } = require('../services/robinhood-blockscout-metadata');

const CONFIRM = '--confirm-backfill-robinhood-token-creators';

function boundedInteger(value, name, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be ${minimum}..${maximum}`);
  }
  return parsed;
}

function parseArgs(argv = process.argv.slice(2)) {
  const read = (name, fallback) => {
    const index = argv.indexOf(name);
    return index < 0 ? fallback : argv[index + 1];
  };
  const limit = boundedInteger(read('--limit', 100), '--limit', 1, 1000);
  const sleepMs = boundedInteger(read('--sleep-ms', 100), '--sleep-ms', 0, 60000);
  const retryHours = Number(read('--retry-hours', 24));
  const requestRetries = boundedInteger(
    read('--request-retries', 2), '--request-retries', 0, 5,
  );
  const retryDelayMs = boundedInteger(
    read('--retry-delay-ms', 500), '--retry-delay-ms', 0, 60000,
  );
  const timeoutMs = boundedInteger(read('--timeout-ms', 10000), '--timeout-ms', 1000, 15000);
  if (!Number.isFinite(retryHours) || retryHours < 0) throw new Error('--retry-hours must be >= 0');
  return {
    apply: argv.includes(CONFIRM), limit, sleepMs, retryHours,
    requestRetries, retryDelayMs, timeoutMs,
  };
}

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function isRetryableProviderError(error) {
  if (error?.code === 'timeout' || error?.code === 'transport_error') return true;
  return error?.code === 'http_error'
    && (error.httpStatus === 429 || Number(error.httpStatus) >= 500);
}

async function resolveCreatorWithRetry(client, tokenAddress, options, wait = delay) {
  const requestRetries = Number.isSafeInteger(options.requestRetries) ? options.requestRetries : 2;
  const retryDelayMs = Number.isSafeInteger(options.retryDelayMs) ? options.retryDelayMs : 500;
  let retries = 0;
  for (;;) {
    try {
      return { creatorAddress: await client.getContractCreator(tokenAddress), retries };
    } catch (error) {
      if (!isRetryableProviderError(error) || retries >= requestRetries) {
        error.requestRetriesUsed = retries;
        throw error;
      }
      await wait(Math.min(60000, retryDelayMs * (2 ** retries)));
      retries += 1;
    }
  }
}

async function run(deps = {}) {
  const options = deps.options || parseArgs();
  const repository = deps.repository || createRobinhoodTokenAttributionRepository();
  const retryBefore = new Date(Date.now() - options.retryHours * 3600000);
  const candidates = await repository.listCreatorCandidates({ limit: options.limit, retryBefore });
  const summary = {
    apply: options.apply, candidates: candidates.length,
    resolved: 0, unresolved: 0, failed: 0, retried: 0,
  };
  if (!options.apply) return summary;
  const clientFactory = deps.clientFactory || createRobinhoodBlockscoutMetadataClient;
  const client = deps.client || clientFactory({ timeoutMs: options.timeoutMs ?? 10000 });
  for (const candidate of candidates) {
    let creatorAddress;
    try {
      const resolved = await resolveCreatorWithRetry(
        client, candidate.tokenAddress, options, deps.delay || delay,
      );
      creatorAddress = resolved.creatorAddress;
      summary.retried += resolved.retries;
    } catch (error) {
      summary.retried += error.requestRetriesUsed || 0;
      await repository.recordAttempt({ ...candidate, error: error.message });
      summary.failed += 1;
      if (options.sleepMs) await (deps.delay || delay)(options.sleepMs);
      continue;
    }
    await repository.recordAttempt({ ...candidate, creatorAddress });
    if (creatorAddress) summary.resolved += 1;
    else summary.unresolved += 1;
    if (options.sleepMs) await (deps.delay || delay)(options.sleepMs);
  }
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
  __private: { isRetryableProviderError, resolveCreatorWithRetry },
};
