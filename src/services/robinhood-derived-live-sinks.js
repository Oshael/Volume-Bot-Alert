const workerLease = require('../models/worker-lease');
const {
  createRobinhoodHeadProcessingRepository,
} = require('../models/robinhood-head-processing');
const robinhoodLiveCatalogWorker = require('./robinhood-live-catalog-worker');
const robinhoodRealtimeAlertWorker = require('./robinhood-realtime-alert-worker');
const robinhoodMarketAggregateWorker = require('./robinhood-market-aggregate-worker');
const {
  activeLease,
  evaluateRobinhoodPipelineHealth,
  freshTimestamp,
} = require('./robinhood-pipeline-health');

const HEALTH_CACHE_MS = 5000;

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
      .then(([rows, processingBacklog]) => evaluateRobinhoodPipelineHealth(rows, {
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
  __private: {
    activeLease,
    evaluateDerivedPipelineHealth: evaluateRobinhoodPipelineHealth,
    freshTimestamp,
  },
};
