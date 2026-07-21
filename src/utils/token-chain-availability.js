const DEFAULT_TOKEN_CHAINS = Object.freeze(['solana']);

function isRobinhoodTokenChainConfigured(runtimeConfig = {}) {
  return Boolean(
    runtimeConfig.robinhoodIngestionWorker?.enabled
    || runtimeConfig.robinhoodRollout?.transport?.enabled
    || runtimeConfig.robinhoodRollout?.persistence?.enabled
    || runtimeConfig.robinhoodRollout?.alerts?.requested
  );
}

function isRobinhoodUserVisible(runtimeConfig = {}) {
  return runtimeConfig.robinhoodUserVisibility?.enabled === true;
}

function isTokenChainUserVisible(chain, runtimeConfig = {}) {
  return chain !== 'robinhood' || isRobinhoodUserVisible(runtimeConfig);
}

function getAvailableTokenChains(options = {}) {
  const chains = [...DEFAULT_TOKEN_CHAINS];
  if (
    options.robinhoodVisible === true
  ) {
    chains.push('robinhood');
  }
  return chains;
}

module.exports = {
  getAvailableTokenChains,
  isRobinhoodTokenChainConfigured,
  isRobinhoodUserVisible,
  isTokenChainUserVisible,
};
