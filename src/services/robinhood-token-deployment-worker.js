const { randomUUID } = require('crypto');
const db = require('../models/db');
const {
  createRobinhoodTokenDeploymentOutboxRepository,
} = require('../models/robinhood-token-deployment-outbox');
const { createRobinhoodTokenAttributionRepository } = require('../models/robinhood-token-attribution');
const {
  createRobinhoodCanonicalDirectCreatorSource,
} = require('../models/robinhood-canonical-direct-creator-source');
const { createEvmJsonRpcClient } = require('./evm-json-rpc-client');
const {
  createRobinhoodArchiveDeploymentDiscovery,
} = require('./robinhood-archive-deployment-discovery');
const {
  createRobinhoodHolderDeploymentVerifier,
} = require('./robinhood-holder-deployment-verifier');
const { createPostgresRealtimeListener } = require('./postgres-realtime-listener');

const NOTIFY_CHANNEL = 'robinhood_token_deployment_outbox';
const ROBINHOOD_CHAIN_ID = 4663n;
const LOCAL_EVIDENCE_GRACE_MS = 15_000;
const LOCAL_EVIDENCE_RETRY_MS = 1000;
const PINNED_EVIDENCE_FAST_RETRIES = 8;

function quantity(value, label) {
  const raw = String(value ?? '').trim();
  if (!/^0x[0-9a-f]+$/i.test(raw) && !/^\d+$/.test(raw)) {
    throw Object.assign(new Error(`${label} is invalid`), { code: 'rpc_code_transition_invalid' });
  }
  return BigInt(raw);
}

