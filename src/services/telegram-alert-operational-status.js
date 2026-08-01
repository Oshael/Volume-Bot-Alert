const config = require('../../config');
const {
  createTelegramAlertTelemetryRepository,
} = require('../models/telegram-alert-telemetry');
const telegramAlertRuntime = require('./telegram-alert-runtime');

function count(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function timestamp(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function compactDelivery(value = {}) {
  return Object.freeze({
    claimed: count(value.claimed),
    sent: count(value.sent),
    retry: count(value.retry),
    failed: count(value.failed),
    cancelled: count(value.cancelled),
    stale: count(value.stale),
    errors: count(value.errors),
  });
}

function compactReactivation(value = {}) {
  return Object.freeze({
    scanned: count(value.scanned),
    denied: count(value.denied),
    reactivated: count(value.reactivated),
    deferred: count(value.deferred),
    errors: count(value.errors),
  });
}

function compactRuntime(value = {}) {
  const summary = value.lastSummary;
  return Object.freeze({
    enabled: value.enabled === true,
    running: value.running === true,
    inFlight: value.inFlight === true,
    totalRuns: count(value.totalRuns),
    totalErrors: count(value.totalErrors),
    consecutiveErrors: count(value.consecutiveErrors),
    sparklineFallbacks: count(value.sparklineFallbacks),
    lastSparklineFallbackAt: timestamp(value.lastSparklineFallbackAt),
    lastRunAt: timestamp(value.lastRunAt),
    lastCompletedAt: timestamp(value.lastCompletedAt),
    lastError: value.lastError ? String(value.lastError).slice(0, 240) : null,
    lastSummary: summary ? Object.freeze({
      errors: count(summary.errors),
      delivery: compactDelivery(summary.delivery),
      reactivation: compactReactivation(summary.reactivation),
    }) : null,
  });
}

function compactLease(value) {
  if (!value) return null;
  return Object.freeze({
    key: value.key || null,
    ownerHostname: value.ownerHostname || null,
    ownerPid: Number(value.ownerPid) || null,
    acquiredAt: timestamp(value.acquiredAt),
    heartbeatAt: timestamp(value.heartbeatAt),
    leaseUntil: timestamp(value.leaseUntil),
    halted: value.metadata?.state === 'halted',
  });
}

function runtimeFromLease(lease, localRuntime) {
  const shared = lease?.metadata?.telemetry;
  return shared && typeof shared === 'object' && !Array.isArray(shared)
    ? shared
    : localRuntime;
}

function healthState(enabled, runtime, lease, metricsAvailable, nowMs) {
  if (!enabled) return 'disabled';
  const leaseFresh = lease?.leaseUntil
    && new Date(lease.leaseUntil).getTime() > nowMs;
  return metricsAvailable && runtime.running && (!lease || leaseFresh) ? 'ok' : 'degraded';
}

function buildTelegramAlertHealthSummary(status = {}) {
  const runtime = status.runtime || {};
  const metrics = status.metrics || {};
  return Object.freeze({
    status: status.health || 'degraded',
    configured: status.configured || Object.freeze({}),
    runtime: Object.freeze({
      running: runtime.running === true,
      consecutiveErrors: count(runtime.consecutiveErrors),
      sparklineFallbacks: count(runtime.sparklineFallbacks),
      lastRunAt: timestamp(runtime.lastRunAt),
      lastCompletedAt: timestamp(runtime.lastCompletedAt),
    }),
    metricsAvailable: status.metricsAvailable === true,
    queue: Object.freeze({
      byStatus: metrics.deliveriesByStatus || Object.freeze({}),
      oldestReadyAgeSeconds: metrics.oldestReadyAgeSeconds ?? null,
    }),
    delivery: Object.freeze({
      latencyMs: metrics.deliveryLatencyMs || null,
      errorsByCode24h: metrics.errorsByCode24h || Object.freeze({}),
      rateLimited24h: count(metrics.rateLimited24h),
    }),
    lastUpdateAt: timestamp(metrics.lastUpdateAt),
  });
}

function createTelegramAlertOperationalStatus(options = {}) {
  const settings = options.settings || config.telegram || {};
  const metrics = options.metricsRepository || createTelegramAlertTelemetryRepository(options);
  const runtime = options.runtime || telegramAlertRuntime;
  const now = options.now || Date.now;
  if (typeof metrics?.load !== 'function' || typeof runtime?.getStatus !== 'function'
    || typeof now !== 'function') {
    throw new TypeError('Telegram operational status ports are required');
  }

  async function load(input = {}) {
    const sharedLease = input.sharedLease || null;
    const runtimeStatus = compactRuntime(runtimeFromLease(
      sharedLease,
      runtime.getStatus(),
    ));
    const enabled = settings.enabled === true;
    const capturedMs = Number(now());
    let metricSnapshot = null;
    let metricsAvailable = true;
    try {
      metricSnapshot = await metrics.load();
    } catch {
      metricsAvailable = false;
    }
    return Object.freeze({
      version: 1,
      capturedAt: new Date(capturedMs).toISOString(),
      health: healthState(enabled, runtimeStatus, sharedLease, metricsAvailable, capturedMs),
      configured: Object.freeze({
        enabled,
        bot: Boolean(settings.botToken),
        webhook: Boolean(settings.webhookSecret && settings.webhookPublicUrl),
        appUrl: Boolean(settings.appBaseUrl),
      }),
      runtime: runtimeStatus,
      lease: compactLease(sharedLease),
      metricsAvailable,
      metrics: metricSnapshot,
    });
  }

  return Object.freeze({ load });
}

module.exports = {
  buildTelegramAlertHealthSummary,
  createTelegramAlertOperationalStatus,
};
