const config = require('../../config');
const { isRobinhoodUserVisible } = require('../utils/token-chain-availability');
const { getBackendAlertRule } = require('../services/backend-alert-rules');

function isChainOrIdentityField(key) {
  const normalized = String(key || '').trim();
  return /chains?$/i.test(normalized) || /identit/i.test(normalized);
}

function isRuleKeyField(key) {
  return /rulekeys?$/i.test(String(key || '').trim());
}

function ruleIsRobinhoodOnly(value) {
  const rule = getBackendAlertRule(value);
  if (!rule) return String(value || '').trim().toLowerCase().startsWith('robinhood-');
  const chains = Array.isArray(rule.chains) ? rule.chains : [rule.chain || 'solana'];
  return chains.length > 0 && chains.every((chain) => chain === 'robinhood');
}

function stringReferencesRobinhood(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'robinhood' || normalized.startsWith('robinhood:')) {
    return true;
  }
  return normalized.split(/[\s,[\]"']+/).includes('robinhood');
}

function referencesRobinhood(value, fieldName = '') {
  if (Array.isArray(value)) {
    return value.some((item) => referencesRobinhood(item, fieldName));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([key, item]) => referencesRobinhood(item, key));
  }
  return (
    isChainOrIdentityField(fieldName)
      && typeof value === 'string'
      && stringReferencesRobinhood(value)
  ) || (
    isRuleKeyField(fieldName)
      && typeof value === 'string'
      && String(value).split(',').some(ruleIsRobinhoodOnly)
  );
}

function createTokenChainVisibilityMiddleware(runtimeConfig = config) {
  return function rejectHiddenRobinhoodRequests(req, res, next) {
    if (isRobinhoodUserVisible(runtimeConfig)) {
      return next();
    }
    if (referencesRobinhood(req.query) || referencesRobinhood(req.body)) {
      return res.status(400).json({
        error: 'Requested chain is not available',
        code: 'CHAIN_NOT_AVAILABLE',
      });
    }
    return next();
  };
}

const rejectHiddenRobinhoodRequests = createTokenChainVisibilityMiddleware();

module.exports = {
  createTokenChainVisibilityMiddleware,
  rejectHiddenRobinhoodRequests,
  __private: { referencesRobinhood, ruleIsRobinhoodOnly, stringReferencesRobinhood },
};
