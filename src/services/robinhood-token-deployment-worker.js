const { randomUUID } = require('crypto');
const db = require('../models/db');
const {
  createRobinhoodTokenDeploymentOutboxRepository,
} = require('../models/robinhood-token-deployment-outbox');
const { createRobinhoodTokenAttributionRepository } = require('../models/robinhood-token-attribution');
const { createEvmJsonRpcClient } = require('./evm-json-rpc-client');
const {
  createRobinhoodBlockscoutMetadataClient, requestWithRetry,
} = require('./robinhood-blockscout-metadata');
const { createRobinhoodHolderDeploymentVerifier } = require('./robinhood-holder-deployment-verifier');
const { createPostgresRealtimeListener } = require('./postgres-realtime-listener');

const NOTIFY_CHANNEL = 'robinhood_token_deployment_outbox';

function bounded(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? Math.max(minimum, Math.min(parsed, maximum)) : fallback;
}

function normalizeOptions(input = {}) {
  return Object.freeze({
    enabled: input.enabled === true,
    intervalMs: bounded(input.intervalMs, 1000, 100, 60_000),
    leaseMs: bounded(input.leaseMs, 300_000, 10_000, 900_000),
    retryMs: bounded(input.retryMs, 15_000, 1000, 3_600_000),
    maxRetryMs: bounded(input.maxRetryMs, 3_600_000, 60_000, 86_400_000),
    timeoutMs: bounded(input.timeoutMs, 30_000, 1000, 60_000),
  });
}

function buildRuntime(deps, options) {
  const env = deps.env || process.env;
  const rpcUrl = String(env.RH_NODE_RPC_URL || env.ROBINHOOD_RPC_URL || '').trim();
  if (!rpcUrl) throw Object.assign(new Error('RH_NODE_RPC_URL or ROBINHOOD_RPC_URL is required'), {
    code: 'configuration_error',
  });
  const database = deps.database || db;
  const rpcClient = (deps.rpcClientFactory || createEvmJsonRpcClient)({
    providers: [{ name: 'robinhood-deployment-live', url: rpcUrl }],
    timeoutMs: options.timeoutMs, maxRetries: 1,
  });
  const blockscout = (deps.blockscoutFactory || createRobinhoodBlockscoutMetadataClient)({
    timeoutMs: options.timeoutMs,
  });
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  return Object.freeze({
    outbox: (deps.outboxFactory || createRobinhoodTokenDeploymentOutboxRepository)({ database }),
    attributions: (deps.attributionFactory || createRobinhoodTokenAttributionRepository)({ database }),
    blockscout,
    verifier: (deps.verifierFactory || createRobinhoodHolderDeploymentVerifier)({
      rpcClient,
      internalCreationLookup: async (hint) => (await requestWithRetry(
        () => blockscout.getInternalContractCreation(hint.transactionHash, hint.tokenAddress),
        { requestRetries: 2, retryDelayMs: 500 }, sleep,
      )).value,
    }),
  });
}

function createRobinhoodTokenDeploymentWorker(deps = {}) {
  const schedule = deps.schedule || setTimeout;
  const cancel = deps.cancelSchedule || clearTimeout;
  const owner = deps.owner || `token-deployment-${process.pid}-${randomUUID()}`;
  let options = normalizeOptions();
  let runtimePromise;
  let timer;
  let listener;
  let running = false;
  let activeRun;
  const status = {
    enabled: false, running: false, inFlight: false, totalRuns: 0,
    totalResolved: 0, totalDeferred: 0, totalSkipped: 0,
    lastResult: null, lastError: null, lastCompletedAt: null,
  };

  const runtime = () => (runtimePromise ||= Promise.resolve(
    deps.runtime || buildRuntime(deps, options)
  ));
  const retryDelay = (attempt) => Math.min(
    options.maxRetryMs, options.retryMs * (2 ** Math.min(Math.max(attempt - 1, 0), 8))
  );

  async function execute() {
    status.inFlight = true; status.totalRuns += 1;
    let task;
    let stage = 'runtime';
    try {
      const current = await runtime();
      task = await current.outbox.claim({ owner, leaseMs: options.leaseMs });
      if (!task) return { status: 'caught-up' };
      if (await current.outbox.isExact(task.tokenAddress)) {
        await current.outbox.complete({ owner, tokenAddress: task.tokenAddress });
        status.totalSkipped += 1;
        return { status: 'already-attributed', tokenAddress: task.tokenAddress };
      }
      stage = 'contract_creation_lookup';
      const hint = await current.blockscout.getContractCreation(task.tokenAddress);
      if (!hint?.creatorAddress || !hint?.transactionHash) {
        throw Object.assign(new Error('Blockscout creation evidence is not indexed yet'), {
          code: 'blockscout_creation_pending',
        });
      }
      stage = 'deployment_verification';
      const deployment = await current.verifier.verifyDirectDeployment(hint);
      await current.attributions.recordVerifiedDirectDeployments([deployment]);
      await current.outbox.complete({ owner, tokenAddress: task.tokenAddress });
      status.totalResolved += 1;
      return { status: 'resolved', tokenAddress: task.tokenAddress, source: deployment.source };
    } catch (error) {
      if (task) {
        await (await runtime()).outbox.retry({
          owner, tokenAddress: task.tokenAddress, retryMs: retryDelay(task.attemptCount),
          error: `${stage}:${error.code || 'deployment_resolution_failed'}:${error.message}`,
        }).catch(() => {});
        status.totalDeferred += 1;
      }
      status.lastError = { code: error.code || 'deployment_resolution_failed', message: error.message };
      return null;
    } finally {
      status.inFlight = false; status.lastCompletedAt = new Date().toISOString();
    }
  }

  async function runOnce() {
    if (activeRun) return activeRun;
    activeRun = execute().then((result) => {
      if (result) { status.lastResult = result; status.lastError = null; }
      return result;
    }).finally(() => { activeRun = null; });
    return activeRun;
  }

  function queue(delay = options.intervalMs) {
    if (!running) return;
    timer = schedule(async () => { timer = null; await runOnce(); queue(); }, delay);
    timer?.unref?.();
  }

  function wake() {
    if (!running || activeRun) return;
    if (timer) cancel(timer);
    timer = null; queue(0);
  }

  function start(input = {}) {
    if (running) return false;
    options = normalizeOptions(input); status.enabled = options.enabled;
    if (!options.enabled) return false;
    running = true; status.running = true;
    listener = (deps.listenerFactory || createPostgresRealtimeListener)({
      channel: NOTIFY_CHANNEL, label: 'RobinhoodTokenDeploymentWorker',
      pool: deps.pool || db.pool, onNotification: wake,
    });
    Promise.resolve(listener.start()).catch((error) => { status.lastError = { message: error.message }; });
    queue(0); return true;
  }

  async function stop() {
    running = false; status.running = false;
    if (timer) cancel(timer);
    timer = null;
    await Promise.resolve(listener?.stop?.()).catch(() => {});
    if (activeRun) await activeRun.catch(() => {});
  }

  return Object.freeze({ getStatus: () => ({ ...status }), runOnce, start, stop });
}

const worker = createRobinhoodTokenDeploymentWorker();
module.exports = {
  NOTIFY_CHANNEL, createRobinhoodTokenDeploymentWorker,
  getStatus: worker.getStatus, runOnce: worker.runOnce, start: worker.start, stop: worker.stop,
  __private: { buildRuntime, normalizeOptions },
};
