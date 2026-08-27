const {
  createRobinhoodHolderDistributionMetricRepository,
} = require('../models/robinhood-holder-distribution-metric');
const {
  createRobinhoodHolderTopDistributionSource,
} = require('../models/robinhood-holder-top-distribution-source');

const TOP_METRICS = Object.freeze([
  Object.freeze({ metric: 'top10', field: 'top10', limit: 10 }),
  Object.freeze({ metric: 'top50', field: 'top50', limit: 50 }),
]);

function createRobinhoodHolderTopDistributionMaterializer(options = {}) {
  const source = options.source || createRobinhoodHolderTopDistributionSource(options);
  const metrics = options.metrics
    || createRobinhoodHolderDistributionMetricRepository(options);
  const now = options.now || (() => new Date().toISOString());

  async function publishMetric(candidate, definition, observedAt) {
    if (candidate.status === 'unavailable') {
      return metrics.replaceMetricSnapshot({
        tokenAddress: candidate.tokenAddress, metric: definition.metric,
        status: 'unavailable', statusReason: candidate.reason,
        evidence: candidate.evidence, observedAt,
      });
    }
    const value = candidate[definition.field];
    return metrics.replaceMetricSnapshot({
      tokenAddress: candidate.tokenAddress, metric: definition.metric, status: 'ready',
      statusReason: 'materialized', valueNumeratorRaw: value.balanceRaw,
      valueDenominatorRaw: candidate.totalSupplyRaw, walletCount: value.walletCount,
      groupCount: null,
      evidence: {
        source: 'robinhood_holder_balances',
        selection: {
          limit: definition.limit,
          order: ['balance_raw_desc', 'wallet_address_asc'],
        },
        denominator: { source: 'robinhood_holder_balances_sum' },
      },
      throughBlockNumber: candidate.frontier.blockNumber,
      throughBlockHash: candidate.frontier.blockHash,
      observedAt,
    });
  }

  async function materializeToken(tokenAddress) {
    const candidate = await source.loadTopDistribution(tokenAddress);
    if (candidate.status === 'deferred') {
      return Object.freeze({ status: 'deferred', reason: candidate.reason });
    }
    const observedAt = now();
    const results = await Promise.all(TOP_METRICS.map((definition) => (
      publishMetric(candidate, definition, observedAt)
    )));
    return Object.freeze({
      status: results.every(({ status }) => status === 'unchanged')
        ? 'unchanged' : 'published',
      metrics: Object.freeze(results),
    });
  }

  return Object.freeze({ materializeToken });
}

module.exports = { createRobinhoodHolderTopDistributionMaterializer };