function fixedHex(value, bytes, label) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`).test(normalized)) {
    throw Object.assign(new Error(`${label} is invalid`), { code: 'rpc_code_transition_invalid' });
  }
  return normalized;
}

function hasCode(value) {
  const code = String(value ?? '').trim().toLowerCase();
  if (!/^0x(?:[0-9a-f]{2})*$/.test(code)) {
    throw Object.assign(new Error('eth_getCode returned invalid bytecode'), {
      code: 'rpc_code_transition_invalid',
    });
  }
  return code !== '0x';
}

function blockTag(value) { return `0x${BigInt(value).toString(16)}`; }

function createLocalCodeTransitionResolver(rpcClient) {
  let chainValidation;
  async function validateChain() {
    chainValidation ||= rpcClient.request('eth_chainId').then((value) => {
      if (quantity(value, 'chainId') !== ROBINHOOD_CHAIN_ID) {
        throw Object.assign(new Error('deployment RPC is not Robinhood Chain'), {
          code: 'configuration_error',
        });
      }
    }).catch((error) => { chainValidation = null; throw error; });
    return chainValidation;
  }
  async function inspect(input) {
    if (!input) return null;
    const blockNumber = quantity(input.blockNumber, 'mint block');
    if (blockNumber === 0n) return null;
    const tokenAddress = fixedHex(input.tokenAddress, 20, 'token address');
    const transactionHash = fixedHex(input.transactionHash, 32, 'mint transaction hash');
    const expectedBlockHash = fixedHex(input.blockHash, 32, 'mint block hash');
    await validateChain();
    const [previousCode, currentCode, block, receipt] = await Promise.all([
      rpcClient.request('eth_getCode', [tokenAddress, blockTag(blockNumber - 1n)]),
      rpcClient.request('eth_getCode', [tokenAddress, blockTag(blockNumber)]),
      rpcClient.request('eth_getBlockByNumber', [blockTag(blockNumber), false]),
      rpcClient.request('eth_getTransactionReceipt', [transactionHash]),
    ]);
    if (quantity(block?.number, 'block.number') !== blockNumber
        || fixedHex(block?.hash, 32, 'block.hash') !== expectedBlockHash
        || fixedHex(receipt?.transactionHash, 32, 'receipt.transactionHash') !== transactionHash
        || quantity(receipt?.blockNumber, 'receipt.blockNumber') !== blockNumber
        || fixedHex(receipt?.blockHash, 32, 'receipt.blockHash') !== expectedBlockHash
        || quantity(receipt?.status, 'receipt.status') !== 1n) {
      throw Object.assign(new Error('mint evidence is not canonical'), {
        code: 'rpc_code_transition_invalid',
      });
    }
    const transition = Object.freeze({
      tokenAddress, blockNumber: blockNumber.toString(),
      blockHash: expectedBlockHash, transactionHash,
    });
    if (hasCode(previousCode)) {
      return Object.freeze({ status: 'preexisting-code', transition });
    }
    if (!hasCode(currentCode)) {
      return Object.freeze({ status: 'missing-current-code', transition });
    }
    return Object.freeze({ status: 'transition', transition });
  }
  async function verify(input) {
    const result = await inspect(input);
    return result?.status === 'transition' ? result.transition : null;
  }
  return Object.freeze({ inspect, verify });
}

function bounded(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? Math.max(minimum, Math.min(parsed, maximum)) : fallback;
}

function normalizeOptions(input = {}) {
  const confirmations = bounded(input.confirmations, 12, 0, 256);
  return Object.freeze({
    enabled: input.enabled === true,
    intervalMs: bounded(input.intervalMs, 1000, 100, 60_000),
    batchSize: bounded(input.batchSize, 64, 1, 256),
    concurrency: bounded(input.concurrency, 16, 1, 32),
    confirmations,
    stateLookbackBlocks: bounded(input.stateLookbackBlocks, 96, confirmations + 2, 1000),
    leaseMs: bounded(input.leaseMs, 300_000, 10_000, 900_000),
    retryMs: bounded(input.retryMs, 15_000, 1000, 3_600_000),
    maxRetryMs: bounded(input.maxRetryMs, 3_600_000, 60_000, 86_400_000),
    timeoutMs: bounded(input.timeoutMs, 30_000, 1000, 60_000),
    traceEnabled: input.traceEnabled === true,
    traceBatchSize: bounded(input.traceBatchSize, 2, 1, 8),
    traceTimeoutMs: bounded(input.traceTimeoutMs, 2000, 500, 5000),
    traceMaxAgeMs: bounded(input.traceMaxAgeMs, 600_000, 60_000, 259_200_000),
    archiveFallbackBatchSize: bounded(input.archiveFallbackBatchSize, 4, 1, 8),
  });
}

function buildArchiveFallback(deps, options, env) {
  const archiveUrl = String(env.ROBINHOOD_ARCHIVE_RPC_URL || '').trim();
  if (!archiveUrl) return { archiveResolver: null, archiveDiscovery: null };
  const archiveClient = (deps.rpcClientFactory || createEvmJsonRpcClient)({
    providers: [{ name: 'robinhood-deployment-archive-fallback', url: archiveUrl }],
    timeoutMs: options.timeoutMs, maxRetries: 1,
  });
  return {
    archiveResolver: (deps.localResolverFactory || createLocalCodeTransitionResolver)(
      archiveClient
    ),
    archiveDiscovery: (deps.archiveDiscoveryFactory || createRobinhoodArchiveDeploymentDiscovery)({
      rpcClient: archiveClient, blockCreationLookup: async () => null,
    }),
  };
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
  const traceClient = options.traceEnabled
    ? (deps.rpcClientFactory || createEvmJsonRpcClient)({
      providers: [{ name: 'robinhood-deployment-live-trace', url: rpcUrl }],
      timeoutMs: options.traceTimeoutMs, maxRetries: 0,
    }) : null;
  return Object.freeze({
    outbox: (deps.outboxFactory || createRobinhoodTokenDeploymentOutboxRepository)({ database }),
    attributions: (deps.attributionFactory || createRobinhoodTokenAttributionRepository)({ database }),
    creatorSource: (deps.creatorSourceFactory || createRobinhoodCanonicalDirectCreatorSource)({
      database,
    }),
    localResolver: (deps.localResolverFactory || createLocalCodeTransitionResolver)(rpcClient),
    liveHead: () => rpcClient.request('eth_blockNumber'),
    ...buildArchiveFallback(deps, options, env),
    traceVerifier: traceClient
      ? (deps.traceVerifierFactory || createRobinhoodHolderDeploymentVerifier)({
        rpcClient: traceClient, internalCreationLookup: async () => null,
      }) : null,
  });
}

async function concurrentMap(values, concurrency, operation) {
  const results = new Array(values.length);
  let next = 0;
  async function consume() {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await operation(values[index]);
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(concurrency, values.length) }, consume
  ));
  return results;
}

function canResolveLocally(current, task) {
  const canLoadMint = task.mintHint || typeof current.outbox.findMintHint === 'function';
  return Boolean(canLoadMint && typeof current.localResolver?.verify === 'function');
}

async function verifyLocalHint(localResolver, mintHint, localHint) {
  try {
    if (mintHint && typeof localResolver.inspect === 'function') {
      const inspected = await localResolver.inspect(mintHint);
      if (inspected?.status === 'preexisting-code') return Object.freeze({ ignoredMint: true });
      return inspected?.status === 'transition' ? inspected.transition : null;
    }
    return await localResolver.verify(localHint);
  } catch (error) {
    if (error.code === 'configuration_error') throw error;
    if (mintHint) {
      error.stage ||= 'rpc_code_transition';
      throw error;
    }
    return null;
  }
}

function createRobinhoodTokenDeploymentWorker(deps = {}) {
  const schedule = deps.schedule || setTimeout;
  const cancel = deps.cancelSchedule || clearTimeout;
  const owner = deps.owner || `token-deployment-${process.pid}-${randomUUID()}`;
  const now = deps.now || Date.now;
  let options = normalizeOptions(deps.options);
  let runtimePromise;
  let timer;
  let listener;
  let running = false;
  let activeRun;
  const status = {
    enabled: false, running: false, inFlight: false, totalRuns: 0,
    totalResolved: 0, totalLocalResolved: 0, totalDeferred: 0, totalSkipped: 0,
    totalArchiveRequired: 0,
    totalTraceAttempts: 0, totalTraceResolved: 0, totalTraceFailed: 0,
    totalTraceBudgetSkipped: 0, lastTraceError: null,
    totalArchiveFallbackAttempts: 0, totalArchiveFallbackResolved: 0,
    totalArchiveFallbackFailed: 0, lastArchiveFallbackError: null,
    firstAttemptHeadSamples: 0, firstAttemptHeadWithinLookback: 0,
    firstAttemptHeadBeyondLookback: 0, firstAttemptHeadNodeBehind: 0,
    firstAttemptHeadErrors: 0, lastFirstAttemptHeadError: null,
    firstAttemptCode32000WithinLookback: 0,
    firstAttemptCode32000BeyondLookback: 0,
    firstAttemptCode32000NodeBehind: 0, firstAttemptCode32000Unmeasured: 0,
    lastFirstAttemptHead: null, lastFirstAttemptCode32000: null,
    lastResult: null, lastError: null, lastCompletedAt: null,
  };

  const runtime = () => (runtimePromise ||= Promise.resolve(
    deps.runtime || buildRuntime(deps, options)
  ));
  const retryDelay = (attempt) => Math.min(
    options.maxRetryMs, options.retryMs * (2 ** Math.min(Math.max(attempt - 1, 0), 8))
  );

  const taskAge = (task) => (task.createdAt
    ? Math.max(0, now() - new Date(task.createdAt).getTime())
    : Number.POSITIVE_INFINITY);

  async function resolveLocally(current, task) {
    if (!canResolveLocally(current, task)) return null;
    const mintHint = task.mintHint || await current.outbox.findMintHint(task.tokenAddress, {
      confirmations: options.confirmations, lookbackBlocks: options.stateLookbackBlocks,
    });
    const discoveryHint = !mintHint && typeof current.outbox.findDiscoveryHint === 'function'
      ? await current.outbox.findDiscoveryHint(task.tokenAddress) : null;
    const localHint = mintHint || discoveryHint;
    if (!localHint) {
      if (taskAge(task) < LOCAL_EVIDENCE_GRACE_MS) {
        throw Object.assign(new Error('deployment evidence has not reached the journal yet'), {
          code: 'local_mint_pending', stage: 'rpc_code_transition',
        });
      }
      return null;
    }
    return verifyLocalHint(current.localResolver, mintHint, localHint);
  }

  async function resolveCanonicalCreator(current, transition) {
    if (typeof current.creatorSource?.readRange === 'function') {
      const blocks = await current.creatorSource.readRange(
        transition.blockNumber, transition.blockNumber
      );
      const canonical = blocks.get(transition.blockNumber)?.deployments.find(
        (item) => item.tokenAddress === transition.tokenAddress
      );
      if (canonical) return canonical;
    }
    return null;
  }

  async function resolveTraceCreator(current, task, transition, traceBudget) {
    if (!options.traceEnabled || taskAge(task) > options.traceMaxAgeMs
        || typeof current.traceVerifier?.verifyBlockTraceDeployment !== 'function') return null;
    if (!traceBudget.take()) {
      status.totalTraceBudgetSkipped += 1;
      return null;
    }
    status.totalTraceAttempts += 1;
    try {
      return await current.traceVerifier.verifyBlockTraceDeployment({
        tokenAddress: transition.tokenAddress, blockNumber: transition.blockNumber,
      });
    } catch (error) {
      status.totalTraceFailed += 1;
      status.lastTraceError = {
        code: error.code || 'deployment_trace_failed', message: error.message,
      };
      return null;
    }
  }

  function recordTraceFailure(error, fallbackCode) {
    status.totalTraceFailed += 1;
    status.lastTraceError = {
      code: error.code || fallbackCode, message: error.message,
    };
  }

  async function materializeCreator(current, task, transition, traceBudget) {
    const canonical = await resolveCanonicalCreator(current, transition);
    if (canonical) {
      await current.attributions.recordVerifiedDirectDeployments([canonical]);
      return canonical;
    }
    const traced = await resolveTraceCreator(current, task, transition, traceBudget);
    if (!traced) return null;
    try {
      await current.attributions.recordVerifiedDirectDeployments([traced]);
      status.totalTraceResolved += 1;
      status.lastTraceError = null;
      return traced;
    } catch (error) {
      recordTraceFailure(error, 'deployment_trace_persist_failed');
      return null;
    }
  }

  function retryFor(task, error) {
    if (error.code === 'local_mint_pending') return LOCAL_EVIDENCE_RETRY_MS;
    if (task.mintHint && task.attemptCount <= PINNED_EVIDENCE_FAST_RETRIES) {
      return LOCAL_EVIDENCE_RETRY_MS;
    }
    return retryDelay(task.attemptCount);
  }

  async function deferTask(task, error) {
    await (await runtime()).outbox.retry({
      owner, tokenAddress: task.tokenAddress, retryMs: retryFor(task, error),
      error: `${error.stage || 'runtime'}:${error.code || 'deployment_resolution_failed'}:${error.message}`,
    }).catch(() => {});
    status.totalDeferred += 1;
  }

  function eligibleForArchiveFallback(current, task, error) {
    return Boolean(task?.mintHint && error.stage === 'rpc_code_transition'
      && error.method === 'eth_getCode' && error.rpcCode === -32000
      && current.archiveResolver);
  }

  async function sampleFirstAttemptHead(current, task) {
    if (task?.attemptCount !== 1 || !task.mintHint
        || typeof current.liveHead !== 'function') return null;
    try {
      const head = quantity(await current.liveHead(), 'live node head');
      const mint = quantity(task.mintHint.blockNumber, 'mint block');
      const distance = head - mint;
      const bucket = distance < 0n ? 'NodeBehind'
        : distance <= BigInt(options.stateLookbackBlocks)
          ? 'WithinLookback' : 'BeyondLookback';
      const sample = Object.freeze({
        sampledAt: new Date(now()).toISOString(), headBlock: head.toString(),
        mintBlock: mint.toString(), distanceBlocks: distance.toString(),
        lookbackBlocks: options.stateLookbackBlocks, bucket,
      });
      status.firstAttemptHeadSamples += 1;
      status[`firstAttemptHead${bucket}`] += 1;
      status.lastFirstAttemptHead = sample;
      return sample;
    } catch (error) {
      status.firstAttemptHeadErrors += 1;
      status.lastFirstAttemptHeadError = {
        code: error.code || 'head_sample_failed', message: error.message,
      };
      return null;
    }
  }

  function recordFirstAttemptCodeError(task, sample, error) {
    if (task?.attemptCount !== 1 || !task.mintHint
        || error.stage !== 'rpc_code_transition'
        || error.method !== 'eth_getCode' || error.rpcCode !== -32000) return;
    const bucket = sample?.bucket || 'Unmeasured';
    status[`firstAttemptCode32000${bucket}`] += 1;
    status.lastFirstAttemptCode32000 = sample || {
      sampledAt: new Date(now()).toISOString(), bucket,
    };
  }

  async function recoverPinnedWithArchive(current, task, error, budget) {
    if (!eligibleForArchiveFallback(current, task, error) || !budget.take()) return null;
    status.totalArchiveFallbackAttempts += 1;
    try {
      const inspected = await current.archiveResolver.inspect(task.mintHint);
      let transition = inspected?.status === 'transition' ? inspected.transition : null;
      if (inspected?.status === 'preexisting-code' && current.archiveDiscovery) {
        transition = await current.archiveDiscovery.discover({
          tokenAddress: task.tokenAddress, upperBlock: task.mintHint.blockNumber,
          exactBlockHint: true, blockEvidenceOnly: true,
        });
      }
      if (!transition) throw new Error('Archive code transition is inconclusive');
      const recorded = await current.attributions.recordCodeTransitions([transition]);
      if (recorded.attributed !== 1 && !await current.outbox.isExact(task.tokenAddress)) {
        throw new Error('Archive code transition was not persisted');
      }
      if (!await current.outbox.complete({ owner, tokenAddress: task.tokenAddress })) {
        throw new Error('deployment task changed during Archive fallback');
      }
      status.totalResolved += 1;
      status.totalArchiveFallbackResolved += 1;
      status.lastArchiveFallbackError = null;
      return { status: 'resolved', tokenAddress: task.tokenAddress, source: 'rpc_code_transition' };
    } catch (archiveError) {
      status.totalArchiveFallbackFailed += 1;
      status.lastArchiveFallbackError = {
        code: archiveError.code || 'archive_fallback_failed', message: archiveError.message,
      };
      return null;
    }
  }

  async function processTask(current, task, traceBudget, archiveBudget) {
    let firstAttemptHead = null;
    try {
      if (await current.outbox.isExact(task.tokenAddress)) {
        await current.outbox.complete({ owner, tokenAddress: task.tokenAddress });
        status.totalSkipped += 1;
        return { status: 'already-attributed', tokenAddress: task.tokenAddress };
      }
      firstAttemptHead = await sampleFirstAttemptHead(current, task);
      const transition = await resolveLocally(current, task);
      if (transition?.ignoredMint) {
        await current.outbox.complete({ owner, tokenAddress: task.tokenAddress });
        status.totalSkipped += 1;
        return { status: 'non-deployment-mint', tokenAddress: task.tokenAddress };
      }
      if (transition) {
        await current.attributions.recordCodeTransitions([transition]);
        const deployment = await materializeCreator(current, task, transition, traceBudget);
        await current.outbox.complete({ owner, tokenAddress: task.tokenAddress });
        status.totalResolved += 1; status.totalLocalResolved += 1;
        return {
          status: 'resolved', tokenAddress: task.tokenAddress,
          source: deployment?.source || 'rpc_code_transition',
        };
      }
      throw Object.assign(new Error(
        'canonical creator evidence has not been materialized for this token'
      ), {
        code: 'local_deployment_evidence_pending', stage: 'canonical_creator_evidence',
      });
    } catch (error) {
      recordFirstAttemptCodeError(task, firstAttemptHead, error);
      const recovered = await recoverPinnedWithArchive(current, task, error, archiveBudget);
      if (recovered) return recovered;
      if (task) await deferTask(task, error);
      if (['local_deployment_evidence_pending', 'local_mint_pending'].includes(error.code)) {
        return { status: 'deferred', reason: error.code, tokenAddress: task?.tokenAddress || null };
      }
      status.lastError = { code: error.code || 'deployment_resolution_failed', message: error.message };
      return { status: 'error', tokenAddress: task?.tokenAddress || null, errors: 1 };
    }
  }

  async function execute() {
    status.inFlight = true; status.totalRuns += 1;
    try {
      const current = await runtime();
      const archiveRequired = typeof current.outbox.archiveExpiredBatch === 'function'
        ? await current.outbox.archiveExpiredBatch({ limit: options.batchSize }) : 0;
      status.totalArchiveRequired += archiveRequired;
      const tasks = typeof current.outbox.claimBatch === 'function'
        ? await current.outbox.claimBatch({
          owner, leaseMs: options.leaseMs, limit: options.batchSize,
        })
        : [await current.outbox.claim({ owner, leaseMs: options.leaseMs })].filter(Boolean);
      if (!tasks.length) {
        return { status: 'caught-up', claimed: 0, archiveRequired, errors: 0 };
      }
      const traceBudget = {
        remaining: options.traceBatchSize,
        take() {
          if (this.remaining <= 0) return false;
          this.remaining -= 1;
          return true;
        },
      };
      const archiveBudget = {
        remaining: options.archiveFallbackBatchSize,
        take() {
          if (this.remaining <= 0) return false;
          this.remaining -= 1;
          return true;
        },
      };
      const results = await concurrentMap(
        tasks, options.concurrency,
        (task) => processTask(current, task, traceBudget, archiveBudget)
      );
      if (results.length === 1) return results[0];
      return {
        status: 'completed', claimed: tasks.length,
        archiveRequired,
        resolved: results.filter((item) => item?.status === 'resolved').length,
        deferred: results.filter((item) => item?.status === 'deferred').length,
        skipped: results.filter((item) => item?.status === 'already-attributed').length,
        ignoredMints: results.filter((item) => item?.status === 'non-deployment-mint').length,
        errors: results.filter((item) => item?.status === 'error').length,
      };
    } finally {
      status.inFlight = false; status.lastCompletedAt = new Date().toISOString();
    }
  }

  async function runOnce() {
    if (activeRun) return activeRun;
    activeRun = execute().then((result) => {
      if (result) {
        status.lastResult = result;
        if (result.status !== 'error' && !result.errors) status.lastError = null;
      }
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
  NOTIFY_CHANNEL, createLocalCodeTransitionResolver, createRobinhoodTokenDeploymentWorker,
  getStatus: worker.getStatus, runOnce: worker.runOnce, start: worker.start, stop: worker.stop,
  __private: {
    buildRuntime, createLocalCodeTransitionResolver, normalizeOptions,
  },
};
