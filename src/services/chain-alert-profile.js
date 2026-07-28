const SUPPORTED_CHAINS = new Set(['solana', 'robinhood']);

function isAlertProfileEnabledForChain(profile, chain) {
  if (!profile || !SUPPORTED_CHAINS.has(chain)) return false;
  if (!Object.prototype.hasOwnProperty.call(profile, 'enabledChains')) return true;
  if (!Array.isArray(profile.enabledChains)) return false;
  return profile.enabledChains.includes(chain);
}

function selectAlertProfileForChain(profile, chain) {
  if (!profile || !SUPPORTED_CHAINS.has(chain)) {
    return profile;
  }

  const scoped = profile.alertConfigByChain?.[chain];
  if (!scoped || typeof scoped !== 'object' || Array.isArray(scoped)) {
    return profile;
  }

  return {
    ...profile,
    ...scoped,
    ruleEnabled: { ...(scoped.ruleEnabled || {}) },
  };
}

function selectEnabledAlertProfilesForChain(profiles, chain) {
  return (Array.isArray(profiles) ? profiles : [])
    .filter((profile) => isAlertProfileEnabledForChain(profile, chain))
    .map((profile) => selectAlertProfileForChain(profile, chain));
}

module.exports = {
  isAlertProfileEnabledForChain,
  selectAlertProfileForChain,
  selectEnabledAlertProfilesForChain,
};
