const SUPPORTED_CHAINS = new Set(['solana', 'robinhood']);

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

module.exports = { selectAlertProfileForChain };
