const workerLease = require('../models/worker-lease');
const {
  createRobinhoodHeadProcessingRepository,
} = require('../models/robinhood-head-processing');
const robinhoodLiveCatalogWorker = require('./robinhood-live-catalog-worker');
const robinhoodRealtimeAlertWorker = require('./robinhood-realtime-alert-worker');
const robinhoodMarketAggregateWorker = require('./robinhood-market-aggregate-worker');

const HEAD_LEASE_KEY = 'robinhood-head-capture-worker';
const PROCESSING_LEASE_KEY = 'robinhood-processing-worker';
const DEFAULT_HEALTH_MAX_AGE_MS = 90_000;
const HEALTH_CACHE_MS = 5000;

function timestampMs(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function activeLease(lease, nowMs) {
  return Boolean(
    lease
    && lease.metadata?.state !== 'halted'
    && (timestampMs(lease.leaseUntil) ?? 0) > nowMs
  );
}

function freshTimestamp(value, nowMs, maxAgeMs) {
  const parsed = timestampMs(value);
  return parsed != null && parsed <= nowMs + 5000 && nowMs - parsed <= maxAgeMs;
}

function appendHeadBlockers(blockers, lease, nowMs, maxAgeMs) {
  if (!activeLease(lease, nowMs)) {
    blockers.push('head_lease_inactive');
    return;
  }
  const telemetry = lease.metadata?.telemetry;
  if (telemetry?.worker?.running !== true) blockers.push('head_not_running');
  if (!freshTimestamp(telemetry?.capturedAt, nowMs, maxAgeMs)) {
    blockers.push('head_telemetry_stale');
  }
  if (telemetry?.coverage?.caughtUp !== true) blockers.push('head_not_caught_up');
  if (Number(telemetry?.coverage?.unexplainedGaps || 0) !== 0) {
    blockers.push('head_unexplained_gaps');
  }
}

function appendProcessingBlockers(blockers, lease, nowMs, maxAgeMs) {
  if (!activeLease(lease, nowMs)) {
    blockers.push('processing_lease_inactive');
    return;
  }
  const telemetry = lease.metadata?.telemetry;
  if (telemetry?.running !== true) blockers.push('processing_not_running');
  if (!freshTimestamp(telemetry?.lastTickAt, nowMs, maxAgeMs)) {
    blockers.push('processing_tick_stale');
  }
  if (telemetry?.lastError) blockers.push('processing_error');
  if (Number(telemetry?.lastBlocked || 0) > 0) blockers.push('processing_blocked');
}

function appendBacklogBlockers(blockers, backlog, nowMs, maxAgeMs) {
  if (!backlog) return;
  if (!freshTimestamp(backlog.observedAt, nowMs, maxAgeMs)) {
    blockers.push('processing_backlog_stale');
  }
}

function evaluateDerivedPipelineHealth(leases = [], options = {}) {
  const nowMs = Number(options.nowMs ?? Date.now());
  const maxAgeMs = Math.max(
    10_000,
    Math.min(Number(options.maxAgeMs) || DEFAULT_HEALTH_MAX_AGE_MS, 300_000)
  );
  const byKey = new Map(leases.map((lease) => [lease.key, lease]));
  const head = byKey.get(HEAD_LEASE_KEY);
  const processing = byKey.get(PROCESSING_LEASE_KEY);
  const blockers = [];

  appendHeadBlockers(blockers, head, nowMs, maxAgeMs);
  appendProcessingBlockers(blockers, processing, nowMs, maxAgeMs);
  appendBacklogBlockers(blockers, options.processingBacklog, nowMs, maxAgeMs);

  return Object.freeze({
    ready: blockers.length === 0,
    blockers: Object.freeze(blockers),
    ...(options.processingBacklog ? { processingBacklog: options.processingBacklog } : {}),
  });
}

function createRobinhoodDerivedLiveSinks(options = {}) {
  const leases = options.workerLease || workerLease;
  const processing = options.processingRepository || createRobinhoodHeadProcessingRepository();
  const catalog = options.liveCatalogWorker || robinhoodLiveCatalogWorker;
  const alerts = options.realtimeAlertWorker || robinhoodRealtimeAlertWorker;
  const aggregates = options.marketAggregateWorker || robinhoodMarketAggregateWorker;
  const now = options.now || Date.now;
  const enabled = options.enabled === true && options.shadowAuditOnly !== true;
  const realtimeAlertsEnabled = options.realtimeAlertsEnabled === true;
  const realtimeAlertsPublishable = options.realtimeAlertsPublishable === true;
  const alertsRequested = options.alertsRequested === true;
  const healthMaxAgeMs = options.healthMaxAgeMs;
  let running = false;
  let lastHealth = { ready: false, blockers: ['not_checked'] };
  let lastHealthAt = 0;
  let healthQuery = null;

  async function getPipelineHealth() {
    const nowMs = now();
    if (lastHealthAt && nowMs - lastHealthAt < HEALTH_CACHE_MS) return lastHealth;
    if (healthQuery) return healthQuery;
    healthQuery = Promise.all([leases.list(), processing.getOldestActiveCapture('market')])
      .then(([rows, processingBacklog]) => evaluateDerivedPipelineHealth(rows, {
        nowMs, maxAgeMs: healthMaxAgeMs, processingBacklog,
      }))
      .catch(() => ({ ready: false, blockers: ['health_query_failed'] }))
      .then((health) => {
        lastHealth = health;
        lastHealthAt = now();
        return health;
      })
      .finally(() => { healthQuery = null; });
    return healthQuery;
  }

  async function getRealtimeAlertRollout() {
    const health = await getPipelineHealth();
    return {
      alertsRequested,
      publishable: alertsRequested && realtimeAlertsPublishable && health.ready,
    };
  }

  function start() {
    if (running || !enabled) return false;
    if (options.marketAggregateOptions?.enabled !== true) {
      throw new Error('derived live sinks require Robinhood market aggregates');
    }
    catalog.start({ enabled: true });
    aggregates.start(options.marketAggregateOptions);
    alerts.start({
      enabled: realtimeAlertsEnabled,
      signalConfig: options.signalConfig,
      statementTimeoutMs: options.alertStatementTimeoutMs,
      rolloutProvider: getRealtimeAlertRollout,
    });
    running = true;
    return true;
  }

  async function stop() {
    if (!running) return;
    running = false;
    await Promise.all([alerts.stop(), aggregates.stop(), catalog.stop()]);
  }

  function getStatus() {
    return {
      enabled, running, realtimeAlertsEnabled, realtimeAlertsPublishable,
      health: lastHealth,
      catalog: catalog.getStatus(),
      alerts: alerts.getStatus(),
      aggregates: aggregates.getStatus(),
    };
  }

  return Object.freeze({ getPipelineHealth, getRealtimeAlertRollout, getStatus, start, stop });
}

module.exports = {
  createRobinhoodDerivedLiveSinks,
  __private: { activeLease, evaluateDerivedPipelineHealth, freshTimestamp },
};
