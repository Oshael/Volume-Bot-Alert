const {
  CHAIN,
  STANDARD_RULE_KEYS,
  VALUATION_TYPE,
} = require('./robinhood-standard-alert-contract');
const standardAlertReset = require('./standard-alert-reset');
const {
  isCatalogFdvExcluded,
} = require('./robinhood-catalog-fdv-policy');
const {
  canRepeatSurgeInSession,
  getStandardTransition,
} = require('./standard-alert-transition');
const { selectEnabledAlertProfilesForChain } = require('./chain-alert-profile');
const STANDARD_ALERT_COOLDOWN_MS = 60 * 1000;
const SURGE_STARTUP_SUPPRESS_MS = 60 * 1000;
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
const ROBINHOOD_SURGE_VALUATION_KEYS = Object.freeze({
  lastAlerted: 'lastAlertedFdv',
  high: 'surgePostAlertHighFdv',
  interrupted: 'surgeResetDrawdownInterruptedFdv',
});
function numberOrNull(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
function finiteNumberOrNull(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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
    volume1h: numberOrNull(signal.volumeWindows?.['1h']?.usd),
    volume6h: numberOrNull(signal.volumeWindows?.['6h']?.usd),
    volume24h: numberOrNull(signal.volumeWindows?.['24h']?.usd),
    tokenAgeMs: numberOrNull(signal.tokenAge.ageMs),
    tokenCreatedAt: timestampMs(signal.tokenAge.createdAt),
    ...extras,
  });
}
function presence(profile) {
  return {
    presenceMode: profile.presenceMode || null,
    hiddenSessionKey: profile.hiddenSessionKey || null,
  };
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
    ...presence(profile),
    payload: payload(signal, isVolume ? { prevVolume5m: previous } : { prevFdv: previous }),
  });
}
function surgeCandidate(profile, signal, spec) {
  const [ruleKey, enabledField, thresholdField, windowName, ageField] = spec;
  const window = signal.valuation.windows[windowName];
  const threshold = numberOrNull(profile[thresholdField]);
  const currentPct = numberOrNull(window.priceChangePct);
  const previousPct = finiteNumberOrNull(window.previousPriceChangePct);
  const crossedThreshold = previousPct != null && previousPct < threshold && currentPct >= threshold;
  const currentFdv = numberOrNull(signal.valuation.current.fdvUsd) || 0;
  if (!profile.ruleEnabled[enabledField] || threshold == null
    || signal.tokenAge.eligibility[ageField] !== true
    || window.coverage !== 'complete' || currentPct == null || currentPct < threshold
    || currentFdv < SURGE_MIN_FDV[windowName]) return null;
  return Object.freeze({
    ruleKey, kind: 'old-surge', label: `PCHANGE ${windowName.toUpperCase()}`,
    pct: currentPct, lastAlertedValue: currentPct,
    cooldownMs: windowName === '6h' ? 6 * 60 * 60 * 1000 : 0,
    repeatStepPct: null, crossedThreshold, primeOnFirstSeen: false,
    startupSuppressUntilMs: timestampMs(profile.loadedAt) == null
      ? null : timestampMs(profile.loadedAt) + SURGE_STARTUP_SUPPRESS_MS,
    sessionStartedAt: profile.loadedAt || null,
    fingerprint: `${ruleKey}:${window.baselineAt}:${previousPct}:${currentPct}`,
    ...presence(profile),
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
  if (isCatalogFdvExcluded(signal.valuation.current.fdvUsd)) return [];
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
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.getTime() : null;
}
function surgeThreshold(profile, ruleKey) {
  const spec = RULE_SPECS.find((item) => item[0] === ruleKey);
  return spec ? numberOrNull(profile[spec[2]]) : null;
}
function isPreparedStateExpired(ruleKey, state, nowMs) {
  if (!state) return false;
  if (ruleKey === 'monitored-vol') {
    return standardAlertReset.isMonitoredVolAnchorExpired({ ruleKey }, state, nowMs);
  }
  const lastAlertedAtMs = timestampMs(state.lastAlertedAt);
  const cooldownActive = ruleKey.endsWith('-6h') && lastAlertedAtMs != null
    && nowMs - lastAlertedAtMs < 6 * 60 * 60 * 1000;
  return standardAlertReset.isSurgeAnchorExpired(
    { ruleKey }, state, nowMs, { cooldownActive },
  );
}
function prepareRuleState(profile, signal, ruleKey, state, nowMs) {
  if (!state) return { state: null, changed: false, expired: false };
  if (isPreparedStateExpired(ruleKey, state, nowMs)) {
    return { state, changed: false, expired: true };
  }
  let reset = { metadata: state.metadata || {}, changed: false };
  if (ruleKey === 'monitored-vol' && ['triggered', 'rearmed'].includes(state.status)) {
    reset = standardAlertReset.buildMonitoredVolColdMetadata(
      state, signal.volume5m.currentUsd, nowMs,
    );
  } else if (SURGE_RULE_KEYS.includes(ruleKey) && state.status === 'rearmed') {
    reset = standardAlertReset.buildSurgeResetMetadata({
      ruleKey, thresholdPct: surgeThreshold(profile, ruleKey), state, nowMs,
      observation: {
        valuation: signal.valuation.current.fdvUsd,
        priceChange1h: signal.valuation.windows['1h'].priceChangePct,
        priceChange6h: signal.valuation.windows['6h'].priceChangePct,
      },
      valuationKeys: ROBINHOOD_SURGE_VALUATION_KEYS,
    });
  }
  const prepared = reset.changed ? { ...state, metadata: reset.metadata } : state;
  return {
    state: prepared,
    changed: reset.changed,
    expired: isPreparedStateExpired(ruleKey, prepared, nowMs),
  };
}
function resolveCandidateState(candidate, prepared, profile) {
  if (prepared.expired) return null;
  const state = prepared.state;
  if (candidate?.kind !== 'old-surge' || !state) return state;
  const primed = state.metadata?.lastDecision === 'primed-hot' && timestampMs(state.lastAlertedAt) == null;
  const sameSession = profile.loadedAt && state.metadata?.sessionStartedAt === profile.loadedAt;
  return primed && !sameSession ? null : state;
}
function transition(candidate, state, profile, nowMs) {
  if (!state && candidate?.kind === 'old-surge'
    && numberOrNull(candidate.startupSuppressUntilMs) > nowMs) return 'prime';
  if (profile.presenceMode === 'hidden' && timestampMs(state?.lastAlertedAt) != null
    && state?.metadata?.lastPresenceMode === 'hidden') return 'suppress';
  return getStandardTransition(candidate, state, nowMs);
}
function hasBlockingSurge(candidate, userId, effectiveStates, nowMs) {
  if (candidate?.kind !== 'old-surge') return false;
  return SURGE_RULE_KEYS.some((ruleKey) => {
    const state = effectiveStates.get(`${userId}:${ruleKey}`);
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
    const threshold = numberOrNull(profile?.[thresholdField]);
    if (!profile.ruleEnabled[enabledField] || !signal.tokenAge.eligibility[ageField]
      || !(baseFdv > 0) || !(baseEventId > 0) || !(elapsed >= 60 * 60 * 1000)
      || change6h < threshold || currentFdv < baseFdv * 3
      || numberOrNull(metadata.surgeContinuation6hLastBaseEventId) === baseEventId) continue;
    const multiplier = currentFdv / baseFdv;
    return Object.freeze({
      action: 'emit', ruleKey: 'surge-continuation-6h', state,
      candidate: Object.freeze({
        ruleKey: 'surge-continuation-6h', kind: 'old-surge',
        label: 'SURGE CONTINUATION 6H', pct: change6h,
        fingerprint: `${baseRuleKey}:${baseEventId}:3x`,
        ...presence(profile),
        payload: payload(signal, {
          prevFdv: baseFdv, priceChangePct: change6h,
          ageBucket: ageField === 'oldWeekSurge' ? 'old-week' : 'recent',
          isOldSurge: true, surgeWindow: '6H', thresholdPct: threshold,
          surgeContinuation: true,
          surgeContinuationBaseEventId: baseEventId,
          surgeContinuationBaseRuleKey: baseRuleKey,
          surgeContinuationBaseFdv: baseFdv,
          surgeContinuationMultiplier: multiplier,
          surgeContinuationRequiredMultiplier: 3,
        }),
      }),
    });
  }
  return null;
}

function prepareProfileStates(profile, signal, indexedStates, nowMs) {
  const byRule = new Map();
  const effective = new Map(indexedStates);
  const prepared = new Map(indexedStates);
  for (const ruleKey of STANDARD_RULE_KEYS) {
    const key = `${profile.userId}:${ruleKey}`;
    const result = prepareRuleState(profile, signal, ruleKey, indexedStates.get(key) || null, nowMs);
    byRule.set(ruleKey, result);
    effective.set(key, result.expired ? null : result.state);
    prepared.set(key, result.state);
  }
  return { byRule, effective, prepared };
}

function appendPrimaryPlan(plans, input) {
  const { primary, profile, states, nowMs } = input;
  if (!primary) return;
  const prepared = states.byRule.get(primary.ruleKey);
  const state = resolveCandidateState(primary, prepared, profile);
  const decision = transition(primary, state, profile, nowMs);
  const blocked = decision !== 'prime'
    && hasBlockingSurge(primary, profile.userId, states.effective, nowMs);
  const action = blocked ? 'suppress' : decision;
  plans.push(Object.freeze({ action, candidate: primary, ruleKey: primary.ruleKey, state }));
  if (prepared.changed && !prepared.expired && action === 'suppress') {
    plans.push(Object.freeze({
      action: 'rearm', candidate: null, ruleKey: primary.ruleKey, state: prepared.state,
    }));
  }
}

function appendInactiveRulePlans(plans, input) {
  const { profile, qualified, states, nowMs } = input;
  for (const ruleKey of STANDARD_RULE_KEYS) {
    if (qualified.has(ruleKey) || !profile.ruleEnabled[ENABLED_FIELD_BY_RULE[ruleKey]]) continue;
    const prepared = states.byRule.get(ruleKey);
    if (SURGE_RULE_KEYS.includes(ruleKey)) {
      if (prepared.changed && !prepared.expired) {
        plans.push(Object.freeze({
          action: 'rearm', candidate: null, ruleKey, state: prepared.state,
        }));
      }
      continue;
    }
    const shouldRearm = getStandardTransition(null, prepared.state, nowMs) === 'rearm';
    if (shouldRearm || (prepared.changed && !prepared.expired)) {
      plans.push(Object.freeze({
        action: 'rearm', candidate: null, ruleKey, state: prepared.state,
      }));
    }
  }
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
  const profiles = selectEnabledAlertProfilesForChain(input.profiles, CHAIN);
  for (const profile of profiles) {
    const candidates = buildCandidates(profile, signal);
    const qualified = new Set(candidates.map((candidate) => candidate.ruleKey));
    const primary = candidates[0] || null;
    const states = prepareProfileStates(profile, signal, indexedStates, nowMs);
    const plans = [];
    appendPrimaryPlan(plans, { primary, profile, states, nowMs });
    appendInactiveRulePlans(plans, { profile, qualified, states, nowMs });
    const continuation = continuationPlan(profile, signal, states.prepared, nowMs);
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
