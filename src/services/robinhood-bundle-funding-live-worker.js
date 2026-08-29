const { randomUUID } = require('crypto');
const db = require('../models/db');
const {
  createRobinhoodBundleFundingLiveQueueRepository,
} = require('../models/robinhood-bundle-funding-live-queue');
const {
  createRobinhoodBundleFundingLiveSource,
} = require('../models/robinhood-bundle-funding-live-source');
const { createEvmJsonRpcClient } = require('./evm-json-rpc-client');
const { createRobinhoodBundleFundingReader } = require('./robinhood-bundle-funding-reader');
const { planBundleFundingScan } = require('./robinhood-bundle-funding-scan-plan');
const { materializeBundleFundingRange } = require('./robinhood-bundle-funding-materializer');
const { createPostgresRealtimeListener } = require('./postgres-realtime-listener');

const NOTIFY_CHANNEL = 'robinhood_bundle_funding_live_queue';
const bounded = (value, fallback, min, max) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? Math.max(min, Math.min(parsed, max)) : fallback;
};
const normalizeOptions = (input = {}) => Object.freeze({
  enabled: input.enabled === true,
  intervalMs: bounded(input.intervalMs, 1000, 100, 60_000),
  leaseMs: bounded(input.leaseMs, 900_000, 120_000, 1_200_000),
  retryMs: bounded(input.retryMs, 15_000, 1000, 3_600_000),
  maxRetryMs: bounded(input.maxRetryMs, 3_600_000, 60_000, 86_400_000),
  batchBlocks: bounded(input.batchBlocks, 50, 1, 100),
  timeoutMs: bounded(input.timeoutMs, 60_000, 1000, 300_000),
});

function buildRuntime(deps, options) {
  const env = deps.env || process.env;
  const url = String(env.RH_NODE_RPC_URL || '').trim();
  if (!url) throw Object.assign(new Error('RH_NODE_RPC_URL Archive is required on the VPS'), {
    code: 'configuration_error',
  });
  const database = deps.database || db;
  const rpcClient = (deps.rpcClientFactory || createEvmJsonRpcClient)({
    providers: [{ name: 'robinhood-vps-archive', url }],
    timeoutMs: options.timeoutMs, maxRetries: 1,
  });
  return Object.freeze({
    queue: (deps.queueFactory || createRobinhoodBundleFundingLiveQueueRepository)({ database }),
    source: (deps.sourceFactory || createRobinhoodBundleFundingLiveSource)({ database }), rpcClient,
  });
}

async function processTask(runtime, task, options, deps = {}) {
  const candidates = await runtime.source.loadCandidates(task);
  const plan = (deps.planner || planBundleFundingScan)({ sourceFromBlock: '0',
    sourceThroughBlock: task.sourceThroughBlock, lookbackBlocks: task.lookbackBlocks, candidates });
  const evidence = new Map();
  if (plan.ranges.length) {
    const reader = (deps.readerFactory || createRobinhoodBundleFundingReader)({
      rpcClient: runtime.rpcClient,
      candidateWallets: plan.candidates.map(({ walletAddress }) => walletAddress),
    });
    await reader.assertChain();
    for (const range of plan.ranges) {
      const rangeCandidates = plan.candidates.filter(({ firstBuyBlock }) => (
        BigInt(firstBuyBlock) >= BigInt(range.fromBlock)
        && BigInt(firstBuyBlock) <= BigInt(range.toBlock)
      ));
      const result = await (deps.materialize || materializeBundleFundingRange)({
        range: { ...range, throughBlock: range.toBlock, candidates: rangeCandidates },
        lookbackBlocks: task.lookbackBlocks, batchBlocks: options.batchBlocks,
      }, { reader });
      for (const item of result.causalEvidence) evidence.set(
        `${item.candidateWallet}:${item.transactionHash}:${item.hop}`, item
      );
    }
  }
  const completed = await runtime.queue.replaceEvidenceAndComplete({
    ...task, evidence: [...evidence.values()],
  });
  return Object.freeze({ status: completed ? 'materialized' : 'stale',
    tokenAddress: task.tokenAddress, candidates: plan.candidateWallets,
    evidence: evidence.size });
}

function createRobinhoodBundleFundingLiveWorker(deps = {}) {
  const schedule = deps.schedule || setTimeout; const cancel = deps.cancelSchedule || clearTimeout;
  const owner = deps.owner || `bundle-funding-${process.pid}-${randomUUID()}`;
  let options = normalizeOptions(); let runtime; let timer; let listener; let active; let running = false;
  const status = { enabled: false, running: false, inFlight: false, totalRuns: 0,
    totalMaterialized: 0, totalDeferred: 0, lastResult: null, lastError: null,
    lastCompletedAt: null };
  const getRuntime = () => (runtime ||= deps.runtime || buildRuntime(deps, options));
  const retryDelay = (attempt) => Math.min(options.maxRetryMs,
    options.retryMs * (2 ** Math.min(Math.max(attempt - 1, 0), 8)));
  async function runOnce() {
    if (active) return active;
    active = (async () => {
      status.inFlight = true; status.totalRuns += 1; let task;
      try {
        task = await getRuntime().queue.claim({ owner, leaseMs: options.leaseMs });
        if (!task) return { status: 'caught-up' };
        const result = await processTask(getRuntime(), { ...task, owner }, options, deps);
        if (result.status === 'materialized') status.totalMaterialized += 1;
        status.lastResult = result; status.lastError = null; return result;
      } catch (error) {
        if (task) await getRuntime().queue.retry({ ...task, owner,
          retryMs: retryDelay(task.attemptCount), error }).catch(() => {});
        status.totalDeferred += 1;
        status.lastError = { code: error.code || 'bundle_funding_live_error', message: error.message };
        return null;
      } finally { status.inFlight = false; status.lastCompletedAt = new Date().toISOString(); }
    })().finally(() => { active = null; });
    return active;
  }
  function queue(delay = options.intervalMs) {
    if (!running) return;
    timer = schedule(async () => { timer = null; await runOnce(); queue(); }, delay); timer?.unref?.();
  }
  function wake() { if (running && !active) { if (timer) cancel(timer); timer = null; queue(0); } }
  function start(input = {}) {
    if (running) return false; options = normalizeOptions(input); status.enabled = options.enabled;
    if (!options.enabled) return false; getRuntime(); running = true; status.running = true;
    listener = (deps.listenerFactory || createPostgresRealtimeListener)({ channel: NOTIFY_CHANNEL,
      label: 'RobinhoodBundleFundingLiveWorker', pool: deps.pool || db.pool, onNotification: wake });
    Promise.resolve(listener.start()).catch((error) => { status.lastError = { message: error.message }; });
    queue(0); return true;
  }
  async function stop() { running = false; status.running = false; if (timer) cancel(timer); timer = null;
    await Promise.resolve(listener?.stop?.()).catch(() => {}); if (active) await active.catch(() => {}); }
  return Object.freeze({ getStatus: () => ({ ...status }), runOnce, start, stop });
}

const worker = createRobinhoodBundleFundingLiveWorker();
module.exports = { createRobinhoodBundleFundingLiveWorker, processTask,
  getStatus: worker.getStatus, start: worker.start, stop: worker.stop,
  __private: { buildRuntime, normalizeOptions } };
