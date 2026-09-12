const userBlocklist = require('../models/user-blocklist');
const {
  createTokenLaunchpadLifecycleRepository,
} = require('../models/token-launchpad-lifecycle');
const { createRobinhoodWorkspaceTokenReader } = require('./robinhood-workspace-token-reader');
const workspaceChainReadiness = require('./workspace-chain-readiness');
const { buildDashboardMonitoredToken } = require('./dashboard-monitored-response');
const { MAX_CATALOG_FDV_USD } = require('./robinhood-catalog-fdv-policy');
const { normalizeTokenViewRequest } = require('./token-view-contract');
const { DEFAULT_POLICY, SCORE_VERSION, rankTrendingTokens } = require('./trending-token-score');
const {
  LIFECYCLE_RANK_VERSION, rankLifecycleTokens,
} = require('./lifecycle-token-ranking');

const TRENDING_CANDIDATE_LIMIT = 500;
const VIEW_METHODS = Object.freeze({
  trending: 'listTrending', migrated: 'listMigrated', pre_bonded: 'listPreBonded',
});

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

function createRobinhoodLifecycleAdapter(options = {}) {
  const reader = options.tokenReader || createRobinhoodWorkspaceTokenReader();
  const lifecycle = options.lifecycleRepository || createTokenLaunchpadLifecycleRepository();
  async function list(status, input) {
    const blocked = new Set((input.excludedIdentities || [])
      .filter((item) => item.chain === 'robinhood').map((item) => item.address));
    const candidates = (await lifecycle.listCandidates({
      chain: 'robinhood', status, limit: TRENDING_CANDIDATE_LIMIT,
    })).filter((item) => !blocked.has(item.tokenAddress));
    const rows = await reader.getTokensByAddresses({
      addresses: candidates.map((item) => item.tokenAddress), asOf: input.asOf,
    });
    const rowsByAddress = new Map(rows.map((row) => [row.identity.address, row]));
    return candidates.map((item) => ({
      lifecycle: item, row: rowsByAddress.get(item.tokenAddress),
    })).filter((item) => item.row);
  }
  return Object.freeze({
    chain: 'robinhood',
    listMigrated: (input) => list('migrated', input),
    listPreBonded: (input) => list('pre_bonded', input),
  });
}

function resolveChainState(readiness, adapter, view) {
  if (!adapter?.[VIEW_METHODS[view]]) return 'unsupported';
  const capable = view === 'trending' ? readiness?.capabilities?.monitored
    : (readiness?.capabilities?.launchpadLifecycle ?? readiness?.capabilities?.monitored);
  if (readiness?.status === 'ready' && capable === true) return 'ready';
  return readiness?.status === 'syncing' ? 'syncing' : 'unavailable';
}

function aggregateStatus(chainStates) {
  const statuses = Object.values(chainStates).map((state) => state.status);
  return ['unsupported', 'unavailable', 'syncing'].find((status) => statuses.includes(status))
    || 'ready';
}

function defaultAdapters(options) {
  const tokenReader = options.tokenReader || createRobinhoodWorkspaceTokenReader();
  return { robinhood: {
    ...createRobinhoodTrendingAdapter({ ...options, tokenReader }),
    ...createRobinhoodLifecycleAdapter({ ...options, tokenReader }),
  } };
}

function createDashboardTokenViewReader(options = {}) {
  const adapters = options.adapters || defaultAdapters(options);
  const blocklist = options.userBlocklist || userBlocklist;
  const readinessReader = options.workspaceChainReadiness || workspaceChainReadiness;

  async function listTokenView(input = {}) {
    const request = normalizeTokenViewRequest(input);
    if (!VIEW_METHODS[request.view]) {
      const error = new Error(`${request.view} token view is not implemented`);
      error.status = 501;
      throw error;
    }
    const readiness = await readinessReader.getWorkspaceChainReadiness();
    const chainStates = Object.fromEntries(request.chains.map((chain) => [chain, {
      status: resolveChainState(readiness[chain], adapters[chain], request.view),
      capabilities: Object.fromEntries(Object.entries(VIEW_METHODS).map(([view, method]) => (
        [view, Boolean(adapters[chain]?.[method])]
      ))),
    }]));
    const status = aggregateStatus(chainStates);
    const rankingVersion = request.view === 'trending' ? SCORE_VERSION : LIFECYCLE_RANK_VERSION;
    if (status !== 'ready') {
      return { ...request, rankingVersion,
        ...(request.view === 'trending' ? { scoreVersion: SCORE_VERSION } : {}), status,
        generatedAt: request.asOf, candidatesConsidered: 0, count: 0, chainStates, tokens: [] };
    }
    const excludedIdentities = await blocklist.getAllForChains(input.userId, request.chains);
    const method = VIEW_METHODS[request.view];
    const groups = await Promise.all(request.chains.map((chain) => adapters[chain][method]({
      ...request, excludedIdentities,
    })));
    const candidates = groups.flat();
    const ranked = request.view === 'trending'
      ? rankTrendingTokens(candidates, request)
      : rankLifecycleTokens(candidates, request);
    return {
      ...request,
      rankingVersion,
      ...(request.view === 'trending' ? { scoreVersion: SCORE_VERSION } : {}),
      status: 'ready',
      generatedAt: request.asOf,
      candidatesConsidered: candidates.length,
      count: ranked.length,
      chainStates,
      tokens: ranked.map((item, index) => request.view === 'trending' ? ({
        ...buildDashboardMonitoredToken(item.row), trendingRank: index + 1,
        scoreVersion: SCORE_VERSION, score: item.score, components: item.components,
      }) : ({
        ...buildDashboardMonitoredToken(item.row), lifecycleRank: index + 1,
        rankingVersion: LIFECYCLE_RANK_VERSION, lifecycle: item.lifecycle,
      })),
    };
  }
  return Object.freeze({ listTokenView });
}

const dashboardTokenViewReader = createDashboardTokenViewReader();

module.exports = {
  ...dashboardTokenViewReader,
  createDashboardTokenViewReader,
  createRobinhoodLifecycleAdapter,
  createRobinhoodTrendingAdapter,
};
