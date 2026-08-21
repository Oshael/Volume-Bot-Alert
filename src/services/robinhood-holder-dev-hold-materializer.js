const {
  createRobinhoodHolderDistributionMetricRepository,
} = require('../models/robinhood-holder-distribution-metric');
const {
  createRobinhoodHolderDevHoldSource,
} = require('../models/robinhood-holder-dev-hold-source');

function createRobinhoodHolderDevHoldMaterializer(options = {}) {
  const source = options.source || createRobinhoodHolderDevHoldSource(options);
  const metrics = options.metrics
    || createRobinhoodHolderDistributionMetricRepository(options);
  const now = options.now || (() => new Date().toISOString());

  async function materializeToken(tokenAddress) {
    const candidate = await source.loadDevHoldEvidence(tokenAddress);
    if (candidate.status === 'deferred') {
      return Object.freeze({ status: 'deferred', reason: candidate.reason });
    }
    if (candidate.status === 'unavailable') {
      return metrics.replaceMetricSnapshot({
        tokenAddress: candidate.tokenAddress, metric: 'dev_hold', status: 'unavailable',
        statusReason: candidate.reason, evidence: candidate.evidence, observedAt: now(),
      });
    }
    return metrics.replaceMetricSnapshot({
      tokenAddress: candidate.tokenAddress, metric: 'dev_hold', status: 'ready',
      statusReason: 'materialized', valueNumeratorRaw: candidate.creatorBalanceRaw,
      valueDenominatorRaw: candidate.totalSupplyRaw, walletCount: '1', groupCount: null,
      evidence: {
        creator: { address: candidate.creatorAddress, ...candidate.attribution },
        supply: { source: 'robinhood_holder_balances_sum' },
      },
      throughBlockNumber: candidate.frontier.blockNumber,
      throughBlockHash: candidate.frontier.blockHash,
      observedAt: now(),
    });
  }

  return Object.freeze({ materializeToken });
}

module.exports = { createRobinhoodHolderDevHoldMaterializer };
