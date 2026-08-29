'use strict';

const SKIPPED_BRANCHES = new Set([
  'coverage', 'cursor', 'lastResult', 'lastSnapshot', 'lastSummary', 'metrics',
  'providers', 'rpc', 'settings', 'totals',
]);
const STATUS_FIELDS = new Set([
  'connected', 'consecutiveErrors', 'enabled', 'halted', 'healthy', 'inFlight',
  'lastCompletedAt', 'lastError', 'lastFrameAt', 'lastRunAt', 'lastTickAt',
  'listening', 'running',
]);
const FRESHNESS_FIELDS = [
  'lastCompletedAt', 'lastTickAt', 'lastFrameAt', 'lastRunAt',
  'lastArchiveRunAt', 'lastBlockedArtifactRunAt', 'lastQuarantineRunAt',
];

function validTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function issue(definition, code, severity, path, observedValue, threshold = null) {
  return Object.freeze({
    id: `${definition.key}:${path}:${code}`,
    componentKey: definition.key,
    componentLabel: definition.label,
    group: definition.group,
    allowedGroups: definition.groups,
    code,
    severity,
    path,
    observedValue,
    threshold,
  });
}

function statusNodes(value, path = 'telemetry', depth = 0, output = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 3) return output;
  if (Object.keys(value).some((key) => STATUS_FIELDS.has(key))) output.push({ path, value });
  for (const [key, child] of Object.entries(value)) {
    if (SKIPPED_BRANCHES.has(key)) continue;
    statusNodes(child, `${path}.${key}`, depth + 1, output);
  }
  return output;
}

function leaseTelemetry(lease) {
  const metadata = lease?.metadata;
  if (!metadata || typeof metadata !== 'object') return null;
  if (metadata.telemetry && typeof metadata.telemetry === 'object') return metadata.telemetry;
  return Object.keys(metadata).some((key) => STATUS_FIELDS.has(key)) ? metadata : null;
}

function addLifecycleIssues(issues, definition, node, required) {
  const { path, value } = node;
  if (required && value.enabled === false) {
    issues.push(issue(definition, 'component_disabled', 'critical', path, false, true));
  }
  if (value.halted === true) {
    issues.push(issue(definition, 'component_halted', 'critical', path, true, false));
  }
  if (required && value.running === false && value.enabled !== false) {
    issues.push(issue(definition, 'component_stopped', 'critical', path, false, true));
  }
  if (value.healthy === false) {
    issues.push(issue(definition, 'component_unhealthy', 'high', path, false, true));
  }
  if (value.running === true && (value.connected === false || value.listening === false)) {
    issues.push(issue(definition, 'component_disconnected', 'high', path, false, true));
  }
}

function addErrorIssues(issues, definition, node, thresholds) {
  const errors = Number(node.value.consecutiveErrors);
  if (Number.isFinite(errors) && errors >= thresholds.maxConsecutiveErrors) {
    issues.push(issue(
      definition, 'consecutive_errors', 'high', node.path, errors,
      thresholds.maxConsecutiveErrors,
    ));
  }
  if (node.value.lastError && (!Number.isFinite(errors) || errors > 0)) {
    issues.push(issue(definition, 'active_error', 'warning', node.path, node.value.lastError));
  }
}

function freshestTimestamp(value) {
  return FRESHNESS_FIELDS
    .map((key) => validTime(value[key]))
    .filter((timestamp) => timestamp != null)
    .sort((left, right) => right - left)[0] ?? null;
}

function addTimingIssues(issues, definition, node, thresholds, nowMs, leaseAcquiredAt) {
  const freshest = freshestTimestamp(node.value);
  if (node.value.inFlight === true) {
    const startedAt = validTime(node.value.lastRunAt) ?? freshest;
    if (startedAt != null && nowMs - startedAt > thresholds.maxInFlightMs) {
      issues.push(issue(
        definition, 'execution_stalled', 'high', node.path,
        nowMs - startedAt, thresholds.maxInFlightMs,
      ));
    }
  } else if (node.value.running === true && freshest != null
    && nowMs - freshest > thresholds.freshnessMs) {
    issues.push(issue(
      definition, 'progress_stale', 'high', node.path,
      nowMs - freshest, thresholds.freshnessMs,
    ));
  } else if ((node.path === 'telemetry' || node.path === 'telemetry.worker')
    && (FRESHNESS_FIELDS.some((field) => Object.hasOwn(node.value, field))
      || Object.hasOwn(node.value, 'inFlight'))
    && node.value.running === true && freshest == null && leaseAcquiredAt != null
    && nowMs - leaseAcquiredAt > thresholds.startupGraceMs) {
    issues.push(issue(
      definition, 'startup_stalled', 'high', node.path,
      nowMs - leaseAcquiredAt, thresholds.startupGraceMs,
    ));
  }
}

