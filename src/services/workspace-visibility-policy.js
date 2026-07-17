const {
  createTokenIdentity,
  normalizeTokenChain,
} = require('../utils/token-identity');

const DEFAULT_FRESH_MS = 15 * 60 * 1000;

const DEFAULT_CHAIN_POLICIES = Object.freeze({
  solana: Object.freeze({
    valuationTypes: Object.freeze(['mcap']),
    hardRiskReviews: Object.freeze(['manual:junk_permanent']),
  }),
  robinhood: Object.freeze({
    valuationTypes: Object.freeze(['fdv']),
    hardRiskReviews: Object.freeze([]),
  }),
});

const ACTIVITY_STATES = new Set([
  'dex-low-activity',
  'gmgn-low-activity',
  'robinhood-dashboard-inactive',
]);

const ACTIVITY_REASONS = new Set([
  'low_activity_24h',
  'robinhood-no-swaps-15m',
]);

function normalizeLowerText(value) {
  return String(value ?? '').trim().toLowerCase();
}

function freezeList(values = []) {
  return Object.freeze([...values]);
}

function emptyValuation(type = null) {
  return Object.freeze({
    type,
    usd: null,
    observedAt: null,
    freshness: 'unknown',
  });
}

function normalizeIdentity(identityValue) {
  const value = identityValue || {};
  let chain;
  try {
    chain = normalizeTokenChain(value.chain);
  } catch (error) {
    const reason = /unsupported/i.test(error.message)
      ? 'unsupported_identity_chain'
      : 'invalid_identity';
    return { identity: null, reason };
  }

  try {
    return { identity: createTokenIdentity(chain, value.address), reason: null };
  } catch (_) {
    return { identity: null, reason: 'invalid_identity' };
  }
}

function normalizeAvailableChains(values, chainPolicies) {
  const source = values == null ? Object.keys(chainPolicies) : values;
  if (!Array.isArray(source)) {
    throw new TypeError('availableChains must be an array');
  }

  const chains = new Set();
  for (const value of source) {
    chains.add(normalizeTokenChain(value));
  }
  return chains;
}

function normalizeFilterNumber(value, name, fallback) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new TypeError(`${name} must be a non-negative number`);
  }
  return parsed;
}

function normalizeValuationFilters(filters = {}) {
  const minUsd = normalizeFilterNumber(filters.minValuationUsd, 'minValuationUsd', 0);
  const rawMax = normalizeFilterNumber(filters.maxValuationUsd, 'maxValuationUsd', null);
  const maxUsd = rawMax === 0 ? null : rawMax;
  if (maxUsd != null && maxUsd < minUsd) {
    throw new RangeError('maxValuationUsd must be greater than or equal to minValuationUsd');
  }
  return Object.freeze({ minUsd, maxUsd });
}

function parseObservedAt(value, issues) {
  if (value == null || value === '') return null;
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    issues.push('valuation_observed_at_invalid');
    return null;
  }
  return timestamp;
}

function parseValuationUsd(value, issues) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    issues.push('valuation_usd_invalid');
    return null;
  }
  return parsed;
}

function resolveValuationType(value, chainPolicy, issues) {
  const allowedTypes = chainPolicy.valuationTypes || [];
  const fallbackType = allowedTypes.length === 1 ? allowedTypes[0] : null;
  const type = normalizeLowerText(value?.type);
  const hasValue = value?.usd != null && value.usd !== '';

  if (!type) {
    if (hasValue) issues.push('valuation_type_missing');
    return { type: fallbackType, accepted: !hasValue };
  }
  if (!allowedTypes.includes(type)) {
    issues.push('valuation_type_mismatch');
    return { type: fallbackType, accepted: false };
  }
  return { type, accepted: true };
}

function normalizeValuation(value, chainPolicy, options = {}) {
  const issues = [];
  const nowMs = Number(options.nowMs ?? Date.now());
  const freshMs = Number(options.valuationFreshMs ?? DEFAULT_FRESH_MS);
  if (!Number.isFinite(nowMs) || !Number.isFinite(freshMs) || freshMs < 0) {
    throw new TypeError('Valuation freshness options are invalid');
  }

  const resolvedType = resolveValuationType(value, chainPolicy, issues);
  if (!resolvedType.accepted) {
    return { valuation: emptyValuation(resolvedType.type), issues: freezeList(issues) };
  }

  const usd = parseValuationUsd(value?.usd, issues);
  const observedAtMs = parseObservedAt(value?.observedAt, issues);
  if (usd != null && observedAtMs == null) {
    issues.push('valuation_observed_at_missing');
  }

  let freshness = 'unknown';
  if (usd != null && observedAtMs != null) {
    if (observedAtMs > nowMs) {
      issues.push('valuation_observed_at_future');
    } else {
      freshness = nowMs - observedAtMs <= freshMs ? 'fresh' : 'stale';
    }
  }

  return {
    valuation: Object.freeze({
      type: resolvedType.type,
      usd,
      observedAt: observedAtMs == null ? null : new Date(observedAtMs).toISOString(),
      freshness,
    }),
    issues: freezeList(issues),
  };
}

