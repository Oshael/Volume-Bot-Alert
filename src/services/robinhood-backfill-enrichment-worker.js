const {
  createRobinhoodBackfillCaptureRepository,
} = require('../models/robinhood-backfill-capture');
const {
  createRobinhoodPersistenceRepository,
} = require('../models/robinhood-persistence');
const {
  executeRobinhoodBackfillEnrichmentPlan,
  planRobinhoodBackfillEnrichment,
} = require('./robinhood-backfill-enrichment-planner');
const { mapWithConcurrency } = require('./evm-log-enrichment');

function boundedInteger(value, label, fallback, minimum, maximum) {
  const resolved = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return resolved;
}

function normalizeOptions(input = {}) {
  const owner = String(input.owner || '').trim();
  if (!owner || owner.length > 128) {
    throw new Error('owner must contain between 1 and 128 characters');
  }
  const leaseMs = boundedInteger(input.leaseMs, 'leaseMs', 60_000, 1000, 86_400_000);
  const renewalIntervalMs = boundedInteger(
    input.renewalIntervalMs,
    'renewalIntervalMs',
    Math.max(100, Math.floor(leaseMs / 2)),
    100,
    leaseMs - 1
  );
  return {
    owner,
    leaseMs,
    renewalIntervalMs,
    limit: boundedInteger(input.limit, 'limit', 100, 1, 1000),
    retryDelayMs: boundedInteger(
      input.retryDelayMs, 'retryDelayMs', 5000, 0, 604_800_000
    ),
    maxAttempts: boundedInteger(input.maxAttempts, 'maxAttempts', 5, 1, 100),
    retentionMs: boundedInteger(
      input.retentionMs, 'retentionMs', 604_800_000, 1, 31_536_000_000
    ),
    planner: {
      batchSize: input.batchSize,
      providerBatchSizes: input.providerBatchSizes,
    },
    execution: {
      useBatch: input.useBatch,
      concurrency: input.rpcConcurrency,
    },
    prepareConcurrency: boundedInteger(
      input.prepareConcurrency, 'prepareConcurrency', 16, 1, 64
    ),
  };
}

function claimIdentity(claim) {
  return `${claim.transactionHash}:${claim.logIndex}`;
}

function requireAdapter(adapter) {
  if (typeof adapter?.prepareClaim !== 'function') {
    throw new TypeError('adapter.prepareClaim is required');
  }
  if (typeof adapter?.buildEntry !== 'function') {
    throw new TypeError('adapter.buildEntry is required');
  }
  return adapter;
}

async function prepareClaims(claims, adapter, concurrency) {
  return mapWithConcurrency(claims, concurrency, async (claim) => {
    const prepared = await adapter.prepareClaim(claim);
    if (!prepared || !Array.isArray(prepared.requests)) {
      throw new TypeError(`Adapter did not prepare requests for ${claimIdentity(claim)}`);
    }
    return {
      claim,
      context: prepared.context,
      item: {
        id: claimIdentity(claim),
        tokenAddress: prepared.tokenAddress,
        blockNumber: claim.blockNumber,
        logIndex: claim.logIndex,
        requests: prepared.requests,
      },
    };
  });
}

async function buildEntries(prepared, execution, adapter, concurrency) {
  const resultsById = new Map(execution.items.map((item) => [item.id, item.results]));
  return mapWithConcurrency(prepared, concurrency, async ({ claim, context, item }) => {
    if (!resultsById.has(item.id)) {
      throw new Error(`Planner omitted enrichment result for ${item.id}`);
    }
    return adapter.buildEntry({
      claim,
      context,
      results: resultsById.get(item.id),
    });
  });
}

function createClaimHeartbeat(input) {
  let tail = Promise.resolve();
  let failure = null;
  const tick = () => {
    tail = tail.then(async () => {
      if (failure) return;
      const renewed = await input.repository.renewEnrichmentClaims({
        owner: input.owner,
        claims: input.claims,
        leaseMs: input.leaseMs,
      });
      if (renewed.length !== input.claims.length) {
        const error = new Error('Backfill enrichment claim lease was lost during RPC work');
        error.code = 'backfill_claim_lost';
        throw error;
      }
    }).catch((error) => {
      failure = error;
    });
  };
  const handle = input.schedule(tick, input.intervalMs);
  return {
    stop: async () => {
      input.cancel(handle);
      await tail;
      if (failure) throw failure;
    },
  };
}

