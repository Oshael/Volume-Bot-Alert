const { evaluateCustomAlertCapability } = require('./custom-alert-capability-policy');
const { normalizeTokenAddress, normalizeTokenChain } = require('../utils/token-identity');

const BASELINE_KEYS = Object.freeze({
  price: 'baselinePrice',
  mcap: 'baselineMcap',
  fdv: 'baselineFdv',
});
const OPERATORS = new Set(['cross_above', 'cross_below']);

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveIntegerOrNull(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizedObservedAt(value) {
  if (value == null || value === '') return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function normalizeIdentity(value = {}) {
  try {
    const chain = normalizeTokenChain(value.chain);
    const address = normalizeTokenAddress(chain, value.address || value.tokenAddress);
    return { chain, address };
  } catch (_) {
    return null;
  }
}

function sameIdentity(left, right) {
  return Boolean(left && right && left.chain === right.chain && left.address === right.address);
}

function normalizeOrdering(value) {
  const blockNumber = numberOrNull(value?.blockNumber);
  const logIndex = numberOrNull(value?.logIndex);
  if (Number.isSafeInteger(blockNumber) && blockNumber >= 0
    && Number.isSafeInteger(logIndex) && logIndex >= 0) {
    return { blockNumber, logIndex };
  }
  return null;
}

function compareObservationOrder(previous, current) {
  const previousOrdering = normalizeOrdering(previous?.ordering);
  const currentOrdering = normalizeOrdering(current?.ordering);
  if (previousOrdering && currentOrdering) {
    if (currentOrdering.blockNumber !== previousOrdering.blockNumber) {
      return Math.sign(currentOrdering.blockNumber - previousOrdering.blockNumber);
    }
    return Math.sign(currentOrdering.logIndex - previousOrdering.logIndex);
  }
  const previousTime = Date.parse(String(previous?.observedAt || ''));
  const currentTime = Date.parse(String(current?.observedAt || ''));
  if (!Number.isFinite(previousTime) || !Number.isFinite(currentTime)) return null;
  return Math.sign(currentTime - previousTime);
}

function hasObservationPosition(observation) {
  return normalizeOrdering(observation?.ordering) != null
    || Number.isFinite(Date.parse(String(observation?.observedAt || '')));
}

function decision(rule, reason, details = {}) {
  return Object.freeze({
    matched: false,
    reason,
    ruleId: Number(rule?.id) || null,
    ...details,
  });
}

function resolveRuleContext(rule, observation) {
  if (rule.status !== 'active') return decision(rule, 'rule_inactive');
  const ruleId = positiveIntegerOrNull(rule.id);
  const userId = positiveIntegerOrNull(rule.userId);
  if (ruleId == null || userId == null) {
    return decision(rule, 'invalid_rule_owner');
  }
  const ruleIdentity = normalizeIdentity(rule);
  const observationIdentity = normalizeIdentity(observation);
  if (!sameIdentity(ruleIdentity, observationIdentity)) {
    return decision(rule, 'identity_mismatch');
  }

  const capability = evaluateCustomAlertCapability({
    chain: ruleIdentity.chain,
    metric: rule.metric,
    window: rule.window,
    ready: true,
  });
  if (!capability.ok) return decision(rule, capability.reason, { code: capability.code });
  if (!OPERATORS.has(rule.operator)) return decision(rule, 'unsupported_operator');
  if (!hasObservationPosition(observation)) {
    return decision(rule, 'observation_position_missing');
  }
  const observedAt = normalizedObservedAt(observation.observedAt);
  if (!observedAt) return decision(rule, 'observed_at_invalid');
  return { capability, observationIdentity, observedAt, ruleId, ruleIdentity, userId };
}

function resolveReference(
  rule, capability, observationIdentity, previousObservation, observation,
) {
  const baselineValue = numberOrNull(rule.metadata?.[BASELINE_KEYS[capability.metric]]);
  if (!previousObservation) {
    return { baselineValue, previousValue: null, referenceValue: baselineValue };
  }
  const previousIdentity = normalizeIdentity(previousObservation);
  if (!sameIdentity(observationIdentity, previousIdentity)) {
    return { rejection: decision(rule, 'previous_identity_mismatch') };
  }
  if (!normalizedObservedAt(previousObservation.observedAt)) {
    return { rejection: decision(rule, 'previous_observed_at_invalid') };
  }
  const order = compareObservationOrder(previousObservation, observation);
  if (order == null) return { rejection: decision(rule, 'previous_position_missing') };
  if (order === 0) return { rejection: decision(rule, 'duplicate_observation') };
  if (order != null && order < 0) {
    return { rejection: decision(rule, 'out_of_order_observation') };
  }
  const previousValue = numberOrNull(previousObservation.values?.[capability.metric]);
  return {
    baselineValue,
    previousValue,
    referenceValue: baselineValue ?? previousValue,
  };
}

function evaluateCustomAlertRule(rule = {}, observation = {}, previousObservation = null) {
  const context = resolveRuleContext(rule, observation);
  if (!context.capability) return context;
  const {
    capability, observationIdentity, observedAt, ruleId, ruleIdentity, userId,
  } = context;

  const targetValue = numberOrNull(rule.targetValue);
  const currentValue = numberOrNull(observation.values?.[capability.metric]);
  if (!(targetValue > 0)) return decision(rule, 'invalid_target');
  if (currentValue == null) return decision(rule, 'current_value_missing');

  const reference = resolveReference(
    rule, capability, observationIdentity, previousObservation, observation,
  );
  if (reference.rejection) return reference.rejection;
  const { baselineValue, previousValue, referenceValue } = reference;
  if (referenceValue == null) return decision(rule, 'reference_value_missing');
  const matched = rule.operator === 'cross_above'
    ? referenceValue < targetValue && currentValue >= targetValue
    : referenceValue > targetValue && currentValue <= targetValue;
  if (!matched) {
    return decision(rule, 'target_not_crossed', {
      previousValue, currentValue, referenceValue,
    });
  }

  return Object.freeze({
    matched: true,
    reason: 'target_crossed',
    ruleId,
    intent: Object.freeze({
      ruleId,
      userId,
      chain: ruleIdentity.chain,
      address: ruleIdentity.address,
      metric: capability.metric,
      window: capability.window,
      operator: rule.operator,
      targetValue,
      previousValue,
      currentValue,
      referenceValue,
      referenceSource: baselineValue == null ? 'previous_observation' : 'creation_baseline',
      observedAt,
      ordering: normalizeOrdering(observation.ordering),
    }),
  });
}

function evaluateCustomAlertRules(input = {}) {
  const decisions = (Array.isArray(input.rules) ? input.rules : []).map((rule) => (
    evaluateCustomAlertRule(rule, input.observation, input.previousObservation)
  ));
  return Object.freeze({
    decisions: Object.freeze(decisions),
    intents: Object.freeze(decisions.filter((item) => item.matched).map((item) => item.intent)),
  });
}

module.exports = {
  compareObservationOrder,
  evaluateCustomAlertRule,
  evaluateCustomAlertRules,
};
