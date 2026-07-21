const workerLease = require('../models/worker-lease');
const robinhoodIngestionWorker = require('./robinhood-ingestion-worker');
const { buildRobinhoodRolloutStatus } = require('./robinhood-rollout-status');
const { isRobinhoodUserVisible } = require('../utils/token-chain-availability');
const config = require('../../config');

const ROBINHOOD_INGESTION_LEASE_KEY = 'robinhood-ingestion-worker';
const READINESS_CACHE_TTL_MS = 5000;

function buildSolanaReadiness(runtimeConfig, checkedAt) {
  return {
    chain: 'solana',
    status: 'ready',
    phase: 'ready',
    publicationReady: true,
    workspaceReady: true,
    checkedAt,
    blockers: [],
    message: 'Solana workspace data is ready.',
    capabilities: {
      alertFeed: true,
      radar: true,
      monitored: true,
      topPerformers: true,
      manualTokens: true,
      starred: true,
      blocklist: true,
      history: true,
      customAlerts: true,
      charts: true,
      explorerLinks: true,
      tradeLinks: true,
      mockTrading: runtimeConfig.mockTrading?.enabled !== false,
      solanaNative: true,
    },
  };
}

function resolveRobinhoodStatus(rollout) {
  if (rollout.health?.halted) return 'unavailable';
  if (
    rollout.axes?.transport?.requested
    && (!rollout.axes.transport.effective || !rollout.health?.coverageReady)
  ) {
    return 'syncing';
  }
  return rollout.publishable ? 'ready' : 'unavailable';
}

function isRobinhoodMarketWorkspaceReady(rollout) {
  return rollout.health?.halted !== true
    && rollout.axes?.transport?.effective === true
    && rollout.axes?.persistence?.effective === true
    && rollout.health?.coverageReady === true;
}

function getRobinhoodMessage(status, marketWorkspaceReady) {
  if (status === 'syncing') {
    return 'Robinhood is syncing market coverage. Solana data is hidden.';
  }
  if (marketWorkspaceReady) {
    return 'Robinhood market panels and native chart history are ready.';
  }
  if (status === 'ready') {
    return 'Robinhood alert data is ready; generic workspace data is still being prepared.';
  }
  return 'Robinhood workspace data is unavailable. Solana data is hidden.';
}

function buildRobinhoodReadiness(rollout, checkedAt, extraBlockers = []) {
  const status = resolveRobinhoodStatus(rollout);
  const marketWorkspaceReady = isRobinhoodMarketWorkspaceReady(rollout);
  return {
    chain: 'robinhood',
    status,
    phase: rollout.phase,
    publicationReady: rollout.publishable === true,
    workspaceReady: false,
    checkedAt,
    blockers: [...new Set([...(rollout.blockers || []), ...extraBlockers])],
    message: getRobinhoodMessage(status, marketWorkspaceReady),
    capabilities: {
      alertFeed: rollout.publishable === true,
      radar: false,
      monitored: marketWorkspaceReady,
      topPerformers: marketWorkspaceReady,
      manualTokens: true,
      starred: true,
      blocklist: true,
      history: marketWorkspaceReady,
      customAlerts: false,
      charts: marketWorkspaceReady,
      explorerLinks: true,
      tradeLinks: false,
      mockTrading: false,
      solanaNative: false,
    },
  };
}

function buildWorkspaceChainReadiness(input = {}) {
  const runtimeConfig = input.config || {};
  const checkedAt = new Date(input.nowMs ?? Date.now()).toISOString();
  const readiness = {
    solana: buildSolanaReadiness(runtimeConfig, checkedAt),
  };
  if (!isRobinhoodUserVisible(runtimeConfig)) {
    return readiness;
  }

  const rollout = buildRobinhoodRolloutStatus({
    config: runtimeConfig,
    ingestionStatus: input.ingestionStatus,
    sharedLease: input.sharedLease,
    nowMs: input.nowMs,
  });
  readiness.robinhood = buildRobinhoodReadiness(
    rollout,
    checkedAt,
    input.telemetryAvailable === false ? ['readiness_telemetry_unavailable'] : [],
  );
  return readiness;
}

function createWorkspaceChainReadinessProvider(deps = {}) {
  const runtimeConfig = deps.config || config;
  const leaseStore = deps.leaseStore || workerLease;
  const ingestionWorker = deps.ingestionWorker || robinhoodIngestionWorker;
  const now = deps.now || Date.now;
  let cachedAt = 0;
  let cachedValue = null;
  let inFlight = null;

  async function load() {
    if (!isRobinhoodUserVisible(runtimeConfig)) {
      return buildWorkspaceChainReadiness({ config: runtimeConfig, nowMs: now() });
    }
    let sharedLease = null;
    let telemetryAvailable = true;
    try {
      const leases = await leaseStore.list();
      sharedLease = leases.find((lease) => lease.key === ROBINHOOD_INGESTION_LEASE_KEY) || null;
    } catch (_) {
      telemetryAvailable = false;
    }
    return buildWorkspaceChainReadiness({
      config: runtimeConfig,
      ingestionStatus: ingestionWorker.getStatus(),
      sharedLease,
      telemetryAvailable,
      nowMs: now(),
    });
  }

  return async function getWorkspaceChainReadiness() {
    const currentTime = now();
    if (cachedValue && currentTime - cachedAt < READINESS_CACHE_TTL_MS) {
      return cachedValue;
    }
    inFlight ||= load().then((value) => {
      cachedValue = value;
      cachedAt = now();
      return value;
    }).finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}

module.exports = {
  READINESS_CACHE_TTL_MS,
  buildWorkspaceChainReadiness,
  createWorkspaceChainReadinessProvider,
  getWorkspaceChainReadiness: createWorkspaceChainReadinessProvider(),
};