function createRobinhoodBackfillEnrichmentWorker(deps = {}) {
  const adapter = requireAdapter(deps.adapter);
  const rpcClient = deps.rpcClient;
  if (typeof rpcClient?.request !== 'function') throw new TypeError('rpcClient.request is required');
  const captureRepository = deps.captureRepository
    || createRobinhoodBackfillCaptureRepository();
  const persistenceRepository = deps.persistenceRepository
    || createRobinhoodPersistenceRepository();
  const scheduleHeartbeat = deps.scheduleHeartbeat || setInterval;
  const cancelHeartbeat = deps.cancelHeartbeat || clearInterval;
  const createPlan = deps.createPlan || planRobinhoodBackfillEnrichment;
  const executePlan = deps.executePlan || executeRobinhoodBackfillEnrichmentPlan;
  let inFlight = false;
  const totals = {
    runs: 0, idle: 0, claimed: 0, completed: 0, rejected: 0,
    retries: 0, blocked: 0, errors: 0,
  };
  let lastResult = null;
  let lastError = null;

  async function recordFailure(options, claims, error) {
    if (error?.code === 'backfill_claim_lost') return [];
    const failed = await captureRepository.failEnrichmentClaims({
      owner: options.owner,
      claims,
      retryDelayMs: options.retryDelayMs,
      maxAttempts: options.maxAttempts,
      error: String(error?.message || error).slice(0, 4000),
    });
    totals.retries += failed.filter((claim) => claim.status === 'pending').length;
    totals.blocked += failed.filter((claim) => claim.status === 'blocked').length;
    return failed;
  }

  async function runOnce(input = {}) {
    if (inFlight) return { status: 'busy' };
    const options = normalizeOptions(input);
    inFlight = true;
    totals.runs += 1;
    let claims = [];
    let heartbeat = null;
    try {
      claims = await captureRepository.claimEnrichmentBatch({
        owner: options.owner,
        limit: options.limit,
        leaseMs: options.leaseMs,
      });
      totals.claimed += claims.length;
      if (!claims.length) {
        totals.idle += 1;
        lastResult = { status: 'idle', claimed: 0 };
        lastError = null;
        return lastResult;
      }
      heartbeat = createClaimHeartbeat({
        repository: captureRepository,
        owner: options.owner,
        claims,
        leaseMs: options.leaseMs,
        intervalMs: options.renewalIntervalMs,
        schedule: scheduleHeartbeat,
        cancel: cancelHeartbeat,
      });
      const prepared = await prepareClaims(claims, adapter, options.prepareConcurrency);
      const plan = createPlan(prepared.map(({ item }) => item), options.planner);
      const execution = await executePlan(plan, rpcClient, options.execution);
      const entries = await buildEntries(prepared, execution, adapter, options.prepareConcurrency);
      await heartbeat.stop();
      heartbeat = null;
      const committed = await persistenceRepository.commitBackfillEnrichmentBatch({
        owner: options.owner,
        claims,
        entries,
        retentionMs: options.retentionMs,
      });
      totals.completed += entries.filter((entry) => entry?.observation?.accepted === true).length;
      totals.rejected += entries.filter((entry) => entry?.observation?.accepted === false).length;
      lastResult = {
        status: 'completed',
        claimed: claims.length,
        rpc: execution.metrics,
        ...committed,
      };
      lastError = null;
      return lastResult;
    } catch (caught) {
      let error = caught;
      if (heartbeat) {
        try {
          await heartbeat.stop();
        } catch (heartbeatError) {
          error = heartbeatError;
        }
      }
      totals.errors += 1;
      lastError = String(error?.message || error);
      await recordFailure(options, claims, error);
      throw error;
    } finally {
      inFlight = false;
    }
  }

  function getStatus() {
    return {
      inFlight,
      totals: { ...totals },
      lastResult,
      lastError,
    };
  }

  return Object.freeze({ getStatus, runOnce });
}

module.exports = {
  createRobinhoodBackfillEnrichmentWorker,
  __private: { normalizeOptions },
};
