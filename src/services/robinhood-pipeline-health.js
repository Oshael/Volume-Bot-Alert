const HEAD_LEASE_KEY = 'robinhood-head-capture-worker';
const CANONICAL_HEAD_LEASE_KEY = 'robinhood-canonical-head-worker';
const CHAIN_CAPTURE_LEASE_KEY = 'robinhood-chain-capture-worker';
const MONOLITH_LEASE_KEY = 'robinhood-ingestion-worker';
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

function appendCanonicalHeadBlockers(blockers, lease, nowMs, maxAgeMs) {
  const metadata = lease?.metadata || {};
  if (metadata.running !== true) blockers.push('head_not_running');
  if (!freshTimestamp(metadata.lastTickAt, nowMs, maxAgeMs)) {
    blockers.push('head_telemetry_stale');
  }
  if (metadata.lastError) blockers.push('head_error');
  const guard = metadata.canonicalRuntime?.rpcGuard;
  if (!guard) blockers.push('canonical_rpc_guard_missing');
  if (Number(guard?.forbiddenAttempts || 0) > 0) blockers.push('forbidden_rpc_attempts');
}

function appendChainCaptureBlockers(blockers, lease, nowMs, maxAgeMs) {
  if (!activeLease(lease, nowMs)) {
    blockers.push('capture_lease_inactive');
    return;
  }
  const metadata = lease.metadata || {};
  if (metadata.running !== true) blockers.push('capture_not_running');
  if (!freshTimestamp(metadata.nodeHeadObservedAt, nowMs, maxAgeMs)) {
    blockers.push('capture_head_stale');
  }
  const lagBlocks = Number(metadata.lagBlocks);
  if (!Number.isFinite(lagBlocks) || lagBlocks < 0) blockers.push('capture_lag_missing');
  else if (lagBlocks > 2) blockers.push('capture_lag_exceeded');
  if (metadata.lastError) blockers.push('capture_error');
}

function selectHeadAuthority(leases = [], nowMs = Date.now()) {
  const byKey = new Map(leases.map((lease) => [lease.key, lease]));
  const canonical = byKey.get(CANONICAL_HEAD_LEASE_KEY) || null;
  if (activeLease(canonical, nowMs) && canonical.metadata?.mode === 'canonical_publish') {
    return { kind: 'canonical', lease: canonical };
  }
  const legacy = byKey.get(HEAD_LEASE_KEY) || null;
  return activeLease(legacy, nowMs) ? { kind: 'legacy', lease: legacy } : null;
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
  const authority = selectHeadAuthority(leases, nowMs);
  if (authority?.kind === 'canonical') {
    if ([HEAD_LEASE_KEY, MONOLITH_LEASE_KEY].some(
      (key) => activeLease(byKey.get(key), nowMs)
    )) blockers.push('head_writer_conflict');
    appendCanonicalHeadBlockers(blockers, authority.lease, nowMs, maxAgeMs);
    appendChainCaptureBlockers(
      blockers, byKey.get(CHAIN_CAPTURE_LEASE_KEY), nowMs, maxAgeMs
    );
  } else {
    appendHeadBlockers(blockers, authority?.lease, nowMs, maxAgeMs);
  }
  appendProcessingBlockers(blockers, byKey.get(PROCESSING_LEASE_KEY), nowMs, maxAgeMs);
  appendBacklogBlockers(blockers, options.processingBacklog, nowMs, maxAgeMs);

  return Object.freeze({
    ready: blockers.length === 0,
    blockers: Object.freeze(blockers),
    ...(options.processingBacklog ? { processingBacklog: options.processingBacklog } : {}),
  });
}

module.exports = {
  CANONICAL_HEAD_LEASE_KEY,
  CHAIN_CAPTURE_LEASE_KEY,
  HEAD_LEASE_KEY,
  MONOLITH_LEASE_KEY,
  PROCESSING_LEASE_KEY,
  activeLease,
  evaluateRobinhoodPipelineHealth,
  freshTimestamp,
  selectHeadAuthority,
};
