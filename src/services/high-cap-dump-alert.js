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
const PAIR_PIN_STABILITY_COUNT = 15;

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
    liveCurrentTs: readTextInput(input, 'liveCurrentTs', 'live_current_ts'),
    liveCurrentPairAddress: readTextInput(input, 'liveCurrentPairAddress', 'live_current_pair_address'),
    pinnedPairAddress: readTextInput(input, 'pinnedPairAddress', 'pinned_pair_address'),
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

function normalizePairAddress(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function getObservedPairAddress(detection) {
  return (
    normalizePairAddress(detection?.liveCurrentPairAddress)
    || normalizePairAddress(detection?.currentPairAddress)
    || normalizePairAddress(detection?.baselinePairAddress)
    || normalizePairAddress(detection?.windowLowPairAddress)
  );
}

function getLiveCurrentPairAddress(detection) {
  return normalizePairAddress(detection?.liveCurrentPairAddress);
}

function readPairPinMetadata(state) {
  const metadata = state?.metadata && typeof state.metadata === 'object' && !Array.isArray(state.metadata)
    ? state.metadata
    : {};

  return {
    pinnedPairAddress: normalizePairAddress(metadata.pinnedPairAddress),
    pairCandidateAddress: normalizePairAddress(metadata.pairCandidateAddress),
    pairCandidateCount: Math.max(0, Number(metadata.pairCandidateCount) || 0),
    pairPinStatus: normalizePairAddress(metadata.pairPinStatus),
    lastObservedPairAddress: normalizePairAddress(metadata.lastObservedPairAddress),
  };
}

function buildPairPinMetadata(pairPinState) {
  return {
    pinnedPairAddress: pairPinState.pinnedPairAddress,
    pairCandidateAddress: pairPinState.pairCandidateAddress,
    pairCandidateCount: pairPinState.pairCandidateCount,
    pairPinStatus: pairPinState.pairPinStatus,
    lastObservedPairAddress: pairPinState.observedPairAddress,
    pairPinStabilityCount: PAIR_PIN_STABILITY_COUNT,
  };
}

function pairPinMetadataChanged(stateBefore, pairPinState) {
  const previous = readPairPinMetadata(stateBefore);
  return previous.pinnedPairAddress !== pairPinState.pinnedPairAddress
    || previous.pairCandidateAddress !== pairPinState.pairCandidateAddress
    || previous.pairCandidateCount !== pairPinState.pairCandidateCount
    || previous.pairPinStatus !== pairPinState.pairPinStatus
    || previous.lastObservedPairAddress !== pairPinState.observedPairAddress;
}

function resolvePairPinState(stateBefore, detection) {
  const previous = readPairPinMetadata(stateBefore);
  const observedPairAddress = getObservedPairAddress(detection);
  const pinnedPairAddress = previous.pinnedPairAddress;

  if (!observedPairAddress) {
    return {
      observedPairAddress: null,
      pinnedPairAddress,
      pairCandidateAddress: null,
      pairCandidateCount: 0,
      pairPinStatus: pinnedPairAddress ? 'stable' : 'uninitialized',
      pinReadyForEvaluation: Boolean(pinnedPairAddress),
      pinSuppressed: false,
      pinChanged: false,
      pinReason: null,
    };
  }

  if (!pinnedPairAddress) {
    const pairCandidateCount = previous.pairCandidateAddress === observedPairAddress
      ? previous.pairCandidateCount + 1
      : 1;
    if (pairCandidateCount >= PAIR_PIN_STABILITY_COUNT) {
      return {
        observedPairAddress,
        pinnedPairAddress: observedPairAddress,
        pairCandidateAddress: null,
        pairCandidateCount: 0,
        pairPinStatus: 'acquired',
        pinReadyForEvaluation: false,
        pinSuppressed: true,
        pinChanged: true,
        pinReason: 'pin-acquired',
      };
    }

    return {
      observedPairAddress,
      pinnedPairAddress: null,
      pairCandidateAddress: observedPairAddress,
      pairCandidateCount,
      pairPinStatus: 'acquiring',
      pinReadyForEvaluation: false,
      pinSuppressed: true,
      pinChanged: false,
      pinReason: 'pin-acquiring',
    };
  }

  if (observedPairAddress === pinnedPairAddress) {
    return {
      observedPairAddress,
      pinnedPairAddress,
      pairCandidateAddress: null,
      pairCandidateCount: 0,
      pairPinStatus: 'stable',
      pinReadyForEvaluation: true,
      pinSuppressed: false,
      pinChanged: false,
      pinReason: null,
    };
  }

  const pairCandidateCount = previous.pairCandidateAddress === observedPairAddress
    ? previous.pairCandidateCount + 1
    : 1;
  if (pairCandidateCount >= PAIR_PIN_STABILITY_COUNT) {
    return {
      observedPairAddress,
      pinnedPairAddress: observedPairAddress,
      pairCandidateAddress: null,
      pairCandidateCount: 0,
      pairPinStatus: 'switched',
      pinReadyForEvaluation: false,
      pinSuppressed: true,
      pinChanged: true,
      pinReason: 'pin-switched',
    };
  }

  return {
    observedPairAddress,
    pinnedPairAddress,
    pairCandidateAddress: observedPairAddress,
    pairCandidateCount,
    pairPinStatus: 'switch-pending',
    pinReadyForEvaluation: false,
    pinSuppressed: true,
    pinChanged: false,
    pinReason: 'pin-switch-pending',
  };
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

  const pinnedPairAddress = readPairPinMetadata(state).pinnedPairAddress;
  const liveCurrentPairAddress = getLiveCurrentPairAddress(detection);
  if (pinnedPairAddress && liveCurrentPairAddress && liveCurrentPairAddress !== pinnedPairAddress) {
    return 'pair-switch';
  }

  const lastAlertedAtMs = toTimestampMs(state.lastAlertedAt);
  const evaluationTsMs = getEvaluationTsMs(detection, options);
  if (lastAlertedAtMs != null && evaluationTsMs - lastAlertedAtMs >= options.rearmAfterMs) {
    return 'timeout';
  }

  if (!qualifies) {
    const recoveryMcap = computeRecoveryMcap(state, options);
    if (recoveryMcap != null && detection.currentCloseMcap != null && detection.currentCloseMcap >= recoveryMcap) {
      return 'recovery';
    }
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

function buildBaseStatePayload(ruleKey, detection, stateBefore, extraMetadata = null) {
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
    metadata: mergeMetadata(stateBefore?.metadata, extraMetadata),
  };
}

function buildTriggeredStatePayload(ruleKey, detection, stateBefore, event, rearmReason, extraMetadata = null) {
  return {
    ...buildBaseStatePayload(ruleKey, detection, stateBefore, extraMetadata),
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
      extraMetadata,
      {
        lastDecision: 'triggered',
        lastEventId: event?.id || null,
        lastRearmReason: rearmReason || null,
      }
    ),
  };
}

function buildSuppressedStatePayload(ruleKey, detection, stateBefore, extraMetadata = null) {
  return {
    ...buildBaseStatePayload(ruleKey, detection, stateBefore, extraMetadata),
    status: 'triggered',
    rearmRequired: true,
    metadata: mergeMetadata(
      stateBefore?.metadata,
      extraMetadata,
      {
        lastDecision: 'suppressed',
        suppressedReason: 'still-triggered',
      }
    ),
  };
}
function buildRearmedStatePayload(ruleKey, detection, stateBefore, rearmReason, extraMetadata = null) {
  return {
    ...buildBaseStatePayload(ruleKey, detection, stateBefore, extraMetadata),
    status: 'rearmed',
    rearmRequired: false,
    metadata: mergeMetadata(
      stateBefore?.metadata,
      extraMetadata,
      {
        lastDecision: 'rearmed',
        lastRearmReason: rearmReason,
      }
    ),
  };
}

function buildTrackingStatePayload(ruleKey, detection, stateBefore, extraMetadata = null) {
  return {
    ...buildBaseStatePayload(ruleKey, detection, stateBefore, extraMetadata),
    status: stateBefore?.status || 'idle',
    rearmRequired: Boolean(stateBefore?.rearmRequired),
    metadata: mergeMetadata(
      stateBefore?.metadata,
      extraMetadata,
      {
        lastDecision: 'tracking',
      }
    ),
  };
}

function buildEventPayload(ruleKey, detection, options, rearmReason, extraMetadata = null) {
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
        liveCurrentPairAddress: detection.liveCurrentPairAddress,
        pinnedPairAddress: detection.pinnedPairAddress,
        windowLowPairAddress: detection.windowLowPairAddress,
        windowPairCount: detection.windowPairCount,
        pairChangedInWindow: detection.pairChangedInWindow,
      },
      extraMetadata,
      rearmReason ? { rearmedBy: rearmReason } : null
    ),
  };
}

