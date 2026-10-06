const db = require('../models/db');
const { createRobinhoodRadarGainersReadRepository } = require('../models/robinhood-radar-gainers-read');
const { createRobinhoodWorkspaceWindowReadRepository } = require('../models/robinhood-workspace-window-read');
const { createRobinhoodTokenHolderSummaryRepository } = require('../models/robinhood-token-holder-summary');
const { normalizeRobinhoodHolderSummary } = require('../utils/robinhood-holder-summary-view');

const TIMEOUT_MS = 5000;

function holderFields(summary, asOf) {
  const future = [summary?.observedAt, summary?.checkedAt]
    .some((value) => value != null && Date.parse(value) > Date.parse(asOf));
  return { holderSource: summary?.source ?? null,
    ...normalizeRobinhoodHolderSummary({
      holder_count: future ? null : summary?.holderCount,
      holder_source: summary?.source,
      holder_observed_at: summary?.observedAt, holder_checked_at: summary?.checkedAt,
    }, asOf),
    holderUnavailableReason: future ? 'snapshot_after_as_of' : (summary ? null : 'snapshot_missing') };
}

function metricFields(metrics, asOf) {
  if (!metrics || metrics.chain !== 'robinhood' || metrics.windowEnd !== asOf) {
    throw new Error('gainers metrics do not match the ranking cutoff');
  }
  const future = metrics.liquidityProjectionCommittedAt != null
    && Date.parse(metrics.liquidityProjectionCommittedAt) > Date.parse(asOf);
  return {
    volume24hUsd: metrics.volume24hUsd, volume24hCoverage: metrics.coverage['24h'],
    volume24hChangePct: null, volume24hChangeCoverage: 'unavailable',
    liquidityUsd: future ? null : metrics.liquidityUsd,
    liquidityCoverage: future ? 'unavailable' : metrics.liquidityCoverage,
    liquidityProjectionCommittedAt: metrics.liquidityProjectionCommittedAt,
    liquidityMarketCount: metrics.liquidityMarketCount,
    valuedLiquidityMarketCount: future ? 0 : metrics.valuedLiquidityMarketCount,
  };
}

function createRobinhoodRadarGainersService(options = {}) {
  const database = options.database || db;
  const ranking = options.ranking || createRobinhoodRadarGainersReadRepository({ database });
  const windows = options.windows || createRobinhoodWorkspaceWindowReadRepository({ database });
  const holders = options.holders || createRobinhoodTokenHolderSummaryRepository({ database: {
    query: (sql, params) => database.queryWithStatementTimeout(sql, params, TIMEOUT_MS),
  } });
  return {
    async getGainers(input = {}) {
      const page = await ranking.getGainers(input);
      if (!page.items.length) return page;
      if (page.items.length > 20) throw new Error('gainers hydration exceeds the bounded top');
      const addresses = page.items.map((item) => item.identity.address);
      const metrics = await windows.getMetricsByAddresses({
        addresses, asOf: page.asOf, statementTimeoutMs: TIMEOUT_MS,
      });
      const summaries = await holders.getPublishedSummaries(addresses);
      const byAddress = new Map(metrics.map((item) => [item.address, item]));
      const holderByAddress = new Map(summaries.map((item) => [item.tokenAddress, item]));
      return { ...page, items: page.items.map((item) => ({
        ...item, ...metricFields(byAddress.get(item.identity.address), page.asOf),
        ...holderFields(holderByAddress.get(item.identity.address), page.asOf),
      })) };
    },
  };
}
module.exports = { createRobinhoodRadarGainersService };