function resolveFilterMismatch(valuation, filters) {
  if (valuation.usd == null) {
    return filters.minUsd > 0 ? ['valuation_unavailable'] : [];
  }
  const mismatch = [];
  if (valuation.usd < filters.minUsd) mismatch.push('valuation_below_min');
  if (filters.maxUsd != null && valuation.usd > filters.maxUsd) {
    mismatch.push('valuation_above_max');
  }
  return mismatch;
}

function resolveRiskReviewKey(state) {
  const source = normalizeLowerText(state.riskReviewSource);
  const label = normalizeLowerText(state.riskReviewLabel);
  return source && label ? `${source}:${label}` : null;
}

function resolveHardExclusions(state, chainPolicy) {
  const reasons = [];
  if (state.adminBlocked === true) reasons.push('admin_blocked');
  if (state.userBlocked === true) reasons.push('user_blocked');
  if (state.chainSafetyBlocked === true) reasons.push('chain_safety_excluded');
  if ((chainPolicy.hardRiskReviews || []).includes(resolveRiskReviewKey(state))) {
    reasons.push('risk_junk_permanent');
  }
  return reasons;
}

function resolveRiskState(state, hardReasons) {
  if (hardReasons.includes('admin_blocked')) return 'blocked';
  if (hardReasons.includes('chain_safety_excluded')
    || hardReasons.includes('risk_junk_permanent')) return 'rejected';
  const reviewLabel = normalizeLowerText(state.riskReviewLabel);
  if (reviewLabel === 'junk_probable') return 'review';
  if (reviewLabel === 'valid') return 'approved';
  if (reviewLabel === 'valid_but_weak') return 'caution';
  return normalizeLowerText(state.riskState) || 'unknown';
}

function resolveActivityState(state, options = {}) {
  const timestamp = new Date(state.lastActivityAt || '').getTime();
  if (Number.isFinite(timestamp)) {
    const nowMs = Number(options.nowMs ?? Date.now());
    const freshMs = Number(options.activityFreshMs ?? DEFAULT_FRESH_MS);
    if (!Number.isFinite(nowMs) || !Number.isFinite(freshMs) || freshMs < 0) {
      throw new TypeError('Activity freshness options are invalid');
    }
    return timestamp <= nowMs && nowMs - timestamp <= freshMs ? 'fresh' : 'stale';
  }
  return ACTIVITY_STATES.has(normalizeLowerText(state.eligibilityState))
    || ACTIVITY_REASONS.has(normalizeLowerText(state.suppressedReason))
    ? 'stale'
    : 'unknown';
}

function rejectedResult(identity, reason) {
  return Object.freeze({
    identity,
    visible: false,
    reasons: freezeList([reason]),
    filterMismatch: freezeList(),
    riskState: 'unknown',
    activityState: 'unknown',
    valuation: emptyValuation(),
    dataQuality: freezeList(),
  });
}

function evaluateWorkspaceVisibility(input = {}, options = {}) {
  const normalized = normalizeIdentity(input.identity);
  if (normalized.reason) return rejectedResult(null, normalized.reason);

  const chainPolicies = options.chainPolicies || DEFAULT_CHAIN_POLICIES;
  const chainPolicy = chainPolicies[normalized.identity.chain];
  const availableChains = normalizeAvailableChains(options.availableChains, chainPolicies);
  if (!chainPolicy || !availableChains.has(normalized.identity.chain)) {
    return rejectedResult(normalized.identity, 'unsupported_workspace_chain');
  }

  const state = input.state || {};
  const filters = normalizeValuationFilters(input.filters);
  const normalizedValuation = normalizeValuation(input.valuation, chainPolicy, options);
  const reasons = resolveHardExclusions(state, chainPolicy);
  const filterMismatch = resolveFilterMismatch(normalizedValuation.valuation, filters);

  return Object.freeze({
    identity: normalized.identity,
    visible: reasons.length === 0 && filterMismatch.length === 0,
    reasons: freezeList(reasons),
    filterMismatch: freezeList(filterMismatch),
    riskState: resolveRiskState(state, reasons),
    activityState: resolveActivityState(state, options),
    valuation: normalizedValuation.valuation,
    dataQuality: normalizedValuation.issues,
  });
}

module.exports = {
  DEFAULT_CHAIN_POLICIES,
  DEFAULT_FRESH_MS,
  evaluateWorkspaceVisibility,
  normalizeValuationFilters,
};
