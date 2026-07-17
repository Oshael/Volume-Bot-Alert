const robinhoodCatalog = require('../models/robinhood-catalog');

function blocked(reason) {
  return Object.freeze({ status: 'blocked', reason, staged: false });
}

function validateDecision(candidate, decision) {
  if (decision?.chain !== 'robinhood' || candidate?.chain !== 'robinhood') {
    throw new Error('Robinhood catalog projection requires Robinhood identities');
  }
  if (decision.tokenAddress !== candidate.tokenAddress) {
    throw new Error('Robinhood catalog decision token does not match candidate');
  }
  if (decision.marketKey !== candidate.marketKey || decision.protocol !== candidate.protocol) {
    throw new Error('Robinhood catalog decision market does not match candidate');
  }
}

function createRobinhoodCatalogProjector(options = {}) {
  const catalog = options.catalog || robinhoodCatalog;

  async function stage(candidate, decision, rollout = {}) {
    if (rollout.alertsRequested !== true) return blocked('alerts_disabled');
    if (rollout.publishable !== true) return blocked('rollout_not_publishable');
    if (decision?.publishable !== true) return blocked('decision_not_publishable');
    if (decision?.expectedSignal !== true) return blocked('signal_suppressed');

    validateDecision(candidate, decision);
    const row = await catalog.stageSnapshot(candidate);
    return Object.freeze({
      status: 'staged',
      reason: null,
      staged: true,
      chain: 'robinhood',
      address: candidate.tokenAddress,
      row,
    });
  }

  return Object.freeze({ stage });
}

module.exports = {
  createRobinhoodCatalogProjector,
  __private: { validateDecision },
};