function addPressureIssues(issues, definition, node, thresholds) {
  const fields = [
    ['lagBlocks', 'lag_blocks_high', thresholds.maxLagBlocks],
    ['lagMs', 'lag_time_high', thresholds.maxLagMs],
    ['lastLoopOverrunMs', 'loop_overrun', thresholds.maxLoopOverrunMs],
  ];
  for (const [field, code, limit] of fields) {
    const observed = Number(node.value[field]);
    if (Number.isFinite(observed) && observed > limit) {
      issues.push(issue(definition, code, code === 'loop_overrun' ? 'warning' : 'high',
        `${node.path}.${field}`, observed, limit));
    }
  }
  for (const field of ['backlog', 'pending', 'queued']) {
    const observed = Number(node.value[field]);
    if (Number.isFinite(observed) && observed > thresholds.maxQueue) {
      issues.push(issue(definition, 'queue_backlog', 'warning', `${node.path}.${field}`,
        observed, thresholds.maxQueue));
    }
  }
}

function addRuntimeIssues(issues, definition, runtime, thresholds = {}) {
  if (!runtime || typeof runtime !== 'object') return;
  const fields = [
    ['rssBytes', 'process_memory_high', thresholds.maxRssBytes, 'high'],
    ['heapUsedPercent', 'process_heap_high', thresholds.maxHeapPercent, 'high'],
    ['eventLoopP99Ms', 'event_loop_lag_high', thresholds.maxEventLoopP99Ms, 'high'],
  ];
  for (const [field, code, limit, severity] of fields) {
    const observed = Number(runtime[field]);
    if (Number.isFinite(observed) && Number.isFinite(limit) && observed > limit) {
      issues.push(issue(definition, code, severity, `runtime.${field}`, observed, limit));
    }
  }
  const freePercent = Number(runtime.disk?.freePercent);
  const freeBytes = Number(runtime.disk?.freeBytes);
  if ((Number.isFinite(freePercent) && freePercent < thresholds.minDiskFreePercent)
    || (Number.isFinite(freeBytes) && freeBytes < thresholds.minDiskFreeBytes)) {
    issues.push(issue(definition, 'disk_space_low', 'critical', 'runtime.disk',
      { freePercent, freeBytes }, {
        minFreePercent: thresholds.minDiskFreePercent,
        minFreeBytes: thresholds.minDiskFreeBytes,
      }));
  }
}

function evaluateRuntimeIssues(definition, lease, options) {
  const issues = [];
  if (options.evaluateRuntime === true) {
    addRuntimeIssues(issues, definition, lease.metadata?.runtime, options.runtimeThresholds);
  }
  return issues;
}

function attachRuntimeGroup(issues, lease) {
  const runtimeGroup = String(lease?.metadata?.group || '').trim();
  if (!runtimeGroup) return issues;
  return issues.map((item) => Object.freeze({ ...item, runtimeGroup }));
}

function evaluateWorkerHealth(definition, lease, options = {}) {
  if (!definition?.key || !definition.thresholds) {
    throw new TypeError('Worker health definition is required');
  }
  const nowMs = Number(options.nowMs ?? Date.now());
  const expected = options.expected === true;
  if (!lease) {
    return expected
      ? [issue(definition, 'lease_missing', 'critical', 'lease', null, 'active lease')]
      : [];
  }
  const issues = evaluateRuntimeIssues(definition, lease, options);
  const leaseUntil = validTime(lease.leaseUntil);
  if (leaseUntil == null || leaseUntil <= nowMs) {
    issues.push(issue(definition, 'lease_expired', 'critical', 'lease.leaseUntil',
      lease.leaseUntil || null, new Date(nowMs).toISOString()));
  }
  if (lease.metadata?.state === 'halted') {
    issues.push(issue(definition, 'lease_halted', 'critical', 'lease.metadata.state', 'halted'));
  }
  if (lease.metadata?.metadataProviderError) {
    issues.push(issue(definition, 'telemetry_error', 'warning',
      'lease.metadata.metadataProviderError', lease.metadata.metadataProviderError));
  }
  const telemetry = leaseTelemetry(lease);
  if (!telemetry) {
    issues.push(issue(definition, 'telemetry_missing', 'warning', 'telemetry', null));
    return attachRuntimeGroup(issues, lease);
  }
  const acquiredAt = validTime(lease.acquiredAt);
  const nodes = statusNodes(telemetry);
  const required = expected || nodes.some(({ value }) => value.running === true);
  for (const node of nodes) {
    addLifecycleIssues(issues, definition, node, required);
    addErrorIssues(issues, definition, node, definition.thresholds);
    addTimingIssues(issues, definition, node, definition.thresholds, nowMs, acquiredAt);
    addPressureIssues(issues, definition, node, definition.thresholds);
  }
  return attachRuntimeGroup(issues, lease);
}

module.exports = { addRuntimeIssues, evaluateWorkerHealth, leaseTelemetry, statusNodes };
