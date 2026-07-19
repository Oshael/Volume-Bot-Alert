function numberOrNull(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function timestampMs(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.getTime() : null;
}
function isCooldownActive(state, nowMs) {
  const cooldownUntilMs = timestampMs(state?.cooldownUntil);
  return cooldownUntilMs != null && cooldownUntilMs > nowMs;
}
function hasAdvancedRepeatValue(candidate, state) {
  const stepPct = numberOrNull(candidate?.repeatStepPct);
  if (!(stepPct > 0)) return true;
  const previous = numberOrNull(state?.lastAlertedValue);
  const current = numberOrNull(candidate?.lastAlertedValue);
  if (previous == null || current == null) return true;
  return current >= previous * (1 + (stepPct / 100));
}
function surgeRepeatRequirement(candidate, state, options = {}) {
  const primed = state?.metadata?.lastDecision === 'primed-hot'
    && timestampMs(state?.lastAlertedAt) == null;
  const stepPct = primed
    ? numberOrNull(options.primedStepPct) ?? 10
    : numberOrNull(options.postAlertGrowthPct) ?? 50;
  return { primed, stepPct };
}
function hasRequiredSurgePctAdvance(candidate, state, options = {}) {
  const previous = numberOrNull(state?.lastAlertedPct);
  const current = numberOrNull(candidate?.pct);
  if (previous == null || current == null) return false;
  const { primed, stepPct } = surgeRepeatRequirement(candidate, state, options);
  return current >= (primed ? previous + stepPct : previous * (1 + (stepPct / 100)));
}
function canRepeatSurgeInSession(candidate, state, options = {}) {
  if (candidate?.kind !== 'old-surge') return true;
  const { primed } = surgeRepeatRequirement(candidate, state, options);
  if (!primed && candidate?.payload?.surgeWindow === '6H') {
    return candidate?.crossedThreshold === true;
  }
  return hasRequiredSurgePctAdvance(candidate, state, options);
}
function getStandardTransition(candidate, state, nowMs) {
  if (!candidate) {
    return state?.status === 'triggered' && state?.rearmRequired === true ? 'rearm' : 'ignore';
  }
  if (!state && candidate.primeOnFirstSeen === true) return 'prime';
  if (isCooldownActive(state, nowMs)) return 'suppress';
  if (candidate.kind === 'old-surge') {
    return state && !canRepeatSurgeInSession(candidate, state) ? 'suppress' : 'emit';
  }
  return state && !hasAdvancedRepeatValue(candidate, state) ? 'suppress' : 'emit';
}

module.exports = {
  canRepeatSurgeInSession,
  getStandardTransition,
  hasAdvancedRepeatValue,
  hasRequiredSurgePctAdvance,
  isCooldownActive,
};
