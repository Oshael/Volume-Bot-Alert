const {
  CHAIN,
  STANDARD_RULE_KEYS,
  VALUATION_TYPE,
} = require('./robinhood-standard-alert-contract');
const {
  canRepeatSurgeInSession,
  getStandardTransition,
} = require('./standard-alert-transition');
const STANDARD_ALERT_COOLDOWN_MS = 60 * 1000;
const SURGE_RULE_KEYS = Object.freeze([
  'recent-surge-1h', 'recent-surge-6h', 'old-week-surge-1h', 'old-week-surge-6h',
]);
const SURGE_MIN_FDV = Object.freeze({ '1h': 45_000, '6h': 40_000 });
const RULE_SPECS = Object.freeze([
  ['recent-surge-6h', 'recentSurge6h', 'recentSurge6hThresholdPct', '6h', 'recentSurge6h'],
  ['recent-surge-1h', 'recentSurge1h', 'recentSurge1hThresholdPct', '1h', 'recentSurge1h'],
  ['old-week-surge-6h', 'oldWeekSurge6h', 'oldWeekSurge6hThresholdPct', '6h', 'oldWeekSurge'],
  ['old-week-surge-1h', 'oldWeekSurge1h', 'oldWeekSurge1hThresholdPct', '1h', 'oldWeekSurge'],
]);
const ENABLED_FIELD_BY_RULE = Object.freeze({
  'monitored-vol': 'monitoredVol',
  'monitored-fdv': 'monitoredFdv',
  'recent-surge-1h': 'recentSurge1h',
  'recent-surge-6h': 'recentSurge6h',
  'old-week-surge-1h': 'oldWeekSurge1h',
  'old-week-surge-6h': 'oldWeekSurge6h',
});
function numberOrNull(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
function passesProfileFilters(profile, signal, minimumFdv = 0) {
  if (signal.filters.adminBlocked === true) return false;
  const volume = numberOrNull(signal.volume5m.currentUsd) || 0;
  const fdv = numberOrNull(signal.valuation.current.fdvUsd) || 0;
  const minFdv = Math.max(numberOrNull(profile.minFdv) || 0, minimumFdv);
  const maxFdv = numberOrNull(profile.maxFdv) || 0;
  return volume >= (numberOrNull(profile.minVol) || 0)
    && fdv >= minFdv
    && (maxFdv === 0 || fdv <= maxFdv);
}
function payload(signal, extras = {}) {
  return Object.freeze({
    address: signal.address,
    valuationType: VALUATION_TYPE,
    fdv: numberOrNull(signal.valuation.current.fdvUsd),
    volume5m: numberOrNull(signal.volume5m.currentUsd),
    tokenAgeMs: numberOrNull(signal.tokenAge.ageMs),
    ...extras,
  });
}
function monitoredCandidate(profile, signal, type) {
  const isVolume = type === 'volume';
  const window = isVolume ? signal.volume5m : signal.valuation.windows['5m'];
  const enabled = isVolume
    ? profile.ruleEnabled.monitoredVol
    : profile.ruleEnabled.monitoredFdv;
  const threshold = numberOrNull(isVolume ? profile.thresholdPct : profile.fdvThresholdPct) || 0;
  const changePct = numberOrNull(window.changePct ?? window.fdvChangePct);
  const fdvChangePct = Number(signal.valuation.windows['5m'].fdvChangePct);
  const ageEligible = isVolume || signal.tokenAge.eligibility.minimum1h === true;
  const invalid = [
    !enabled, !ageEligible, window.coverage !== 'complete',
    changePct == null, changePct < threshold,
    isVolume && Number.isFinite(fdvChangePct) && fdvChangePct < 0,
    !passesProfileFilters(profile, signal),
  ];
  if (invalid.some(Boolean)) return null;
  const current = numberOrNull(isVolume ? window.currentUsd : signal.valuation.current.fdvUsd);
  const previous = numberOrNull(isVolume ? window.baselineUsd : window.fdvUsd);
  const ruleKey = isVolume ? 'monitored-vol' : 'monitored-fdv';
  return Object.freeze({
    ruleKey, kind: ruleKey, label: isVolume ? 'VOL' : 'FDV',
    pct: changePct,
    lastAlertedValue: current,
    cooldownMs: STANDARD_ALERT_COOLDOWN_MS,
    repeatStepPct: threshold,
    fingerprint: `${ruleKey}:${previous}:${current}`,
    payload: payload(signal, isVolume ? { prevVolume5m: previous } : { prevFdv: previous }),
  });
}
function surgeCandidate(profile, signal, spec) {
  const [ruleKey, enabledField, thresholdField, windowName, ageField] = spec;
  const window = signal.valuation.windows[windowName];
  const threshold = numberOrNull(profile[thresholdField]);
  const currentPct = numberOrNull(window.priceChangePct);
  const currentFdv = numberOrNull(signal.valuation.current.fdvUsd) || 0;
  if (!profile.ruleEnabled[enabledField] || threshold == null
    || signal.tokenAge.eligibility[ageField] !== true
    || window.coverage !== 'complete' || currentPct == null || currentPct < threshold
    || currentFdv < SURGE_MIN_FDV[windowName]) return null;
  return Object.freeze({
    ruleKey, kind: 'old-surge', label: `PCHANGE ${windowName.toUpperCase()}`,
    pct: currentPct, lastAlertedValue: currentPct,
    cooldownMs: windowName === '6h' ? 6 * 60 * 60 * 1000 : 0,
    repeatStepPct: null, crossedThreshold: false, primeOnFirstSeen: true,
    fingerprint: `${ruleKey}:${window.baselineAt}:${currentPct}`,
    payload: payload(signal, {
      ageBucket: ageField === 'oldWeekSurge' ? 'old-week' : 'recent',
      prevFdv: numberOrNull(window.fdvUsd),
      priceChangePct: currentPct,
      surgeWindow: windowName.toUpperCase(),
      thresholdPct: threshold,
    }),
  });
}
function buildCandidates(profile, signal) {
  return [
    ...RULE_SPECS.map((spec) => surgeCandidate(profile, signal, spec)),
    monitoredCandidate(profile, signal, 'volume'),
    monitoredCandidate(profile, signal, 'fdv'),
  ].filter(Boolean);
}
function stateIndex(states = []) {
  return new Map(states.map((state) => [`${state.userId}:${state.ruleKey}`, state]));
}

function timestampMs(value) {
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.getTime() : null;
}
function hasBlockingSurge(candidate, userId, indexedStates, nowMs) {
  if (candidate?.kind !== 'old-surge') return false;
  return SURGE_RULE_KEYS.some((ruleKey) => {
    const state = indexedStates.get(`${userId}:${ruleKey}`);
    const lastAlertedAt = timestampMs(state?.lastAlertedAt);
    if (lastAlertedAt == null) return false;
    const elapsed = nowMs - lastAlertedAt;
    if (elapsed < 60 * 60 * 1000) return true;
    if (candidate.payload.surgeWindow === '6H' && ruleKey.endsWith('-6h')
      && elapsed < 6 * 60 * 60 * 1000) return true;
    return numberOrNull(state?.lastAlertedPct) != null
      && !canRepeatSurgeInSession(candidate, state);
  });
}
function continuationPlan(profile, signal, indexedStates, nowMs) {
  const currentFdv = numberOrNull(signal.valuation.current.fdvUsd);
  const change6h = numberOrNull(signal.valuation.windows['6h'].priceChangePct);
  for (const spec of RULE_SPECS.filter((item) => item[3] === '6h')) {
    const [baseRuleKey, enabledField, thresholdField, , ageField] = spec;
    const state = indexedStates.get(`${profile.userId}:${baseRuleKey}`);
    if (!state) continue;
    const metadata = state.metadata || {};
    const baseFdv = numberOrNull(metadata.lastAlertedFdv);
    const baseEventId = numberOrNull(metadata.lastEventId);
    const baseAlertedAt = timestampMs(state.lastAlertedAt);
    const elapsed = baseAlertedAt == null ? null : nowMs - baseAlertedAt;
    if (!profile.ruleEnabled[enabledField] || !signal.tokenAge.eligibility[ageField]
      || !(baseFdv > 0) || !(baseEventId > 0) || !(elapsed >= 60 * 60 * 1000)
      || change6h < numberOrNull(profile?.[thresholdField]) || currentFdv < baseFdv * 3
      || numberOrNull(metadata.surgeContinuation6hLastBaseEventId) === baseEventId) continue;
    return Object.freeze({
      action: 'emit', ruleKey: 'surge-continuation-6h', state,
      candidate: Object.freeze({
        ruleKey: 'surge-continuation-6h', kind: 'old-surge',
        fingerprint: `${baseRuleKey}:${baseEventId}:3x`,
        payload: payload(signal, { baseRuleKey, baseEventId, baseFdv, priceChangePct: change6h }),
      }),
    });
  }
  return null;
}

function assertCanonicalSignal(signal) {
  if (!signal || signal.chain !== CHAIN || signal.valuation.type !== VALUATION_TYPE) {
    throw new Error('Robinhood standard matcher requires a canonical FDV signal');
  }
}

function evaluateRobinhoodStandardSignal(input = {}) {
  const signal = input.signal;
  assertCanonicalSignal(signal);
  const nowMs = new Date(input.now ?? signal.generatedAt).getTime();
  if (!Number.isFinite(nowMs)) throw new Error('Robinhood standard matcher time is invalid');
  const indexedStates = stateIndex(input.states);
  const evaluations = [];
  for (const profile of Array.isArray(input.profiles) ? input.profiles : []) {
    const candidates = buildCandidates(profile, signal);
    const qualified = new Set(candidates.map((candidate) => candidate.ruleKey));
    const primary = candidates[0] || null;
    const plans = [];
    if (primary) {
      const state = indexedStates.get(`${profile.userId}:${primary.ruleKey}`) || null;
      const action = hasBlockingSurge(primary, profile.userId, indexedStates, nowMs)
        ? 'suppress' : getStandardTransition(primary, state, nowMs);
      plans.push(Object.freeze({
        action, candidate: primary, ruleKey: primary.ruleKey, state,
      }));
    }
    for (const ruleKey of STANDARD_RULE_KEYS) {
      if (qualified.has(ruleKey) || !profile.ruleEnabled[ENABLED_FIELD_BY_RULE[ruleKey]]) continue;
      if (SURGE_RULE_KEYS.includes(ruleKey)) continue;
      const state = indexedStates.get(`${profile.userId}:${ruleKey}`) || null;
      if (getStandardTransition(null, state, nowMs) === 'rearm') {
        plans.push(Object.freeze({ action: 'rearm', candidate: null, ruleKey, state }));
      }
    }
    const continuation = continuationPlan(profile, signal, indexedStates, nowMs);
    if (continuation) plans.push(continuation);
    evaluations.push(Object.freeze({ userId: profile.userId, candidates, plans }));
  }
  return Object.freeze({ chain: CHAIN, signalId: signal.id, evaluations: Object.freeze(evaluations) });
}

module.exports = {
  STANDARD_ALERT_COOLDOWN_MS,
  evaluateRobinhoodStandardSignal,
  __private: { buildCandidates, continuationPlan, monitoredCandidate, passesProfileFilters, surgeCandidate },
};
