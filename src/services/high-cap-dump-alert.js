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

function readTextInput(input, camelKey, snakeKey) {
  const value = firstDefinedValue(input?.[camelKey], input?.[snakeKey]);
  return value == null ? null : String(value);
}

function readNumberInput(input, camelKey, snakeKey) {
  return toNumberOrNull(firstDefinedValue(input?.[camelKey], input?.[snakeKey]));
}

function readBooleanInput(input, camelKey, snakeKey) {
  const value = firstDefinedValue(input?.[camelKey], input?.[snakeKey]);
  return value === true;
}

function readCountInput(input, camelKey, snakeKey) {
  return Math.max(0, Number(firstDefinedValue(input?.[camelKey], input?.[snakeKey])) || 0);
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
    tokenAddress: String(readTextInput(input, 'tokenAddress', 'token_address') || '').trim(),
    baselineTs: readTextInput(input, 'baselineTs', 'baseline_ts'),
    baselinePairAddress: readTextInput(input, 'baselinePairAddress', 'baseline_pair_address'),
    baselineMcap: readNumberInput(input, 'baselineMcap', 'baseline_mcap'),
    currentTs: readTextInput(input, 'currentTs', 'current_ts'),
    currentPairAddress: readTextInput(input, 'currentPairAddress', 'current_pair_address'),
    currentCloseMcap: readNumberInput(input, 'currentCloseMcap', 'current_close_mcap'),
    windowLowBucketTs: readTextInput(input, 'windowLowBucketTs', 'window_low_bucket_ts'),
    windowLowPairAddress: readTextInput(input, 'windowLowPairAddress', 'window_low_pair_address'),
    windowLowMcap: readNumberInput(input, 'windowLowMcap', 'window_low_mcap'),
    latestBucketAgeMs: readNumberInput(input, 'latestBucketAgeMs', 'latest_bucket_age_ms'),
    bucketCount: readCountInput(input, 'bucketCount', 'bucket_count'),
    windowPairCount: readCountInput(input, 'windowPairCount', 'window_pair_count'),
    pairChangedInWindow: readBooleanInput(input, 'pairChangedInWindow', 'pair_changed_in_window'),
    dumpPct: readNumberInput(input, 'dumpPct', 'dump_pct'),
    passesHighCapGate: input.passesHighCapGate,
    passesCoverageGate: input.passesCoverageGate,
    passesFreshnessGate: input.passesFreshnessGate,
    passesThreshold: input.passesThreshold,
    passesPairConsistencyGate: input.passesPairConsistencyGate,
  };
}

function hasConsistentPairWindow(detection) {
  if (detection.pairChangedInWindow || detection.windowPairCount > 1) {
    return false;
  }

  const uniquePairs = new Set(
    [
      detection.baselinePairAddress,
      detection.currentPairAddress,
      detection.windowLowPairAddress,
    ]
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  );

  return uniquePairs.size <= 1;
}

function evaluateDetectionGates(detection, options) {
  return {
    passesHighCapGate: detection.baselineMcap != null && detection.baselineMcap >= options.minBaselineMcap,
    passesCoverageGate: detection.bucketCount >= options.minBucketCount,
    passesFreshnessGate: detection.latestBucketAgeMs != null && detection.latestBucketAgeMs <= options.maxLatestBucketAgeMs,
    passesThreshold: detection.dumpPct != null && detection.dumpPct <= (-1 * options.thresholdPct),
    passesPairConsistencyGate: hasConsistentPairWindow(detection),
  };
}

function resolveDetectionGates(detection, options) {
  const computed = evaluateDetectionGates(detection, options);
  return {
    passesHighCapGate: typeof detection.passesHighCapGate === 'boolean' ? detection.passesHighCapGate : computed.passesHighCapGate,
    passesCoverageGate: typeof detection.passesCoverageGate === 'boolean' ? detection.passesCoverageGate : computed.passesCoverageGate,
    passesFreshnessGate: typeof detection.passesFreshnessGate === 'boolean' ? detection.passesFreshnessGate : computed.passesFreshnessGate,
    passesThreshold: typeof detection.passesThreshold === 'boolean' ? detection.passesThreshold : computed.passesThreshold,
    passesPairConsistencyGate: typeof detection.passesPairConsistencyGate === 'boolean'
      ? detection.passesPairConsistencyGate
      : computed.passesPairConsistencyGate,
  };
}

function passesAllGates(gates) {
  return Boolean(
    gates
    && gates.passesHighCapGate
    && gates.passesCoverageGate
    && gates.passesFreshnessGate
    && gates.passesThreshold
    && gates.passesPairConsistencyGate
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

function getRearmReason(state, detection, options, qualifies = false) {
  if (!hasTriggeredState(state)) {
    return null;
  }

  const lastAlertedAtMs = toTimestampMs(state.lastAlertedAt);
  const evaluationTsMs = getEvaluationTsMs(detection, options);
  if (lastAlertedAtMs != null && evaluationTsMs - lastAlertedAtMs >= options.rearmAfterMs) {
    return 'timeout';
  }

  if (qualifies) {
    return null;
  }

  const recoveryMcap = computeRecoveryMcap(state, options);
  if (recoveryMcap != null && detection.currentCloseMcap != null && detection.currentCloseMcap >= recoveryMcap) {
    return 'recovery';
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
        baselinePairAddress: detection.baselinePairAddress,
        currentPairAddress: detection.currentPairAddress,
        windowLowPairAddress: detection.windowLowPairAddress,
        windowPairCount: detection.windowPairCount,
        pairChangedInWindow: detection.pairChangedInWindow,
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
    const rearmReason = getRearmReason(stateBefore, detection, settings, qualifies);
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
    hasConsistentPairWindow,
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
