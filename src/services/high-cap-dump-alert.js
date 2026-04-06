const db = require('../models/db');
const tokenAlertEvent = require('../models/token-alert-event');
const tokenAlertRuleState = require('../models/token-alert-rule-state');
const { isValidAddress } = require('../models/user-token');
const backendAlertPublisher = require('./backend-alert-publisher');
const { HIGH_CAP_DUMP_RULE_KEY, getBackendAlertRule } = require('./backend-alert-rules');

const HIGH_CAP_DUMP_RULE = getBackendAlertRule(HIGH_CAP_DUMP_RULE_KEY);
const DEFAULT_THRESHOLD_PCT = HIGH_CAP_DUMP_RULE.defaults.thresholdPct;
const DEFAULT_MIN_BASELINE_MCAP = HIGH_CAP_DUMP_RULE.defaults.minBaselineMcap;
const DEFAULT_MAX_LATEST_BUCKET_AGE_MS = HIGH_CAP_DUMP_RULE.defaults.maxLatestBucketAgeMs;
const DEFAULT_MIN_BUCKET_COUNT = HIGH_CAP_DUMP_RULE.defaults.minBucketCount;
const DEFAULT_REARM_RECOVERY_PCT = HIGH_CAP_DUMP_RULE.defaults.rearmRecoveryPct;
const DEFAULT_REARM_AFTER_MS = HIGH_CAP_DUMP_RULE.defaults.rearmAfterMs;

function toNumberOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toTimestampOrNull(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function toTimestampMs(value) {
  const parsed = toTimestampOrNull(value);
  return parsed ? parsed.getTime() : null;
}

function resolveOptions(options = {}) {
  return {
    ruleKey: String(options.ruleKey || HIGH_CAP_DUMP_RULE_KEY).trim().toLowerCase(),
    thresholdPct: Math.max(0, Number(options.thresholdPct) || DEFAULT_THRESHOLD_PCT),
    minBaselineMcap: Math.max(0, Number(options.minBaselineMcap) || DEFAULT_MIN_BASELINE_MCAP),
    maxLatestBucketAgeMs: Math.max(1, Number(options.maxLatestBucketAgeMs) || DEFAULT_MAX_LATEST_BUCKET_AGE_MS),
    minBucketCount: Math.max(1, Number(options.minBucketCount) || DEFAULT_MIN_BUCKET_COUNT),
    rearmRecoveryPct: Math.max(0, Number(options.rearmRecoveryPct) || DEFAULT_REARM_RECOVERY_PCT),
    rearmAfterMs: Math.max(1, Number(options.rearmAfterMs) || DEFAULT_REARM_AFTER_MS),
    now: toTimestampOrNull(options.now) || null,
  };
}

function normalizeDetection(input = {}) {
  return {
    tokenAddress: String(input.tokenAddress || input.token_address || '').trim(),
    baselineTs: input.baselineTs || input.baseline_ts || null,
    baselineMcap: toNumberOrNull(input.baselineMcap ?? input.baseline_mcap),
    currentTs: input.currentTs || input.current_ts || null,
    currentCloseMcap: toNumberOrNull(input.currentCloseMcap ?? input.current_close_mcap),
    windowLowMcap: toNumberOrNull(input.windowLowMcap ?? input.window_low_mcap),
    latestBucketAgeMs: toNumberOrNull(input.latestBucketAgeMs ?? input.latest_bucket_age_ms),
    bucketCount: Math.max(0, Number(input.bucketCount ?? input.bucket_count) || 0),
    dumpPct: toNumberOrNull(input.dumpPct ?? input.dump_pct),
    passesHighCapGate: input.passesHighCapGate,
    passesCoverageGate: input.passesCoverageGate,
    passesFreshnessGate: input.passesFreshnessGate,
    passesThreshold: input.passesThreshold,
  };
}

function evaluateDetectionGates(detection, options) {
  return {
    passesHighCapGate: detection.baselineMcap != null && detection.baselineMcap >= options.minBaselineMcap,
    passesCoverageGate: detection.bucketCount >= options.minBucketCount,
    passesFreshnessGate: detection.latestBucketAgeMs != null && detection.latestBucketAgeMs <= options.maxLatestBucketAgeMs,
    passesThreshold: detection.dumpPct != null && detection.dumpPct <= (-1 * options.thresholdPct),
  };
}

function resolveDetectionGates(detection, options) {
  const computed = evaluateDetectionGates(detection, options);
  return {
    passesHighCapGate: typeof detection.passesHighCapGate === 'boolean' ? detection.passesHighCapGate : computed.passesHighCapGate,
    passesCoverageGate: typeof detection.passesCoverageGate === 'boolean' ? detection.passesCoverageGate : computed.passesCoverageGate,
    passesFreshnessGate: typeof detection.passesFreshnessGate === 'boolean' ? detection.passesFreshnessGate : computed.passesFreshnessGate,
    passesThreshold: typeof detection.passesThreshold === 'boolean' ? detection.passesThreshold : computed.passesThreshold,
  };
}

function passesAllGates(gates) {
  return Boolean(
    gates
    && gates.passesHighCapGate
    && gates.passesCoverageGate
    && gates.passesFreshnessGate
    && gates.passesThreshold
  );
}

function hasTriggeredState(state) {
  return Boolean(state && state.status === 'triggered');
}

function computeRecoveryMcap(state, options) {
  const baselineMcap = toNumberOrNull(state?.lastBaselineMcap);
  if (!(baselineMcap > 0)) {
    return null;
  }

  return baselineMcap * (options.rearmRecoveryPct / 100);
}

function getEvaluationTsMs(detection, options) {
  return toTimestampMs(detection.currentTs) ?? toTimestampMs(options.now) ?? Date.now();
}

function getRearmReason(state, detection, options) {
  if (!hasTriggeredState(state)) {
    return null;
  }

  const recoveryMcap = computeRecoveryMcap(state, options);
  if (recoveryMcap != null && detection.currentCloseMcap != null && detection.currentCloseMcap >= recoveryMcap) {
    return 'recovery';
  }

  const lastAlertedAtMs = toTimestampMs(state.lastAlertedAt);
  const evaluationTsMs = getEvaluationTsMs(detection, options);
  if (lastAlertedAtMs != null && evaluationTsMs - lastAlertedAtMs >= options.rearmAfterMs) {
    return 'timeout';
  }

  return null;
}

function mergeMetadata(...values) {
  const merged = {};
  for (const value of values) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      continue;
    }
    Object.assign(merged, value);
  }
  return merged;
}

function firstDefinedValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  return null;
}

function buildBaseStatePayload(ruleKey, detection, stateBefore) {
  return {
    ruleKey,
    tokenAddress: detection.tokenAddress,
    status: stateBefore?.status || 'idle',
    lastBaselineTs: firstDefinedValue(detection.baselineTs, stateBefore?.lastBaselineTs),
    lastBaselineMcap: firstDefinedValue(detection.baselineMcap, stateBefore?.lastBaselineMcap),
    lastWindowLowMcap: firstDefinedValue(detection.windowLowMcap, stateBefore?.lastWindowLowMcap),
    lastCurrentTs: firstDefinedValue(detection.currentTs, stateBefore?.lastCurrentTs),
    lastCurrentCloseMcap: firstDefinedValue(detection.currentCloseMcap, stateBefore?.lastCurrentCloseMcap),
    lastAlertedAt: firstDefinedValue(stateBefore?.lastAlertedAt),
    lastAlertedPct: firstDefinedValue(stateBefore?.lastAlertedPct),
    rearmRequired: Boolean(stateBefore?.rearmRequired),
    metadata: mergeMetadata(stateBefore?.metadata),
  };
}

function buildTriggeredStatePayload(ruleKey, detection, stateBefore, event, rearmReason) {
  return {
    ...buildBaseStatePayload(ruleKey, detection, stateBefore),
    status: 'triggered',
    lastBaselineTs: detection.baselineTs,
    lastBaselineMcap: detection.baselineMcap,
    lastWindowLowMcap: detection.windowLowMcap,
    lastCurrentTs: detection.currentTs,
    lastCurrentCloseMcap: detection.currentCloseMcap,
    lastAlertedAt: event?.triggeredAt || new Date().toISOString(),
    lastAlertedPct: detection.dumpPct,
    rearmRequired: true,
    metadata: mergeMetadata(
      stateBefore?.metadata,
      {
        lastDecision: 'triggered',
        lastEventId: event?.id || null,
        lastRearmReason: rearmReason || null,
      }
    ),
  };
}

