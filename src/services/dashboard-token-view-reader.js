const userBlocklist = require('../models/user-blocklist');
const { createRobinhoodWorkspaceTokenReader } = require('./robinhood-workspace-token-reader');
const workspaceChainReadiness = require('./workspace-chain-readiness');
const { buildDashboardMonitoredToken } = require('./dashboard-monitored-response');
const { MAX_CATALOG_FDV_USD } = require('./robinhood-catalog-fdv-policy');
const { normalizeTokenViewRequest } = require('./token-view-contract');
const { DEFAULT_POLICY, SCORE_VERSION, rankTrendingTokens } = require('./trending-token-score');

const TRENDING_CANDIDATE_LIMIT = 500;

function createRobinhoodTrendingAdapter(options = {}) {
  const reader = options.tokenReader || createRobinhoodWorkspaceTokenReader();
  async function listTrending(input) {
    const blocked = (input.excludedIdentities || [])
      .filter((item) => item.chain === 'robinhood').map((item) => item.address);
    const prefix = await reader.listMonitoredPrefix({
      asOf: input.asOf,
      page: (TRENDING_CANDIDATE_LIMIT / 100) - 1,
      perPage: 100,
      sorts: [{ mode: 'vol', window: '24h' }],
      minFdv: DEFAULT_POLICY.minValuationUsd,
      maxFdv: MAX_CATALOG_FDV_USD,
      excludedAddresses: blocked,
    });
    return prefix.rows;
  }
  return Object.freeze({ chain: 'robinhood', listTrending });
}

function resolveChainState(readiness) {
  if (readiness?.status === 'ready' && readiness.capabilities?.monitored === true) return 'ready';
  return readiness?.status === 'syncing' ? 'syncing' : 'unavailable';
}

function createDashboardTokenViewReader(options = {}) {
  const adapters = options.adapters || { robinhood: createRobinhoodTrendingAdapter(options) };
  const blocklist = options.userBlocklist || userBlocklist;
  const readinessReader = options.workspaceChainReadiness || workspaceChainReadiness;

  async function listTokenView(input = {}) {
    const request = normalizeTokenViewRequest(input);
    if (request.view !== 'trending') {
      const error = new Error(`${request.view} token view is not implemented`);
      error.status = 501;
      throw error;
    }
    const readiness = await readinessReader.getWorkspaceChainReadiness();
    const chainStates = Object.fromEntries(request.chains.map((chain) => [chain, {
      status: adapters[chain]?.listTrending ? resolveChainState(readiness[chain]) : 'unavailable',
      capabilities: { trending: Boolean(adapters[chain]?.listTrending) },
    }]));
    if (Object.values(chainStates).some((state) => state.status !== 'ready')) {
      const status = Object.values(chainStates).some((state) => state.status === 'unavailable')
        ? 'unavailable' : 'syncing';
      return { ...request, scoreVersion: SCORE_VERSION, status,
        generatedAt: request.asOf, candidatesConsidered: 0, count: 0, chainStates, tokens: [] };
    }
    const excludedIdentities = await blocklist.getAllForChains(input.userId, request.chains);
    const groups = await Promise.all(request.chains.map((chain) => adapters[chain].listTrending({
      ...request, excludedIdentities,
    })));
    const ranked = rankTrendingTokens(groups.flat(), request);
    return {
      ...request,
      scoreVersion: SCORE_VERSION,
      status: 'ready',
      generatedAt: request.asOf,
      candidatesConsidered: groups.flat().length,
      count: ranked.length,
      chainStates,
      tokens: ranked.map((item, index) => ({
        ...buildDashboardMonitoredToken(item.row),
        trendingRank: index + 1,
        scoreVersion: SCORE_VERSION,
        score: item.score,
        components: item.components,
      })),
    };
  }
  return Object.freeze({ listTokenView });
}

const dashboardTokenViewReader = createDashboardTokenViewReader();

module.exports = {
  ...dashboardTokenViewReader,
  createDashboardTokenViewReader,
  createRobinhoodTrendingAdapter,
};
