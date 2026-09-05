const workerLease = require('../models/worker-lease');
const robinhoodIngestionWorker = require('./robinhood-ingestion-worker');
const { buildRobinhoodRolloutStatus } = require('./robinhood-rollout-status');
const {
  activeLease,
  evaluateRobinhoodPipelineHealth,
  selectHeadAuthority,
} = require('./robinhood-pipeline-health');
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

function resolveRobinhoodStatus(rollout, pipelineHealth) {
  if (rollout.health?.halted) return 'unavailable';
  if (
    rollout.axes?.transport?.requested
    && (
      !rollout.axes.transport.effective
      || !rollout.health?.coverageReady
      || pipelineHealth?.ready === false
    )
  ) {
    return 'syncing';
  }
  return rollout.publishable && pipelineHealth?.ready !== false ? 'ready' : 'unavailable';
}

function isRobinhoodMarketWorkspaceReady(rollout, pipelineHealth) {
  return rollout.health?.halted !== true
    && rollout.axes?.transport?.effective === true
    && rollout.axes?.persistence?.effective === true
    && rollout.health?.coverageReady === true
    && pipelineHealth?.ready !== false;
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

function buildRobinhoodReadiness(rollout, checkedAt, extraBlockers = [], pipelineHealth = null) {
  const status = resolveRobinhoodStatus(rollout, pipelineHealth);
  const marketWorkspaceReady = isRobinhoodMarketWorkspaceReady(rollout, pipelineHealth);
  const publicationReady = rollout.publishable === true && pipelineHealth?.ready !== false;
  return {
    chain: 'robinhood',
    status,
    phase: rollout.phase,
    publicationReady,
    workspaceReady: false,
    checkedAt,
    blockers: [...new Set([
      ...(rollout.blockers || []),
      ...(pipelineHealth?.blockers || []),
      ...extraBlockers,
    ])],
    message: getRobinhoodMessage(status, marketWorkspaceReady),
    capabilities: {
      alertFeed: publicationReady,
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
    input.pipelineHealth,
  );
  return readiness;
}

function selectRobinhoodRuntime(leases, nowMs) {
  const monolithLease = leases.find(
    (lease) => lease.key === ROBINHOOD_INGESTION_LEASE_KEY
  ) || null;
  const authority = selectHeadAuthority(leases, nowMs);
  if (authority) {
    const pipelineHealth = evaluateRobinhoodPipelineHealth(leases, { nowMs });
    if (authority.kind === 'legacy'
      && !pipelineHealth.ready && activeLease(monolithLease, nowMs)) {
      return { sharedLease: monolithLease, pipelineHealth: null };
    }
    const sharedLease = authority.kind === 'canonical'
      ? canonicalRolloutLease(authority.lease, pipelineHealth) : authority.lease;
    return {
      sharedLease,
      pipelineHealth,
    };
  }
  return {
    sharedLease: monolithLease,
    pipelineHealth: null,
  };
}

function canonicalRolloutLease(lease, pipelineHealth) {
  const metadata = lease.metadata || {};
  return {
    ...lease,
    metadata: {
      ...metadata,
      telemetry: {
        version: 1,
        capturedAt: metadata.lastTickAt || lease.heartbeatAt || null,
        worker: {
          running: metadata.running === true,
          inFlight: metadata.inFlight === true,
          halted: metadata.halted === true,
          lastError: metadata.lastError || null,
        },
        coverage: {
          caughtUp: pipelineHealth.ready === true,
          unexplainedGaps: pipelineHealth.ready === true ? 0 : 1,
        },
      },
    },
  };
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
    let runtime = { sharedLease: null, pipelineHealth: null };
    let telemetryAvailable = true;
    const nowMs = now();
    try {
      const leases = await leaseStore.list();
      runtime = selectRobinhoodRuntime(leases, nowMs);
    } catch (_) {
      telemetryAvailable = false;
    }
    return buildWorkspaceChainReadiness({
      config: runtimeConfig,
      ingestionStatus: ingestionWorker.getStatus(),
      sharedLease: runtime.sharedLease,
      pipelineHealth: runtime.pipelineHealth,
      telemetryAvailable,
      nowMs,
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
  __private: { selectRobinhoodRuntime },
};