function buildSuppressedStatePayload(ruleKey, detection, stateBefore) {
  return {
    ...buildBaseStatePayload(ruleKey, detection, stateBefore),
    status: 'triggered',
    rearmRequired: true,
    metadata: mergeMetadata(
      stateBefore?.metadata,
      {
        lastDecision: 'suppressed',
        suppressedReason: 'still-triggered',
      }
    ),
  };
}
function buildRearmedStatePayload(ruleKey, detection, stateBefore, rearmReason) {
  return {
    ...buildBaseStatePayload(ruleKey, detection, stateBefore),
    status: 'rearmed',
    rearmRequired: false,
    metadata: mergeMetadata(
      stateBefore?.metadata,
      {
        lastDecision: 'rearmed',
        lastRearmReason: rearmReason,
      }
    ),
  };
}

function buildEventPayload(ruleKey, detection, options, rearmReason) {
  return {
    ruleKey,
    tokenAddress: detection.tokenAddress,
    baselineTs: detection.baselineTs,
    baselineMcap: detection.baselineMcap,
    windowLowMcap: detection.windowLowMcap,
    currentTs: detection.currentTs,
    currentCloseMcap: detection.currentCloseMcap,
    dumpPct: detection.dumpPct,
    thresholdPct: options.thresholdPct,
    metadata: mergeMetadata(
      {
        bucketCount: detection.bucketCount,
        latestBucketAgeMs: detection.latestBucketAgeMs,
      },
      rearmReason ? { rearmedBy: rearmReason } : null
    ),
  };
}

async function evaluateDetection(detectionInput, options = {}) {
  const settings = resolveOptions(options);
  const detection = normalizeDetection(detectionInput);

  if (!isValidAddress(detection.tokenAddress)) {
    throw new Error('Invalid token address format');
  }

  const gates = resolveDetectionGates(detection, settings);
  const qualifies = passesAllGates(gates);
  const client = await db.getClient();

  try {
    await client.query('BEGIN');

    const stateBefore = await tokenAlertRuleState.getState(settings.ruleKey, detection.tokenAddress, client);
    const rearmReason = getRearmReason(stateBefore, detection, settings);
    let event = null;
    let stateAfter = stateBefore;
    let action = 'noop';

    if (qualifies && (!hasTriggeredState(stateBefore) || rearmReason)) {
      event = await tokenAlertEvent.createEvent(
        buildEventPayload(settings.ruleKey, detection, settings, rearmReason),
        client
      );
      stateAfter = await tokenAlertRuleState.upsertState(
        buildTriggeredStatePayload(settings.ruleKey, detection, stateBefore, event, rearmReason),
        client
      );
      action = rearmReason ? 'retriggered' : 'triggered';
    } else if (qualifies && hasTriggeredState(stateBefore) && !rearmReason) {
      action = 'suppressed';
    } else if (rearmReason) {
      stateAfter = await tokenAlertRuleState.upsertState(
        buildRearmedStatePayload(settings.ruleKey, detection, stateBefore, rearmReason),
        client
      );
      action = 'rearmed';
    }

    await client.query('COMMIT');

    if (event) {
      await backendAlertPublisher.publishEventSafe(event, { logLabel: 'HighCapDumpAlert' });
    }

    return {
      ruleKey: settings.ruleKey,
      tokenAddress: detection.tokenAddress,
      detection: {
        ...detection,
        ...gates,
        passesAllGates: qualifies,
      },
      stateBefore,
      stateAfter,
      event,
      emitted: Boolean(event),
      rearmed: Boolean(rearmReason),
      rearmReason,
      action,
    };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  HIGH_CAP_DUMP_RULE_KEY,
  DEFAULT_REARM_RECOVERY_PCT,
  DEFAULT_REARM_AFTER_MS,
  evaluateDetection,
  __private: {
    buildBaseStatePayload,
    buildEventPayload,
    buildRearmedStatePayload,
    buildSuppressedStatePayload,
    buildTriggeredStatePayload,
    computeRecoveryMcap,
    evaluateDetectionGates,
    getRearmReason,
    hasTriggeredState,
    mergeMetadata,
    normalizeDetection,
    passesAllGates,
    firstDefinedValue,
    resolveDetectionGates,
    resolveOptions,
    toNumberOrNull,
    toTimestampMs,
    toTimestampOrNull,
  },
};
