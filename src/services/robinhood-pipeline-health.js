const HEAD_LEASE_KEY = 'robinhood-head-capture-worker';
const PROCESSING_LEASE_KEY = 'robinhood-processing-worker';
const DEFAULT_HEALTH_MAX_AGE_MS = 90_000;

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

function evaluateRobinhoodPipelineHealth(leases = [], options = {}) {
  const nowMs = Number(options.nowMs ?? Date.now());
  const maxAgeMs = Math.max(
    10_000,
    Math.min(Number(options.maxAgeMs) || DEFAULT_HEALTH_MAX_AGE_MS, 300_000)
  );
  const byKey = new Map(leases.map((lease) => [lease.key, lease]));
  const blockers = [];

  appendHeadBlockers(blockers, byKey.get(HEAD_LEASE_KEY), nowMs, maxAgeMs);
  appendProcessingBlockers(blockers, byKey.get(PROCESSING_LEASE_KEY), nowMs, maxAgeMs);
  appendBacklogBlockers(blockers, options.processingBacklog, nowMs, maxAgeMs);

  return Object.freeze({
    ready: blockers.length === 0,
    blockers: Object.freeze(blockers),
    ...(options.processingBacklog ? { processingBacklog: options.processingBacklog } : {}),
  });
}

module.exports = {
  HEAD_LEASE_KEY,
  PROCESSING_LEASE_KEY,
  activeLease,
  evaluateRobinhoodPipelineHealth,
  freshTimestamp,
};
