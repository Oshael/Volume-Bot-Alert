const db = require('../models/db');
const { createRobinhoodHolderBootstrapRepository } = require('../models/robinhood-holder-bootstrap');
const { createRobinhoodTokenAttributionRepository } = require('../models/robinhood-token-attribution');
const { createEvmJsonRpcClient } = require('./evm-json-rpc-client');
const { createRobinhoodBlockscoutMetadataClient, DEFAULT_PRO_API_URL } = require('./robinhood-blockscout-metadata');
const { createConfiguredRobinhoodHolderBackfillExecutor } = require('./robinhood-holder-backfill-executor');
const { runRobinhoodHolderColdTick } = require('./robinhood-holder-cold-tick');
const { createRobinhoodHolderDeploymentVerifier } = require('./robinhood-holder-deployment-verifier');
const { createRobinhoodHolderRequestScheduler } = require('./robinhood-holder-request-scheduler');
const { resolveRobinhoodHolderRpcProvider } = require('./robinhood-holder-rpc');

const PROVIDER_NAME = 'robinhood-holder-cold';
function boundedInteger(value, fallback, minimum, maximum, label) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    const error = new Error(`${label} must be between ${minimum} and ${maximum}`);
    error.code = 'configuration_error';
    throw error;
  }
  return parsed;
}
function admittedBefore(value, required) {
  if (value == null && !required) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    const error = new Error('holder cold admittedBefore is required and must be a timestamp');
    error.code = 'configuration_error';
    throw error;
  }
  return parsed.toISOString();
}
function normalizeRequestOptions(input = {}) {
  const requestsPerSecond = Number(input.requestsPerSecond ?? 0.25);
  if (!Number.isFinite(requestsPerSecond) || requestsPerSecond < 0.1 || requestsPerSecond > 0.5) {
    const error = new Error('cold requestsPerSecond must be between 0.1 and 0.5');
    error.code = 'configuration_error';
    throw error;
  }
  return Object.freeze({
    requestsPerSecond, concurrency: 1,
    maxRetries: boundedInteger(input.maxRetries, 1, 0, 1, 'cold maxRetries'),
  });
}
function normalizeOptions(input = {}) {
  const enabled = input.enabled === true;
  return Object.freeze({
    enabled, admittedBefore: admittedBefore(input.admittedBefore, enabled),
    intervalMs: boundedInteger(input.intervalMs, 60_000, 10_000, 3_600_000, 'intervalMs'),
    maxErrorBackoffMs: boundedInteger(input.maxErrorBackoffMs, 900_000, 10_000, 3_600_000, 'maxErrorBackoffMs'),
    candidateLimit: boundedInteger(input.candidateLimit, 10, 1, 10, 'candidateLimit'),
    retryMs: boundedInteger(input.retryMs, 7 * 86_400_000, 60_000, 30 * 86_400_000, 'retryMs'),
    rangeSize: boundedInteger(input.rangeSize, 250, 1, 5000, 'rangeSize'),
    confirmations: boundedInteger(input.confirmations, 12, 0, 1000, 'confirmations'),
    blockscoutTimeoutMs: boundedInteger(input.blockscoutTimeoutMs, 10_000, 1000, 15_000, 'blockscoutTimeoutMs'),
    requestOptions: normalizeRequestOptions(input.requestOptions),
  });
}
function resolveRpcProvider(env) {
  return resolveRobinhoodHolderRpcProvider(env, PROVIDER_NAME);
}
function buildRuntime(deps, options) {
  const env = deps.env || process.env;
  const database = deps.database || db;
  const rpcClient = deps.rpcClient || createEvmJsonRpcClient({
    providers: [resolveRpcProvider(env)],
    timeoutMs: boundedInteger(env.ROBINHOOD_RPC_TIMEOUT_MS, 15_000, 1000, 60_000, 'RPC timeout'),
    maxRetries: 1,
  });
  const apiKey = String(env.ROBINHOOD_BLOCKSCOUT_API_KEY || '').trim();
  const apiUrl = String(env.ROBINHOOD_BLOCKSCOUT_API_URL || (apiKey ? DEFAULT_PRO_API_URL : '')).trim();
  const blockscoutOptions = { timeoutMs: options.blockscoutTimeoutMs };
  if (apiKey) blockscoutOptions.apiKey = apiKey;
  if (apiUrl) blockscoutOptions.apiUrl = apiUrl;
  return Object.freeze({
    repository: (deps.repositoryFactory || createRobinhoodTokenAttributionRepository)({ database }),
    bootstrap: (deps.bootstrapFactory || createRobinhoodHolderBootstrapRepository)({ database }),
    executor: (deps.executorFactory || createConfiguredRobinhoodHolderBackfillExecutor)({ database, env, rpcClient }),
    blockscoutClient: (deps.blockscoutFactory || createRobinhoodBlockscoutMetadataClient)(blockscoutOptions),
    requestScheduler: (deps.schedulerFactory || createRobinhoodHolderRequestScheduler)(options.requestOptions),
    verifier: (deps.verifierFactory || createRobinhoodHolderDeploymentVerifier)({ rpcClient }),
  });
}
function publicError(error) {
  return Object.freeze({
    code: error.code || 'holder_cold_error',
    message: String(error.message || error).slice(0, 500), at: new Date().toISOString(),
  });
}
function createRobinhoodHolderColdWorker(deps = {}) {
  const schedule = deps.schedule || setTimeout;
  const cancelSchedule = deps.cancelSchedule || clearTimeout;
  const logger = deps.logger || console;
  const tick = deps.tick || runRobinhoodHolderColdTick;
  const runtimeFactory = deps.runtimeFactory || ((options) => buildRuntime(deps, options));
  let options = normalizeOptions();
  let runtimePromise = null;
  let timer = null;
  let activeRun = null;
  let running = false;
  let onFatal = null;
  const status = {
    enabled: false, running: false, inFlight: false, halted: false,
    totalRuns: 0, totalErrors: 0, consecutiveErrors: 0,
    totalVerified: 0, totalFailed: 0, totalSeeded: 0, totalCommittedRanges: 0,
    lastResult: null, lastError: null, lastCompletedAt: null,
  };
  async function runtime() {
    runtimePromise ||= Promise.resolve(runtimeFactory(options)).catch((error) => {
      runtimePromise = null; throw error;
    });
    return runtimePromise;
  }
  async function halt(error) {
    running = false; status.running = false; status.halted = true;
    status.lastError = publicError(error);
    if (timer) cancelSchedule(timer);
    timer = null;
    try { await onFatal?.(error); } catch (fatalError) {
      logger.error('[RobinhoodHolderColdWorker] Fatal propagation failed:', fatalError.message);
    }
  }
  async function execute() {
    status.inFlight = true; status.totalRuns += 1;
    try {
      const result = await tick(await runtime(), options);
      status.lastResult = result; status.lastError = null; status.consecutiveErrors = 0;
      status.totalVerified += result.verified; status.totalFailed += result.failed;
      status.totalSeeded += result.seededTokens;
      if (result.replayStatus === 'committed') status.totalCommittedRanges += 1;
      return result;
    } catch (error) {
      status.totalErrors += 1; status.consecutiveErrors += 1; status.lastError = publicError(error);
      if (['configuration_error', 'holder_cold_contract_error'].includes(error.code)) await halt(error);
      else logger.warn('[RobinhoodHolderColdWorker] Tick failed:', error.message);
      return null;
    } finally {
      status.inFlight = false; status.lastCompletedAt = new Date().toISOString();
    }
  }
  async function runOnce() {
    if (activeRun) return activeRun;
    activeRun = execute().finally(() => { activeRun = null; });
    return activeRun;
  }
  function queueNext(delayMs) {
    if (!running || status.halted) return;
    timer = schedule(async () => {
      await runOnce();
      const delay = status.consecutiveErrors
        ? Math.min(options.maxErrorBackoffMs, options.intervalMs * (2 ** Math.min(status.consecutiveErrors, 8)))
        : options.intervalMs;
      queueNext(delay);
    }, delayMs);
    timer?.unref?.();
  }
  function start(input = {}) {
    if (running) return false;
    options = normalizeOptions(input); onFatal = typeof input.onFatal === 'function' ? input.onFatal : null;
    status.enabled = options.enabled;
    if (!options.enabled) return false;
    status.halted = false; running = true; status.running = true; queueNext(0);
    return true;
  }
  async function stop() {
    running = false; status.running = false;
    if (timer) cancelSchedule(timer);
    timer = null;
    if (activeRun) await activeRun.catch(() => {});
  }
  return Object.freeze({ getStatus: () => ({ ...status }), runOnce, start, stop });
}

const worker = createRobinhoodHolderColdWorker();
module.exports = {
  createRobinhoodHolderColdWorker,
  getStatus: worker.getStatus, runOnce: worker.runOnce, start: worker.start, stop: worker.stop,
  __private: { buildRuntime, normalizeOptions, normalizeRequestOptions, resolveRpcProvider },
};