function shouldTriggerDetection(stateBefore, qualifies, rearmReason) {
  return qualifies && (!hasTriggeredState(stateBefore) || (rearmReason && rearmReason !== 'pair-switch'));
}

function shouldPersistSuppressedState(stateBefore, qualifies, rearmReason, metadataChanged) {
  return qualifies && hasTriggeredState(stateBefore) && !rearmReason && metadataChanged;
}

function shouldTrackPairPinOnly(rearmReason, metadataChanged, canTrigger, persistSuppressedState) {
  return !rearmReason && metadataChanged && !canTrigger && !persistSuppressedState;
}

function isPinOnlySuppression(pairPinState, rawQualifies, canTrigger, persistSuppressedState) {
  return pairPinState.pinSuppressed && rawQualifies && !canTrigger && !persistSuppressedState;
}

async function applyEvaluationDecision(context) {
  const {
    client,
    settings,
    detection,
    stateBefore,
    pairPinState,
    pairPinMetadata,
    rawQualifies,
    qualifies,
    rearmReason,
    metadataChanged,
  } = context;
  const canTrigger = shouldTriggerDetection(stateBefore, qualifies, rearmReason);
  const persistSuppressedState = shouldPersistSuppressedState(stateBefore, qualifies, rearmReason, metadataChanged);
  const shouldTrackMetadataOnly = shouldTrackPairPinOnly(rearmReason, metadataChanged, canTrigger, persistSuppressedState);
  const suppressedByPinOnly = isPinOnlySuppression(pairPinState, rawQualifies, canTrigger, persistSuppressedState);
  let event = null;
  let stateAfter = stateBefore;
  let action = 'noop';

  if (canTrigger) {
    event = await tokenAlertEvent.createEvent(
      buildEventPayload(settings.ruleKey, detection, settings, rearmReason, pairPinMetadata),
      client
    );
    stateAfter = await tokenAlertRuleState.upsertState(
      buildTriggeredStatePayload(settings.ruleKey, detection, stateBefore, event, rearmReason, pairPinMetadata),
      client
    );
    action = rearmReason ? 'retriggered' : 'triggered';
  } else if (persistSuppressedState) {
    stateAfter = await tokenAlertRuleState.upsertState(
      buildSuppressedStatePayload(settings.ruleKey, detection, stateBefore, pairPinMetadata),
      client
    );
    action = 'suppressed';
  } else if (qualifies && hasTriggeredState(stateBefore) && !rearmReason) {
    action = 'suppressed';
  } else if (rearmReason) {
    stateAfter = await tokenAlertRuleState.upsertState(
      buildRearmedStatePayload(settings.ruleKey, detection, stateBefore, rearmReason, pairPinMetadata),
      client
    );
    action = 'rearmed';
  } else if (shouldTrackMetadataOnly) {
    stateAfter = await tokenAlertRuleState.upsertState(
      buildTrackingStatePayload(settings.ruleKey, detection, stateBefore, pairPinMetadata),
      client
    );
    action = suppressedByPinOnly ? 'suppressed' : 'noop';
  } else if (suppressedByPinOnly) {
    action = 'suppressed';
  }

  return {
    action,
    event,
    stateAfter,
  };
}

