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
  createRobinhoodBlockscoutMetadataClient, DEFAULT_PRO_API_URL, requestWithRetry,
} = require('./robinhood-blockscout-metadata');
const { createRobinhoodHolderDeploymentVerifier } = require('./robinhood-holder-deployment-verifier');
const { createPostgresRealtimeListener } = require('./postgres-realtime-listener');

const NOTIFY_CHANNEL = 'robinhood_token_deployment_outbox';
const ROBINHOOD_CHAIN_ID = 4663n;
const LOCAL_EVIDENCE_GRACE_MS = 15_000;
const LOCAL_EVIDENCE_RETRY_MS = 1000;
const HOT_PROVIDER_RETRY_MS = 5000;
const HOT_TASK_MAX_AGE_MS = 10 * 60_000;

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
  async function verify(input) {
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
    if (hasCode(previousCode) || !hasCode(currentCode)) return null;
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
    return Object.freeze({
      tokenAddress, blockNumber: blockNumber.toString(),
      blockHash: expectedBlockHash, transactionHash,
    });
  }
  return Object.freeze({ verify });
}

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

function createBlockscoutClient(deps, env, options) {
  const apiKey = String(env.ROBINHOOD_BLOCKSCOUT_API_KEY || '').trim();
  const apiUrl = String(env.ROBINHOOD_BLOCKSCOUT_API_URL
    || (apiKey ? DEFAULT_PRO_API_URL : '')).trim();
  const blockscoutOptions = { timeoutMs: options.timeoutMs };
  if (apiKey) blockscoutOptions.apiKey = apiKey;
  if (apiUrl) blockscoutOptions.apiUrl = apiUrl;
  return (deps.blockscoutFactory || createRobinhoodBlockscoutMetadataClient)(blockscoutOptions);
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
  const blockscout = createBlockscoutClient(deps, env, options);
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  return Object.freeze({
    outbox: (deps.outboxFactory || createRobinhoodTokenDeploymentOutboxRepository)({ database }),
    attributions: (deps.attributionFactory || createRobinhoodTokenAttributionRepository)({ database }),
    creatorSource: (deps.creatorSourceFactory || createRobinhoodCanonicalDirectCreatorSource)({
      database,
    }),
    blockscout,
    localResolver: (deps.localResolverFactory || createLocalCodeTransitionResolver)(rpcClient),
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
  const now = deps.now || Date.now;
  let options = normalizeOptions();
  let runtimePromise;
  let timer;
  let listener;
  let running = false;
  let activeRun;
  let blockscoutUnavailableUntil = 0;
  const status = {
    enabled: false, running: false, inFlight: false, totalRuns: 0,
    totalResolved: 0, totalLocalResolved: 0, totalDeferred: 0, totalSkipped: 0,
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
    if (typeof current.outbox.findMintHint !== 'function'
        || typeof current.localResolver?.verify !== 'function') return null;
    const mintHint = await current.outbox.findMintHint(task.tokenAddress);
    if (!mintHint) {
      if (taskAge(task) < LOCAL_EVIDENCE_GRACE_MS) {
        throw Object.assign(new Error('mint evidence has not reached the journal yet'), {
          code: 'local_mint_pending', stage: 'rpc_code_transition',
        });
      }
      return null;
    }
    try { return await current.localResolver.verify(mintHint); }
    catch (error) {
      if (error.code === 'configuration_error') throw error;
      return null;
    }
  }

  async function resolveWithBlockscout(current, task) {
    if (now() < blockscoutUnavailableUntil) {
      throw Object.assign(new Error('Blockscout credits circuit is open'), {
        code: 'blockscout_circuit_open', stage: 'contract_creation_lookup',
      });
    }
    const hint = await current.blockscout.getContractCreation(task.tokenAddress)
      .catch((error) => { error.stage = 'contract_creation_lookup'; throw error; });
    if (!hint?.creatorAddress || !hint?.transactionHash) {
      throw Object.assign(new Error('Blockscout creation evidence is not indexed yet'), {
        code: 'blockscout_creation_pending', stage: 'contract_creation_lookup',
      });
    }
    return current.verifier.verifyDirectDeployment(hint)
      .catch((error) => { error.stage = 'deployment_verification'; throw error; });
  }

  async function resolveTransition(current, transition) {
    if (typeof current.creatorSource?.readRange === 'function') {
      const blocks = await current.creatorSource.readRange(
        transition.blockNumber, transition.blockNumber
      );
      const canonical = blocks.get(transition.blockNumber)?.deployments.find(
        (item) => item.tokenAddress === transition.tokenAddress
      );
      if (canonical) return canonical;
    }
    return current.verifier.verifyTransactionDeployment(transition);
  }

  function retryFor(task, error) {
    if (error.code === 'local_mint_pending') return LOCAL_EVIDENCE_RETRY_MS;
    const providerUnavailable = ['credits_exhausted', 'blockscout_circuit_open']
      .includes(error.code);
    if (!providerUnavailable) return retryDelay(task.attemptCount);
    return taskAge(task) < HOT_TASK_MAX_AGE_MS ? HOT_PROVIDER_RETRY_MS : options.maxRetryMs;
  }

  async function deferTask(task, error) {
    await (await runtime()).outbox.retry({
      owner, tokenAddress: task.tokenAddress, retryMs: retryFor(task, error),
      error: `${error.stage || 'runtime'}:${error.code || 'deployment_resolution_failed'}:${error.message}`,
    }).catch(() => {});
    status.totalDeferred += 1;
  }

  async function execute() {
    status.inFlight = true; status.totalRuns += 1;
    let task;
    try {
      const current = await runtime();
      task = await current.outbox.claim({ owner, leaseMs: options.leaseMs });
      if (!task) return { status: 'caught-up' };
      if (await current.outbox.isExact(task.tokenAddress)) {
        await current.outbox.complete({ owner, tokenAddress: task.tokenAddress });
        status.totalSkipped += 1;
        return { status: 'already-attributed', tokenAddress: task.tokenAddress };
      }
      const transition = await resolveLocally(current, task);
      if (transition) {
        await current.attributions.recordCodeTransitions([transition]);
        const deployment = await resolveTransition(current, transition);
        await current.attributions.recordVerifiedDirectDeployments([deployment]);
        await current.outbox.complete({ owner, tokenAddress: task.tokenAddress });
        status.totalResolved += 1; status.totalLocalResolved += 1;
        return { status: 'resolved', tokenAddress: task.tokenAddress, source: deployment.source };
      }
      const deployment = await resolveWithBlockscout(current, task);
      await current.attributions.recordVerifiedDirectDeployments([deployment]);
      await current.outbox.complete({ owner, tokenAddress: task.tokenAddress });
      status.totalResolved += 1;
      return { status: 'resolved', tokenAddress: task.tokenAddress, source: deployment.source };
    } catch (error) {
      if (error.code === 'credits_exhausted') {
        blockscoutUnavailableUntil = now() + options.maxRetryMs;
      }
      if (task) await deferTask(task, error);
      if (['blockscout_creation_pending', 'blockscout_circuit_open', 'credits_exhausted',
        'local_mint_pending'].includes(error.code)) {
        return { status: 'deferred', reason: error.code, tokenAddress: task?.tokenAddress || null };
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
  __private: { buildRuntime, createLocalCodeTransitionResolver, normalizeOptions },
};