async function evaluateDetection(detectionInput, options = {}) {
  const settings = resolveOptions(options);
  const detection = normalizeDetection(detectionInput);

  if (!isValidAddress(detection.tokenAddress)) {
    throw new Error('Invalid token address format');
  }

  const gates = resolveDetectionGates(detection, settings);
  const rawQualifies = passesAllGates(gates);
  const client = await db.getClient();

  try {
    await client.query('BEGIN');

    const stateBefore = await tokenAlertRuleState.getState(settings.ruleKey, detection.tokenAddress, client);
    const pairPinState = resolvePairPinState(stateBefore, detection);
    const pairPinMetadata = buildPairPinMetadata(pairPinState);
    const qualifies = rawQualifies && pairPinState.pinReadyForEvaluation;
    const rearmReason = getRearmReason(stateBefore, detection, settings, qualifies);
    const metadataChanged = pairPinMetadataChanged(stateBefore, pairPinState);
    const { action, event, stateAfter } = await applyEvaluationDecision({
      client,
      settings,
      detection,
      stateBefore,
      pairPinState,
      pairPinMetadata,
      rawQualifies,
      qualifies,
      rearmReason,
      metadataChanged,
    });

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
        pinReadyForEvaluation: pairPinState.pinReadyForEvaluation,
        pinSuppressed: pairPinState.pinSuppressed,
        pinStatus: pairPinState.pairPinStatus,
        observedPairAddress: pairPinState.observedPairAddress,
        pinnedPairAddress: pairPinState.pinnedPairAddress,
        liveCurrentPairAddress: getLiveCurrentPairAddress(detection),
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
  PAIR_PIN_STABILITY_COUNT,
  evaluateDetection,
  __private: {
    buildBaseStatePayload,
    buildEventPayload,
    buildPairPinMetadata,
    applyEvaluationDecision,
    buildRearmedStatePayload,
    buildSuppressedStatePayload,
    buildTrackingStatePayload,
    buildTriggeredStatePayload,
    computeRecoveryMcap,
    evaluateDetectionGates,
    getObservedPairAddress,
    getRearmReason,
    hasConsistentPairWindow,
    hasTriggeredState,
    mergeMetadata,
    normalizeDetection,
    normalizePairAddress,
    passesAllGates,
    pairPinMetadataChanged,
    firstDefinedValue,
    readPairPinMetadata,
    resolvePairPinState,
    shouldPersistSuppressedState,
    shouldTrackPairPinOnly,
    shouldTriggerDetection,
    isPinOnlySuppression,
    resolveDetectionGates,
    resolveOptions,
    toNumberOrNull,
    toTimestampMs,
    toTimestampOrNull,
  },
};
