const { expect, test } = require('@playwright/test');

const SOLANA_MANUAL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOLANA_MONITORED = 'So11111111111111111111111111111111111111112';
const SOLANA_TOP = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const SOLANA_BLOCKED = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6QXgB263vZyVfSRm';
const ROBINHOOD_TOKEN = '0xabcdef0123456789abcdef0123456789abcdef01';
const ROBINHOOD_POOL = '0xa70fc67c9f69da90b63a0e4c05d229954574e313';
const ROBINHOOD_TOP = '0xabcdef0123456789abcdef0123456789abcdef02';
const ROBINHOOD_MANUAL = '0xabcdef0123456789abcdef0123456789abcdef03';
const ROBINHOOD_OLD = '0xabcdef0123456789abcdef0123456789abcdef04';
const ROBINHOOD_DEV = `0x${'2'.repeat(40)}`;

const SOLANA_CAPABILITIES = {
  alertFeed: true,
  radar: true,
  monitored: true,
  topPerformers: true,
  manualTokens: true,
  starred: true,
  blocklist: true,
  history: true,
  customAlerts: true,
  charts: true,
  explorerLinks: true,
  tradeLinks: true,
  mockTrading: false,
  solanaNative: true,
};

const SOLANA_READINESS = {
  chain: 'solana',
  status: 'ready',
  phase: 'ready',
  publicationReady: true,
  workspaceReady: true,
  checkedAt: '2026-07-14T18:00:00.000Z',
  blockers: [],
  message: 'Solana workspace data is ready.',
  capabilities: SOLANA_CAPABILITIES,
};

const ROBINHOOD_READINESS = {
  chain: 'robinhood',
  status: 'syncing',
  phase: 'dry-run-ready',
  publicationReady: false,
  workspaceReady: false,
  checkedAt: '2026-07-14T18:00:00.000Z',
  blockers: ['ingestion_not_caught_up'],
  message: 'Robinhood is syncing market coverage. Solana data is hidden.',
  capabilities: {
    ...Object.fromEntries(Object.keys(SOLANA_CAPABILITIES).map((key) => [key, false])),
    manualTokens: true,
    starred: true,
    blocklist: true,
  },
};

const ROBINHOOD_MARKET_READINESS = {
  ...ROBINHOOD_READINESS,
  status: 'ready',
  blockers: ['alerts_disabled'],
  message: 'Robinhood monitored and top-performer market data is ready.',
  capabilities: {
    ...ROBINHOOD_READINESS.capabilities,
    monitored: true,
    topPerformers: true,
    history: true,
    charts: true,
    explorerLinks: true,
  },
};

const SMOKE_CONFIG = {
  configs: {},
  uiPrefs: {
    chainFilters: {
      enabledChains: ['solana'],
      radarChains: ['solana'],
      alertFeedChains: ['solana'],
      browserNotificationChains: ['solana'],
    },
    enabledTradeTerminals: ['axiom', 'photon', 'bullx', 'gmgn', 'padre', 'fomo'],
    enabledRobinhoodTradeTerminals: ['axiom', 'gmgn', 'padre', 'fomo'],
  },
  tokens: [],
  blocklist: [],
  starredTokens: [],
  availableChains: ['solana'],
  chainReadiness: { solana: SOLANA_READINESS },
  runtimeFlags: {
    mockTradingEnabled: false,
  },
};

const API_FIXTURES = {
  'GET /api/auth/me': {
    user: {
      id: 1,
      username: 'smoke_user',
      email: 'smoke@example.test',
      role: 'user',
      isActive: true,
      isEmailVerified: true,
      emailVerifiedAt: '2026-07-14T00:00:00.000Z',
    },
  },
  'GET /api/account/access': {
    accessStatus: 'active',
    accessGrantedAt: '2026-07-14T00:00:00.000Z',
    accessExpiresAt: null,
    accessSource: 'manual',
    accessUpdatedAt: '2026-07-14T00:00:00.000Z',
    isExpired: false,
    isTimed: false,
    hasProductAccess: true,
    denialReason: null,
    denialCode: null,
    daysRemaining: null,
  },
  'GET /api/config': SMOKE_CONFIG,
  'GET /api/config/chain-readiness': {
    availableChains: ['solana'],
    chainReadiness: { solana: SOLANA_READINESS },
  },
  'GET /api/config/token-folders': { folders: [], items: [] },
  'GET /api/dashboard/market-ticker': {
    generatedAt: '2026-07-28T12:00:00.000Z',
    stale: false,
    items: [
      { symbol: 'BTC', priceUsd: 64000, change24hPct: 2.4 },
      { symbol: 'ETH', priceUsd: 3200, change24hPct: -3.03 },
      { symbol: 'SOL', priceUsd: 180, change24hPct: 20 },
      { symbol: 'HYPE', priceUsd: 40, change24hPct: 25 },
      { symbol: 'PUMP', priceUsd: 0.006, change24hPct: 20 },
    ],
  },
  'GET /api/account/identities': { providers: [], hasPasswordLogin: true },
  'GET /api/billing/state': {
    enabled: false,
    provider: 'none',
    providerReady: false,
    providerMocked: false,
    plans: [],
    orders: [],
  },
  'GET /api/dashboard/monitored': {
    generatedAt: null,
    tokens: [],
    pinnedTokens: [],
    total: 0,
    page: 0,
    perPage: 30,
    hasMore: false,
  },
  'GET /api/dashboard/top-performers': {
    generatedAt: null,
    source: null,
    ranking: null,
    minMcap: null,
    minVol24h: null,
    count: 0,
    cached: false,
    tokens: [],
  },
  'GET /api/dashboard/alert-events': {
    generatedAt: null,
    kind: null,
    ruleKey: null,
    mode: 'bootstrap',
    cursor: null,
    count: 0,
    events: [],
  },
  'GET /api/dashboard/alert-feeds': {
    generatedAt: null,
    mode: 'bootstrap',
    count: 0,
    feeds: [],
  },
  'GET /api/dashboard/custom-alert-rules': { rules: [], count: 0 },
  'POST /api/catalog/sparklines': {
    generatedAt: '2026-07-14T18:00:00.000Z',
    hours: 336,
    points: 336,
    granularityMinutes: 30,
    count: 0,
    items: [],
  },
};

const ROBINHOOD_CONFIG = {
  ...SMOKE_CONFIG,
  configs: {
    'solana-threshold': 55,
    'robinhood-threshold': 75,
  },
  uiPrefs: {
    ...SMOKE_CONFIG.uiPrefs,
    chainFilters: {
      enabledChains: ['solana', 'robinhood'],
      radarChains: ['solana', 'robinhood'],
      alertFeedChains: ['solana'],
      browserNotificationChains: ['solana'],
    },
  },
  tokens: [{ address: SOLANA_MANUAL, label: 'MANUALSOL' }],
  blocklist: [{ address: SOLANA_BLOCKED, label: 'BLOCKSOL' }],
  availableChains: ['solana', 'robinhood'],
  chainReadiness: {
    solana: SOLANA_READINESS,
    robinhood: ROBINHOOD_READINESS,
  },
};

const ROBINHOOD_API_FIXTURES = {
  ...API_FIXTURES,
  'GET /api/config': ROBINHOOD_CONFIG,
  'GET /api/config/token-folders': {
    folders: [{
      id: 1, userId: 1, parentFolderId: null, name: 'Watchlist', sortOrder: 0,
      createdAt: '2026-07-14T18:00:00.000Z', updatedAt: '2026-07-14T18:00:00.000Z',
    }],
    items: [{
      userId: 1, folderId: 1, chain: 'solana', address: SOLANA_MANUAL,
      sortOrder: 0, addedAt: '2026-07-14T18:00:00.000Z',
    }],
  },
  'GET /api/config/chain-readiness': {
    availableChains: ['solana', 'robinhood'],
    chainReadiness: ROBINHOOD_CONFIG.chainReadiness,
  },
  'GET /api/dashboard/monitored': {
    generatedAt: '2026-07-14T18:00:00.000Z',
    tokens: [{
      chain: 'solana',
      address: SOLANA_MONITORED,
      symbol: 'MONSOL',
      name: 'Monitored Solana',
      mcap: 400000,
      volume5m: 12000,
      volume1h: 50000,
      volume6h: 150000,
      volume24h: 500000,
    }],
    pinnedTokens: [],
    total: 1,
    page: 0,
    perPage: 30,
    hasMore: false,
  },
  'GET /api/dashboard/top-performers': {
    generatedAt: '2026-07-14T18:00:00.000Z',
    source: 'catalog',
    ranking: 'performance',
    count: 1,
    cached: false,
    tokens: [{
      chain: 'solana',
      address: SOLANA_TOP,
      symbol: 'TOPSOL',
      name: 'Top Solana',
      performanceRank: 1,
      mcap: 800000,
      volume24h: 900000,
      priceChange24h: 42,
    }],
  },
  'POST /api/catalog/monitored-metadata-batch': {
    generatedAt: '2026-07-14T18:00:00.000Z',
    count: 1,
    tokens: [{
      chain: 'solana',
      address: SOLANA_MANUAL,
      symbol: 'MANUALSOL',
      name: 'Manual Solana',
      mcap: 200000,
      volume24h: 250000,
    }],
  },
  'POST /api/catalog/meteora/batch': { count: 0, items: [] },
  'GET /api/dashboard/alert-feeds': {
    generatedAt: '2026-07-14T18:00:00.000Z',
    mode: 'all',
    count: 2,
    feeds: [
      {
        ruleKey: 'hvnc',
        kind: 'hvnc',
        count: 1,
        events: [{
          id: 101,
          chain: 'solana',
          kind: 'hvnc',
          ruleKey: 'hvnc',
          address: 'So11111111111111111111111111111111111111112',
          symbol: 'SOLHV',
          mcap: 300000,
          volume24h: 500000,
          isHvnc: true,
          label: 'HVNC',
          triggeredAt: '2026-07-14T17:59:00.000Z',
        }],
      },
      {
        ruleKey: 'robinhood-hvnc-v2',
        kind: 'hvnc',
        count: 1,
        events: [{
          id: 102,
          chain: 'robinhood',
          kind: 'hvnc',
          ruleKey: 'robinhood-hvnc-v2',
          address: '0xabcdef0123456789abcdef0123456789abcdef01',
          pairAddress: ROBINHOOD_POOL,
          symbol: 'RHV',
          mcap: null,
          fdv: 500000,
          valuationType: 'fdv',
          priceUsd: 0.0042,
          liquidityUsd: 5000,
          transactions: 15,
          volume5m: 2000,
          tokenCreatedAt: Date.parse('2026-07-01T18:00:00.000Z'),
          pairDexId: 'uniswap-v2',
          launchpadId: 'robinhood',
          tickerPeers: {
            chain: 'robinhood',
            sourceSymbol: 'RHV',
            normalizedSymbol: 'RHV',
            count: 2,
            exactCount: 2,
            subtickerCount: 0,
            hasSubtickerMatch: false,
            sourcePeerRole: 'mcap_leader',
            oldestExactAddress: '0x1111111111111111111111111111111111111111',
            highestMcapExactAddress: '0xabcdef0123456789abcdef0123456789abcdef01',
            items: [{
              address: '0xabcdef0123456789abcdef0123456789abcdef01',
              symbol: 'RHV',
              name: 'Robinhood Volume',
              mcap: 500000,
              mcapStale: false,
              tokenCreatedAt: Date.parse('2026-07-01T18:00:00.000Z'),
              matchType: 'exact',
            }, {
              address: '0x1111111111111111111111111111111111111111',
              symbol: 'RHV',
              name: 'Older Robinhood Volume',
              mcap: 250000,
              mcapStale: false,
              tokenCreatedAt: Date.parse('2026-06-01T18:00:00.000Z'),
              matchType: 'exact',
            }],
          },
          isHvnc: true,
          label: 'HVNC',
          triggeredAt: '2026-07-14T18:00:00.000Z',
        }],
      },
    ],
  },
};

const ROBINHOOD_MARKET_CONFIG = {
  ...ROBINHOOD_CONFIG,
  uiPrefs: {
    ...ROBINHOOD_CONFIG.uiPrefs,
    livePanelLayout: {
      order: ['monitored', 'pumpfun', 'alerts'],
      spans: { monitored: 2, pumpfun: 1, alerts: 1 },
      heights: { monitored: 620, alerts: 620 },
    },
    chainFilters: {
      enabledChains: ['solana'],
      radarChains: ['solana'],
      alertFeedChains: ['solana'],
      browserNotificationChains: ['solana'],
    },
  },
  tokens: [],
  blocklist: [],
  chainReadiness: {
    solana: SOLANA_READINESS,
    robinhood: ROBINHOOD_MARKET_READINESS,
  },
};
const marketPinPayloads = [];
const collectionMutationPayloads = [];
const radarBootstrapPayloads = [];
const chartRequestPayloads = [];
const compactChartRequestPayloads = [];

function robinhoodTickerPeers(address, role = 'mcap_leader') {
  return {
    chain: 'robinhood', count: 2, exactCount: 2, subtickerCount: 0,
    sourcePeerRole: role,
    oldestExactAddress: role === 'og' ? address : '0x1111111111111111111111111111111111111111',
    highestMcapExactAddress: role === 'mcap_leader' ? address : ROBINHOOD_TOKEN,
    items: [],
  };
}

function marketToken(chain, symbol) {
  const isTop = symbol.startsWith('TOP');
  return chain === 'robinhood'
    ? {
        chain,
        address: isTop ? ROBINHOOD_TOP : ROBINHOOD_TOKEN,
        symbol,
        name: `${symbol} Robinhood`,
        launchpadId: 'pons',
        pairDexId: 'uniswap-v3',
        pairAddress: ROBINHOOD_POOL,
        tickerPeers: robinhoodTickerPeers(isTop ? ROBINHOOD_TOP : ROBINHOOD_TOKEN),
        fdv: 350000,
        valuationType: 'fdv',
        valuation: {
          type: 'fdv',
          usd: 350000,
          observedAt: '2026-07-14T17:30:00.000Z',
          freshness: 'stale',
        },
        volume5m: 0,
        volume1h: 70000,
        volume6h: null,
        volume24h: 850000,
        coverage: { '5m': 'complete', '1h': 'partial', '6h': 'unavailable', '24h': 'complete' },
        activityState: 'stale',
        holderCount: 4424,
        holderObservedAt: '2026-07-14T17:50:00.000Z',
        holderCheckedAt: '2026-07-14T17:51:00.000Z',
        holderFreshness: 'fresh',
        priceChange24h: 38,
      }
    : {
        chain,
        address: isTop ? SOLANA_TOP : SOLANA_MONITORED,
        symbol,
        name: `${symbol} Solana`,
        mcap: 400000,
        volume5m: 12000,
        volume1h: 50000,
        volume6h: 150000,
        volume24h: 500000,
        priceChange24h: 22,
      };
}

async function buildMarketPanelFixture(request, panel) {
  const requestUrl = new URL(request.url());
  const chains = requestUrl.searchParams.get('chains') || 'solana';
  const page = Number(requestUrl.searchParams.get('page')) || 0;
  const snapshotAsOf = '2026-07-14T18:00:00.000Z';
  if (chains === 'solana,robinhood') {
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  const isRobinhoodOnly = chains === 'robinhood';
  const tokens = isRobinhoodOnly
    ? [marketToken('robinhood', panel === 'top' ? 'TOPRHFRESH' : 'RHFRESH')]
    : chains === 'solana,robinhood'
      ? [
          marketToken('solana', panel === 'top' ? 'TOPSOLSTALE' : 'SOLSTALE'),
          marketToken('robinhood', panel === 'top' ? 'TOPRHSTALE' : 'RHSTALE'),
        ]
      : [marketToken('solana', panel === 'top' ? 'TOPSOL' : 'MONSOL')];
  if (panel === 'top') {
    return {
      generatedAt: '2026-07-14T18:00:00.000Z',
      source: 'chain_read_models',
      ranking: 'performance',
      count: tokens.length,
      cached: false,
      tokens: tokens.map((token, index) => ({
        ...token,
        performanceRank: index + 1,
      })),
    };
  }
  const pagedRobinhoodMonitored = panel === 'monitored' && isRobinhoodOnly;
  return {
    generatedAt: snapshotAsOf,
    asOf: snapshotAsOf,
    tokens,
    pinnedTokens: [],
    total: pagedRobinhoodMonitored ? 101 : tokens.length,
    page,
    perPage: 100,
    hasMore: pagedRobinhoodMonitored && page === 0,
  };
}

const ROBINHOOD_MARKET_API_FIXTURES = {
  ...ROBINHOOD_API_FIXTURES,
  'GET /api/config': ROBINHOOD_MARKET_CONFIG,
  'GET /api/config/chain-readiness': {
    availableChains: ['solana', 'robinhood'],
    chainReadiness: ROBINHOOD_MARKET_CONFIG.chainReadiness,
  },
  'GET /api/dashboard/monitored': (request) => buildMarketPanelFixture(request, 'monitored'),
  'GET /api/dashboard/top-performers': (request) => buildMarketPanelFixture(request, 'top'),
  'PUT /api/dashboard/monitored-pins': (request) => {
    const payload = request.postDataJSON();
    marketPinPayloads.push(payload);
    return { pinnedTokens: payload.pinnedTokens || [] };
  },
  'POST /api/catalog/sparklines': (request) => {
    const payload = request.postDataJSON();
    compactChartRequestPayloads.push(payload);
    const identities = Array.isArray(payload.identities) ? payload.identities : [];
    return {
      generatedAt: '2026-07-15T12:00:00.000Z',
      chains: [...new Set(identities.map((identity) => identity.chain))],
      hours: payload.allAvailable ? null : payload.hours,
      allAvailable: payload.allAvailable === true,
      points: payload.points,
      granularityMinutes: payload.granularityMinutes,
      count: identities.length,
      items: identities.map((identity) => ({
        ...identity,
        valuationType: identity.chain === 'robinhood' ? 'fdv' : 'market-cap',
        effectiveHours: 2,
        latestBucketAt: '2026-07-15T12:00:00.000Z',
        series: identity.chain === 'robinhood'
          ? [300000, null, 350000]
          : [200000, 250000],
      })),
    };
  },
  'POST /api/catalog/sparklines/expanded': (request) => {
    const payload = request.postDataJSON();
    chartRequestPayloads.push(payload);
    return {
      generatedAt: '2026-07-15T12:00:00.000Z',
      chain: 'robinhood',
      valuationType: 'fdv',
      resolution: 'mixed',
      minuteStartsAt: '2026-07-01T13:00:00.000Z',
      allAvailable: payload.allAvailable === true,
      points: payload.points,
      granularityMinutes: payload.granularityMinutes || 5,
      count: 1,
      item: {
        chain: 'robinhood',
        address: ROBINHOOD_TOKEN,
        valuationType: 'fdv',
        resolution: 'mixed',
        minuteStartsAt: '2026-07-01T13:00:00.000Z',
        truncated: false,
        oneMinuteAvailable: false,
        series: [300000, 350000],
        candles: [
          {
            bucketTs: '2026-07-15T10:00:00.000Z', granularityMinutes: 60,
            valuationType: 'fdv', openFdvUsd: 290000, highFdvUsd: 310000,
            lowFdvUsd: 285000, closeFdvUsd: 300000,
          },
          {
            bucketTs: '2026-07-15T11:00:00.000Z', granularityMinutes: 60,
            valuationType: 'fdv', openFdvUsd: 300000, highFdvUsd: 360000,
            lowFdvUsd: 295000, closeFdvUsd: 350000,
          },
        ],
      },
    };
  },
  'GET /api/dashboard/chart-alert-events': (request) => {
    const url = new URL(request.url());
    return {
      generatedAt: '2026-07-15T12:00:00.000Z',
      chain: url.searchParams.get('chain'),
      windowHours: 24,
      address: url.searchParams.get('address'),
      count: 1,
      truncated: false,
      events: [{
        id: 91, chain: 'robinhood', ruleKey: 'monitored-fdv', kind: 'monitored-fdv',
        address: ROBINHOOD_TOKEN, triggeredAt: '2026-07-15T10:30:00.000Z',
        fdv: 300000, prevFdv: 200000, valuationType: 'fdv', pct: 50, label: 'FDV',
      }],
    };
  },
};

function holderSeriesBars(intervalHours, length) {
  const intervalMs = intervalHours * 60 * 60 * 1000;
  const asOfMs = Date.parse('2026-07-15T12:00:00.000Z');
  const currentStart = Math.floor(asOfMs / intervalMs) * intervalMs;
  return Array.from({ length }, (_, index) => {
    const startMs = currentStart - ((length - index - 1) * intervalMs);
    const delta = (index % 9) - 4;
    const missing = index === length - 1;
    return {
      start: new Date(startMs).toISOString(), end: new Date(startMs + intervalMs).toISOString(),
      holderCount: missing ? null : 4400 + index,
      observedAt: missing ? null : new Date(Math.min(asOfMs, startMs + intervalMs - 1)).toISOString(),
      delta: missing ? null : delta,
      status: missing ? 'open' : 'complete', comparison: missing ? 'unavailable' : 'complete',
    };
  });
}

function holderIntelligenceMetric(metric, overrides = {}) {
  return {
    metric, status: 'unavailable', value: null, walletCount: null, groupCount: null,
    classificationVersion: 'rh_holder_v1', throughBlock: null, observedAt: null,
    ...overrides,
  };
}

function holderIntelligenceFixture(secondPage) {
  if (secondPage) {
    return {
      tags: [], primaryTag: 'unknown', classificationVersion: 'rh_holder_v1',
      classificationStatus: 'ready', classifications: [],
    };
  }
  return {
    tags: ['cex', 'bundled'], primaryTag: 'bundled', classificationVersion: 'rh_holder_v1',
    classificationStatus: 'ready', classifications: [{
      tag: 'cex', confidence: 'deterministic', reasonCode: 'known_cex_address',
      observedAt: '2026-07-15T11:55:00.000Z', expiresAt: null,
    }, {
      tag: 'bundled', confidence: 'heuristic',
      reasonCode: 'connected_funding_launch_cluster',
      observedAt: '2026-07-15T11:55:00.000Z', expiresAt: null,
    }],
  };
}

const ROBINHOOD_ONE_MINUTE_MARKET_API_FIXTURES = {
  ...ROBINHOOD_MARKET_API_FIXTURES,
  'GET /api/robinhood/holders': (request) => {
    const secondPage = new URL(request.url()).searchParams.has('cursor');
    return {
      token: ROBINHOOD_TOKEN,
      summary: { holderCount: 4424, totalSupplyRaw: '50000000000000000000', source: 'ledger_live', observedAt: '2026-07-15T11:55:00.000Z', checkedAt: '2026-07-15T11:55:00.000Z', freshness: 'fresh' },
      holders: [{
        rank: secondPage ? 51 : 1,
        address: secondPage ? `0x${'7'.repeat(40)}` : ROBINHOOD_DEV,
        balanceRaw: secondPage ? '2500000000000000000' : '5000000000000000000',
        addressType: 'unknown', label: secondPage ? 'Second page whale' : 'Main whale',
        isVerifiedContract: false,
        nativeBalanceRaw: secondPage ? '0' : '3400000000000000000',
        buyVolumeUsd: secondPage ? '0' : '18400',
        sellProceedsUsd: secondPage ? '0' : '44800',
        avgBuyMcapUsd: secondPage ? '0' : '125000',
        avgSellMcapUsd: secondPage ? '0' : '200000',
        buyTxCount: secondPage ? 0 : 3, sellTxCount: secondPage ? 0 : 2,
        realizedPnlUsd: secondPage ? '0' : '1250',
        unrealizedPnlUsd: secondPage ? '18000' : '5000',
        unrealizedPnlPct: secondPage ? null : '25',
        positionQuality: secondPage ? 'transferred_assumed_zero' : 'exact_swap_only',
        costBasisSource: secondPage ? 'transferred_assumed_zero' : 'swap_only',
        ...holderIntelligenceFixture(secondPage),
      }],
      classificationVersion: 'rh_holder_v1', classificationStatus: 'ready',
      classificationThroughBlock: { blockNumber: '32653260', blockHash: `0x${'b'.repeat(64)}` },
      distribution: [
        holderIntelligenceMetric('top10', { status: 'ready',
          value: { numeratorRaw: '5000000000000000000', denominatorRaw: '50000000000000000000' },
          walletCount: '1' }),
        holderIntelligenceMetric('top50', { status: 'ready',
          value: { numeratorRaw: '5000000000000000000', denominatorRaw: '50000000000000000000' },
          walletCount: '1' }),
        holderIntelligenceMetric('snipers'), holderIntelligenceMetric('fresh_wallets'),
        holderIntelligenceMetric('insiders'),
        holderIntelligenceMetric('dev_hold', { status: 'ready',
          value: { numeratorRaw: '600000000000000000', denominatorRaw: '50000000000000000000' },
          walletCount: '1' }),
        holderIntelligenceMetric('lp_locked'), holderIntelligenceMetric('bundled', {
          status: 'ready',
          value: { numeratorRaw: '5000000000000000000', denominatorRaw: '50000000000000000000' },
          walletCount: '1', groupCount: '1',
        }),
      ],
      hasMore: !secondPage, nextCursor: secondPage ? null : 'page-2',
      observedAt: '2026-07-15T11:55:00.000Z', refreshQueued: false,
    };
  },
  'GET /api/robinhood/holder-count-series': {
    token: ROBINHOOD_TOKEN, asOf: '2026-07-15T12:00:00.000Z', resolution: '1h',
    intervals: ['1h', '4h', '12h', '24h'],
    range: { start: '2026-06-01T00:00:00.000Z', through: '2026-07-15T12:00:00.000Z', bucketCount: 800 },
    current: { holderCount: 4424, source: 'ledger_live', observedAt: '2026-07-15T12:00:00.000Z' },
    deltas: Object.fromEntries([
      ['4h', 4], ['12h', 12], ['1d', 24], ['3d', 72], ['7d', 168],
    ].map(([key, delta]) => [key, {
      delta, comparison: 'complete', from: '2026-07-08T12:00:00.000Z', through: '2026-07-15T12:00:00.000Z',
    }])),
    series: {
      '1h': holderSeriesBars(1, 800), '4h': holderSeriesBars(4, 200),
      '12h': holderSeriesBars(12, 80), '24h': holderSeriesBars(24, 40),
    },
  },
  'GET /api/robinhood/trades': (request) => {
    const scope = new URL(request.url()).searchParams.get('scope') === 'dev' ? 'dev' : 'all';
    return {
      chain: 'robinhood', token: ROBINHOOD_TOKEN, scope,
      creatorAddress: scope === 'dev' ? ROBINHOOD_DEV : null,
      hasMore: false, nextCursor: null,
      trades: [{
        chain: 'robinhood', transactionHash: `0x${'1'.repeat(64)}`,
        actionIndex: 1, blockNumber: 99, blockTime: '2026-07-15T11:00:00.000Z',
        side: 'buy', walletAddress: ROBINHOOD_DEV,
        amountUsd: scope === 'dev' ? 25 : 10, priceUsd: 0.1, mcUsd: 350000,
      }],
    };
  },
  'GET /api/config': {
    ...ROBINHOOD_MARKET_CONFIG,
    uiPrefs: {
      ...ROBINHOOD_MARKET_CONFIG.uiPrefs,
      expandedSparklineGranularityMinutes: 15,
    },
  },
  'POST /api/catalog/sparklines/expanded': (request) => {
    const fixture = ROBINHOOD_MARKET_API_FIXTURES['POST /api/catalog/sparklines/expanded'](request);
    return {
      ...fixture,
      item: {
        ...fixture.item,
        oneMinuteAvailable: true,
      },
    };
  },
};

const ROBINHOOD_IDENTITY_BADGE_API_FIXTURES = {
  ...ROBINHOOD_ONE_MINUTE_MARKET_API_FIXTURES,
  'POST /api/catalog/sparklines/expanded': (request) => {
    const fixture = ROBINHOOD_ONE_MINUTE_MARKET_API_FIXTURES['POST /api/catalog/sparklines/expanded'](request);
    return { ...fixture, item: { ...fixture.item, oneMinuteAvailable: false } };
  },
  'GET /api/dashboard/monitored': async (request) => {
    const fixture = await buildMarketPanelFixture(request, 'monitored');
    return {
      ...fixture,
      tokens: fixture.tokens.map((token) => (
        token.address === ROBINHOOD_TOKEN
          ? {
              ...token,
              tokenCreatedAt: Date.now() - (14 * 24 * 60 * 60 * 1000),
              tickerPeers: {
                count: 2,
                sourcePeerRole: 'og',
                items: [],
              },
            }
          : token
      )),
    };
  },
};

const ROBINHOOD_RADAR_READINESS = {
  ...ROBINHOOD_MARKET_READINESS,
  capabilities: {
    ...ROBINHOOD_MARKET_READINESS.capabilities,
    history: true,
  },
};

const ROBINHOOD_RADAR_CONFIG = {
  ...ROBINHOOD_MARKET_CONFIG,
  tokens: [{
    chain: 'robinhood', address: ROBINHOOD_MANUAL, label: 'MANUALRH',
    symbol: 'MANUALRH', name: 'Manual Robinhood', last_fdv: 180000,
    last_pair_address: ROBINHOOD_POOL, last_dex_id: 'uniswap-v3',
    holderCount: 2001, holderObservedAt: '2026-07-14T17:49:00.000Z',
    holderCheckedAt: '2026-07-14T17:51:00.000Z', holderFreshness: 'fresh',
    tickerPeers: robinhoodTickerPeers(ROBINHOOD_MANUAL, 'og'),
  }],
  configs: {
    'old-mcap-min': 120000,
    'old-mcap-max': 100000000,
    'old-fdv-min': 130000,
    'old-fdv-max': 90000000,
    'old-week-mcap-min': 140000,
    'old-week-mcap-max': 80000000,
    'old-week-fdv-min': 150000,
    'old-week-fdv-max': 70000000,
  },
  uiPrefs: {
    ...ROBINHOOD_MARKET_CONFIG.uiPrefs,
    enabledRobinhoodTradeTerminals: ['gmgn', 'fomo'],
    chainFilters: {
      ...ROBINHOOD_MARKET_CONFIG.uiPrefs.chainFilters,
      enabledChains: ['solana', 'robinhood'],
      radarChains: ['robinhood'],
    },
  },
  chainReadiness: {
    solana: SOLANA_READINESS,
    robinhood: ROBINHOOD_RADAR_READINESS,
  },
};

const ROBINHOOD_RADAR_API_FIXTURES = {
  ...ROBINHOOD_MARKET_API_FIXTURES,
  'GET /api/config': ROBINHOOD_RADAR_CONFIG,
  'GET /api/config/chain-readiness': {
    availableChains: ['solana', 'robinhood'],
    chainReadiness: ROBINHOOD_RADAR_CONFIG.chainReadiness,
  },
  'GET /api/catalog/bid-zone': { generatedAt: null, count: 0, candidates: [] },
  'POST /api/dashboard/history-bootstrap': (request) => {
    const requestPayload = request.postDataJSON();
    radarBootstrapPayloads.push(requestPayload);
    const robinhoodToken = {
      ...marketToken('robinhood', 'RADARST'),
      valuation: {
        type: 'fdv', usd: 350000, observedAt: '2026-07-14T17:30:00.000Z', freshness: 'stale',
      },
      volume1h: 70000,
      volume6h: null,
      volume24h: 0,
      coverage: { '1h': 'partial', '6h': 'unavailable', '24h': 'complete' },
      priceChange1h: 3.5,
      priceChange6h: null,
      priceChange24h: 0,
      priceChangeCoverage: { '1h': 'partial', '6h': 'unavailable', '24h': 'complete' },
      activityState: 'stale',
      tokenCreatedAt: Date.now() - (5 * 24 * 60 * 60 * 1000),
    };
    const solanaToken = {
      ...marketToken('solana', 'RADARSOL'),
      address: SOLANA_TOP,
      valuation: {
        type: 'mcap', usd: 400000, observedAt: '2026-07-14T17:55:00.000Z', freshness: 'fresh',
      },
      coverage: { '1h': 'complete', '6h': 'complete', '24h': 'complete' },
      priceChangeCoverage: { '1h': 'complete', '6h': 'complete', '24h': 'complete' },
      tokenCreatedAt: Date.now() - (5 * 24 * 60 * 60 * 1000),
    };
    const recentTokens = requestPayload.chains?.includes('solana')
      ? [robinhoodToken, solanaToken]
      : [robinhoodToken];
    const oldToken = {
      ...marketToken('robinhood', 'RADAROLD'),
      address: ROBINHOOD_OLD,
      tickerPeers: robinhoodTickerPeers(ROBINHOOD_OLD),
      tokenCreatedAt: Date.now() - (20 * 24 * 60 * 60 * 1000),
    };
    return {
      generatedAt: '2026-07-14T18:00:00.000Z',
      asOf: '2026-07-14T18:00:00.000Z',
      recent: { total: recentTokens.length, page: 0, perPage: 15, count: recentTokens.length, hasMore: false, tokens: recentTokens, pinnedTokens: [] },
      oldWeek: { total: 1, page: 0, perPage: 15, count: 1, hasMore: false, tokens: [oldToken], pinnedTokens: [] },
    };
  },
};

const ROBINHOOD_COLLECTION_API_FIXTURES = {
  ...ROBINHOOD_MARKET_API_FIXTURES,
  'GET /api/config': {
    ...ROBINHOOD_MARKET_CONFIG,
    configs: { 'block-warning-enabled': 'off' },
  },
  'POST /api/config/starred': (request) => {
    const payload = request.postDataJSON();
    collectionMutationPayloads.push({ action: 'star', payload });
    return { message: 'Token starred', starred: payload };
  },
  'POST /api/config/tokens': (request) => {
    const payload = request.postDataJSON();
    collectionMutationPayloads.push({ action: 'manual', payload });
    return { message: 'Token added', token: payload };
  },
  'POST /api/config/blocklist': (request) => {
    const payload = request.postDataJSON();
    collectionMutationPayloads.push({ action: 'block', payload });
    return { message: 'Token blocked', blocked: payload };
  },
};

function fixtureKey(request) {
  const url = new URL(request.url());
  return `${request.method()} ${url.pathname}`;
}

async function installApiFixtures(page, unexpectedRequests, fixtures = API_FIXTURES, apiRequests = []) {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith('/api/')) {
      await route.continue();
      return;
    }
    const key = fixtureKey(route.request());
    apiRequests.push(route.request().url());
    if (key === 'PATCH /api/config/ui-prefs') {
      const patchPayload = route.request().postDataJSON()?.uiPrefs || {};
      const basePrefs = fixtures['GET /api/config']?.uiPrefs || {};
      await route.fulfill({
        status: 200,
        json: {
          message: 'UI preferences updated',
          uiPrefs: { ...basePrefs, ...patchPayload },
        },
      });
      return;
    }
    if (key === 'PATCH /api/config') {
      const fixtureSource = fixtures[key];
      if (fixtureSource) {
        const fixture = typeof fixtureSource === 'function'
          ? await fixtureSource(route.request())
          : fixtureSource;
        const status = Number(fixture.__status || 200);
        const json = { ...fixture };
        delete json.__status;
        await route.fulfill({ status, json });
        return;
      }
      const configs = route.request().postDataJSON()?.configs || {};
      await route.fulfill({ status: 200, json: { message: 'Config updated', configs } });
      return;
    }
    const fixtureSource = fixtures[key];
    const fixture = typeof fixtureSource === 'function'
      ? await fixtureSource(route.request())
      : fixtureSource;
    if (!fixture) {
      unexpectedRequests.push(key);
      await route.fulfill({ status: 404, json: { error: `Missing smoke fixture for ${key}` } });
      return;
    }
    await route.fulfill({ status: 200, json: fixture });
  });
}

async function installSocketFixture(page, scenario) {
  await page.routeWebSocket('**/socket.io/**', (socket) => {
    if (!scenario) {
      void socket.close();
      return;
    }
    scenario.socket = socket;
    socket.onMessage((message) => {
      const frame = String(message);
      scenario.clientFrames.push(frame);
      if (frame === '40') {
        socket.send('40{"sid":"smoke-socket"}');
      }
    });
    socket.send('0{"sid":"smoke-engine","upgrades":[],"pingInterval":60000,"pingTimeout":20000,"maxPayload":1000000}');
  });
}

function sendSocketEvent(scenario, event, payload) {
  scenario.socket?.send(`42${JSON.stringify([event, payload])}`);
}

async function openAuthenticatedWorkspace(
  page,
  fixtures = API_FIXTURES,
  pathname = '/alerts',
  socketScenario = null,
) {
  const unexpectedRequests = [];
  const pageErrors = [];
  const apiRequests = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await installSocketFixture(page, socketScenario);
  await installApiFixtures(page, unexpectedRequests, fixtures, apiRequests);
  await page.goto(pathname);
  await expect(page.getByRole('group', { name: 'Filter workspace by blockchain' })).toBeVisible();
  return { apiRequests, pageErrors, unexpectedRequests };
}

test('links login support directly to the official Discord', async ({ page }) => {
  await page.route('**/api/auth/me', (route) => route.fulfill({
    status: 401,
    json: { error: 'Authentication required.' },
  }));
  await page.goto('/login');

  await expect(page.getByText('Need help? Contact an administrator for general support.')).toBeVisible();
  const supportLink = page.getByRole('link', { name: 'Join our Discord' });
  await expect(supportLink).toBeVisible();
  await expect(supportLink).toHaveAttribute('href', 'https://discord.gg/2pjQ5BVgNP');
  await expect(page.getByRole('button', { name: /access help/i })).toHaveCount(0);
});

test('shows shared workspace chrome in Alerts and Radar', async ({ page }) => {
  const diagnostics = await openAuthenticatedWorkspace(page, ROBINHOOD_RADAR_API_FIXTURES);
  const accountArea = page.locator('.workspace-account-area');
  const socialLinks = page.getByRole('navigation', { name: 'TrendScope social links' });
  const marketTicker = page.getByRole('contentinfo', { name: 'Market prices' });
  const discordLink = socialLinks.getByRole('link', { name: 'Join the TrendScope Discord' });
  const xLink = socialLinks.getByRole('link', { name: 'Follow TrendScope on X' });

  await expect(accountArea.locator(':scope > *')).toHaveCount(1);
  await expect(accountArea.locator(':scope > *')).toHaveClass(/workspace-userbar/);
  await expect(socialLinks.getByText('Official Links')).toBeVisible();
  await expect(discordLink).toHaveCSS('width', '24px');
  await expect(socialLinks.locator('.workspace-social-link svg')).toHaveCount(2);
  await expect(discordLink).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(discordLink).toHaveCSS('border-top-style', 'none');
  await expect(discordLink).toHaveCSS('color', 'rgb(142, 226, 255)');
  await expect(discordLink).toHaveAttribute('href', 'https://discord.gg/2pjQ5BVgNP');
  await expect(xLink).toHaveAttribute('href', 'https://x.com/trendscope_pro');
  await expect(marketTicker.locator('.market-ticker-item')).toHaveCount(5);
  await expect(marketTicker.locator('[data-market-symbol="BTC"]')).toHaveCSS('font-size', '11px');
  await expect(marketTicker.locator('[data-market-symbol="BTC"] .market-ticker-icon')).toHaveCSS('width', '17px');
  await expect(marketTicker.locator('[data-market-symbol="PUMP"]')).toContainText('$0.006000');
  await expect(marketTicker.locator('[data-market-symbol="PUMP"] img')).toHaveAttribute('src', '/launchpad-pump.png');
  await expect(marketTicker.locator('[data-market-symbol="PUMP"] img')).toHaveCSS('width', '16px');
  await expect(marketTicker).toHaveCSS('position', 'fixed');
  await expect(marketTicker).toHaveCSS('bottom', '0px');
  await expect(marketTicker).toHaveCSS('height', '34px');
  await expect(marketTicker.locator('.workspace-market-ticker-inner')).toHaveCSS('justify-content', 'flex-start');
  const footerMeta = marketTicker.locator('.workspace-market-ticker-meta');
  await expect(footerMeta.locator(':scope > *')).toHaveCount(2);
  await expect(footerMeta.locator(':scope > *').nth(0)).toHaveAttribute('data-footer-connection-status', '');
  await expect(footerMeta.locator('.workspace-connection-label')).toHaveText('Unstable');
  await expect(footerMeta.locator(':scope > *').nth(1)).toHaveClass(/workspace-social-links/);
  await expect(page.locator('.app-shell')).toHaveCSS('padding-bottom', '42px');
  await expect.poll(
    () => diagnostics.apiRequests.filter((url) => new URL(url).pathname === '/api/dashboard/market-ticker').length,
    { timeout: 8_000 },
  ).toBeGreaterThanOrEqual(2);
  await page.goto('/radar');
  await expect(socialLinks).toBeVisible();
  await expect(marketTicker).toBeVisible();

  expect(diagnostics.unexpectedRequests).toEqual([]);
  expect(diagnostics.pageErrors).toEqual([]);
});

test('keeps the publishable chain selector SOL-only and exposes matching settings', async ({ page }) => {
  test.setTimeout(35_000);
  const diagnostics = await openAuthenticatedWorkspace(page);
  const topbar = page.locator('.workspace-topbar-inner');
  const selector = page.getByRole('group', { name: 'Filter workspace by blockchain' });
  const solana = selector.locator('[data-chain="solana"]');

  await expect(selector.locator('.workspace-chain-selector-btn')).toHaveCount(1);
  await expect(selector.locator('[data-chain="robinhood"]')).toHaveCount(0);
  await expect(solana).toHaveAttribute('aria-pressed', 'true');
  await expect(solana).toBeDisabled();
  await expect(solana).toHaveAttribute('title', /Solana is the only selected blockchain/);

  await expect(topbar.locator(':scope > *')).toHaveCount(4);
  await expect(topbar.locator(':scope > *').nth(0)).toHaveClass(/workspace-brand/);
  await expect(topbar.locator(':scope > *').nth(1)).toHaveClass(/workspace-chain-selector/);
  await expect(topbar.locator(':scope > *').nth(2)).toHaveClass(/workspace-route-group/);
  await expect(topbar.locator(':scope > *').nth(3)).toHaveClass(/workspace-account-area/);

  await page.getByRole('button', { name: 'Open user menu' }).click();
  await page.getByRole('button', { name: 'Bot Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Bot Settings' });
  await expect(dialog).toBeVisible();
  await expect(page.locator('.workspace-market-ticker')).toHaveCSS('z-index', '110');
  await expect(page.locator('[data-auth-modal="bot-settings"] .legacy-auth-modal-backdrop'))
    .toHaveCSS('backdrop-filter', 'blur(7px)');
  await expect(dialog.getByRole('tab')).toHaveCount(3);
  const solanaSettingsTab = dialog.getByRole('tab', { name: 'Solana' });
  await expect(solanaSettingsTab).toHaveAttribute('aria-selected', 'true');
  await expect(solanaSettingsTab.locator('.token-chain-icon')).toBeVisible();
  await expect(dialog.getByRole('tab', { name: 'Robinhood' })).toHaveCount(0);
  await expect(dialog.getByRole('tab', { name: 'Alerts & Chains' })).toHaveCount(0);
  await expect(dialog.locator('input[name="solana-threshold"]')).toBeVisible();
  await expect(dialog.locator('input[name="solana-mcap-threshold"]')).toBeVisible();
  await expect(dialog.locator('input[name="solana-fdv-threshold"]')).toHaveCount(0);
  await expect(dialog.locator('[data-config-toggle-key="solana-alert-vol-enabled"]')).toHaveAttribute('aria-pressed', 'true');
  const pumpClaim = dialog.locator(
    '.bot-settings-claim-toggle:has([data-config-toggle-key="solana-alert-gmgn-claim-pump-enabled"])',
  );
  const bagsClaim = dialog.locator(
    '.bot-settings-claim-toggle:has([data-config-toggle-key="solana-alert-gmgn-claim-bags-enabled"])',
  );
  await expect(pumpClaim.locator('img')).toHaveAttribute('src', '/launchpad-pump.png');
  await expect(bagsClaim.locator('img')).toHaveAttribute('src', '/launchpad-bags.png');
  await expect(pumpClaim).toHaveCSS('height', '36px');
  await expect(pumpClaim).toHaveCSS('align-content', 'center');
  await expect(bagsClaim).toHaveCSS('height', '36px');
  await expect(dialog.locator('.bot-settings-surge-cell').first()).toHaveCSS('min-height', '44px');
  await expect(dialog.locator('.bot-settings-surge-cell > label').first()).toHaveCSS('min-height', '18px');
  await expect(dialog.locator('.bot-settings-footer-grid')).toHaveCSS('grid-template-columns', /\d+px \d+px/);
  await expect(dialog.locator('.bot-settings-claim-grid')).toHaveCSS('grid-template-columns', /\d+px \d+px/);
  await expect(dialog.getByText('Trading terminal', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Shortcut links', { exact: true })).toHaveCount(0);
  const terminalMenuButton = dialog.getByRole('button', { name: 'Open trading terminal preferences' });
  await expect(terminalMenuButton).toHaveCSS('height', '36px');

  const recentSurgeToggle = dialog.locator(
    '[data-config-toggle-key="solana-alert-recent-surge-1h-enabled"]',
  );
  const recentSurgeCell = recentSurgeToggle.locator('xpath=ancestor::div[contains(@class, "bot-settings-surge-cell")][1]');
  for (const [toggle, option] of [
    [recentSurgeToggle, recentSurgeCell],
    [pumpClaim.locator('.bot-settings-inline-toggle'), pumpClaim],
  ]) {
    const configResponse = page.waitForResponse((response) => (
      response.request().method() === 'PATCH'
      && new URL(response.url()).pathname === '/api/config'
    ));
    await toggle.click();
    await configResponse;
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(option).toHaveCSS('filter', 'grayscale(0.85)');
    await expect(option).toHaveCSS('opacity', '0.58');
  }

  await dialog.getByRole('tab', { name: 'Notifications' }).click();
  await expect(dialog.locator('[data-chain-filter-surface="browserNotificationChains"]')).toBeVisible();
  await expect(dialog.getByText('Card effects', { exact: true })).toBeVisible();

  expect(diagnostics.unexpectedRequests).toEqual([]);
  expect(diagnostics.pageErrors).toEqual([]);
});

test('uses the confirmed full-width scrollable selector below 980px', async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 900 });
  const diagnostics = await openAuthenticatedWorkspace(page);
  const topbar = page.locator('.workspace-topbar-inner');
  const selector = page.getByRole('group', { name: 'Filter workspace by blockchain' });

  await expect(topbar).toHaveCSS('flex-direction', 'column');
  await expect(selector).toHaveCSS('overflow-x', 'auto');
  const dimensions = await topbar.evaluate((element) => {
    const chainSelector = element.querySelector('.workspace-chain-selector');
    const topbarRect = element.getBoundingClientRect();
    const selectorRect = chainSelector?.getBoundingClientRect();
    const styles = window.getComputedStyle(element);
    return {
      topbarContentWidth: topbarRect.width
        - Number.parseFloat(styles.paddingLeft)
        - Number.parseFloat(styles.paddingRight),
      selectorWidth: selectorRect?.width ?? 0,
    };
  });
  expect(dimensions.selectorWidth).toBeGreaterThan(0);
  expect(Math.abs(dimensions.topbarContentWidth - dimensions.selectorWidth)).toBeLessThanOrEqual(2);
  await expect(page.locator('.workspace-route-group')).toBeVisible();
  await expect(page.locator('.workspace-userbar')).toBeVisible();

  expect(diagnostics.unexpectedRequests).toEqual([]);
  expect(diagnostics.pageErrors).toEqual([]);
});

test('keeps compact manual controls aligned with routed token sort controls', async ({ page }) => {
  await openAuthenticatedWorkspace(page, ROBINHOOD_API_FIXTURES);
  const manualSection = page.locator('#manual-tokens-section');
  await expect(manualSection).not.toContainText('Pinned · always monitored');

  const manualSortCluster = manualSection.locator('.compact-sort-cluster');
  await expect(manualSortCluster).toContainText('SORT');
  await expect(manualSortCluster.getByRole('button', { name: 'MCAP / FDV', exact: true })).toBeVisible();
  await expect(manualSortCluster).toHaveCSS('flex-wrap', 'nowrap');
  expect(await manualSection.locator('.legacy-bar-controls').evaluate((controls) => {
    const children = [...controls.children];
    const starIndex = children.findIndex((child) => child.matches('[data-action="manual-starred-only"]'));
    const sortIndex = children.findIndex((child) => child.matches('.compact-sort-cluster'));
    return starIndex >= 0 && sortIndex >= 0 && starIndex < sortIndex;
  })).toBe(true);
});

test('chain-scoped bot settings persist independent supported controls and roll back failures', async ({ page }) => {
  test.setTimeout(35_000);
  let configPatchCount = 0;
  const botSettingsFixtures = {
    ...ROBINHOOD_API_FIXTURES,
    'PATCH /api/config': (request) => {
      configPatchCount += 1;
      const configs = request.postDataJSON()?.configs || {};
      return configPatchCount === 3
        ? { __status: 500, error: 'Config write failed' }
        : { message: 'Config updated', configs };
    },
  };
  await openAuthenticatedWorkspace(page, botSettingsFixtures);
  await page.getByRole('button', { name: 'Open user menu' }).click();
  await page.getByRole('button', { name: 'Bot Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Bot Settings' });

  await expect(dialog.getByRole('tab', { name: 'Robinhood' })).toBeVisible();
  await expect(dialog.getByRole('tab', { name: 'Robinhood' }).locator('.token-chain-icon')).toBeVisible();
  await dialog.getByRole('tab', { name: 'Robinhood' }).click();
  const robinhoodThreshold = dialog.locator('input[name="robinhood-threshold"]');
  await expect(robinhoodThreshold).toHaveValue('75');
  await expect(dialog.locator('input[name="robinhood-fdv-threshold"]')).toBeVisible();
  const fdvToggle = dialog.locator('[data-config-toggle-key="robinhood-alert-fdv-enabled"]');
  await expect(fdvToggle).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog.locator('input[name="robinhood-mcap-threshold"]')).toHaveCount(0);
  await expect(dialog.locator('input[name="robinhood-meteora-alert-1h-threshold"]')).toHaveCount(0);
  await expect(dialog.locator('[data-config-toggle-key="robinhood-alert-gmgn-claim-pump-enabled"]')).toHaveCount(0);
  const robinhoodTerminalMenu = dialog.locator(
    '[data-bot-settings-section="robinhood"] [data-trade-terminal-chain="robinhood"]',
  );
  const robinhoodTerminalButton = robinhoodTerminalMenu.getByRole('button', {
    name: 'Open Robinhood trading terminal preferences',
  });
  await expect(robinhoodTerminalButton).toHaveText('4/4 on');
  await robinhoodTerminalButton.click();
  const terminalPrefPatch = page.waitForRequest((request) => (
    request.method() === 'PATCH' && new URL(request.url()).pathname === '/api/config/ui-prefs'
  ));
  await robinhoodTerminalMenu.locator('[data-trade-terminal-key="axiom"]').click();
  const terminalPrefsPayload = (await terminalPrefPatch).postDataJSON().uiPrefs;
  expect(terminalPrefsPayload.enabledRobinhoodTradeTerminals).toEqual(['gmgn', 'padre', 'fomo']);
  expect(terminalPrefsPayload.enabledTradeTerminals)
    .toEqual(['axiom', 'photon', 'bullx', 'gmgn', 'padre', 'fomo']);
  await expect(robinhoodTerminalButton).toHaveText('3/4 on');

  await dialog.getByRole('tab', { name: 'Solana' }).click();
  const solanaTerminalMenu = dialog.locator(
    '[data-bot-settings-section="solana"] [data-trade-terminal-chain="solana"]',
  );
  await expect(solanaTerminalMenu.getByRole('button', {
    name: 'Open trading terminal preferences',
  })).toHaveText('6/6 on');
  await expect(solanaTerminalMenu.locator('[data-trade-terminal-key="axiom"]')).toHaveClass(/active/);
  await dialog.getByRole('tab', { name: 'Robinhood' }).click();

  const thresholdPatch = page.waitForRequest((request) => (
    request.method() === 'PATCH' && new URL(request.url()).pathname === '/api/config'
  ));
  await robinhoodThreshold.fill('80');
  await robinhoodThreshold.press('Enter');
  expect((await thresholdPatch).postDataJSON()).toEqual({
    configs: { 'robinhood-threshold': 80 },
  });
  await expect(dialog.getByRole('tab', { name: 'Robinhood' })).toHaveAttribute('aria-selected', 'true');

  const configPatch = page.waitForRequest((request) => (
    request.method() === 'PATCH' && new URL(request.url()).pathname === '/api/config'
  ));
  await fdvToggle.click();
  expect((await configPatch).postDataJSON()).toEqual({
    configs: { 'robinhood-alert-fdv-enabled': 'off' },
  });
  await expect(fdvToggle).toHaveAttribute('aria-pressed', 'false');
  const fdvOption = fdvToggle.locator('xpath=ancestor::div[contains(@class, "bot-settings-field-group")][1]');
  await expect(fdvOption).toHaveCSS('filter', 'grayscale(0.85)');
  await expect(fdvOption).toHaveCSS('opacity', '0.58');
  await expect(dialog.getByRole('tab', { name: 'Robinhood' })).toHaveAttribute('aria-selected', 'true');

  await dialog.getByRole('tab', { name: 'Solana' }).click();
  await expect(dialog.locator('input[name="solana-threshold"]')).toHaveValue('55');
  await dialog.getByRole('tab', { name: 'Robinhood' }).click();

  const volumeToggle = dialog.locator('[data-config-toggle-key="robinhood-alert-vol-enabled"]');
  const failedPatch = page.waitForResponse((response) => (
    response.request().method() === 'PATCH'
    && new URL(response.url()).pathname === '/api/config'
    && response.status() === 500
  ));
  await volumeToggle.click();
  await failedPatch;
  await expect(volumeToggle).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog.getByRole('tab', { name: 'Robinhood' })).toHaveAttribute('aria-selected', 'true');
  await expect(dialog.locator('[data-bot-settings-error]')).toContainText('Config write failed');
});

test('chain-scoped bot settings remain usable on a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 780 });
  await openAuthenticatedWorkspace(page, ROBINHOOD_API_FIXTURES);
  await page.getByRole('button', { name: 'Open user menu' }).click();
  await page.getByRole('button', { name: 'Bot Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Bot Settings' });

  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.bot-settings-nav')).toHaveCSS('overflow-x', 'auto');
  await dialog.getByRole('tab', { name: 'Robinhood' }).click();
  const fdvToggle = dialog.locator('[data-config-toggle-key="robinhood-alert-fdv-enabled"]');
  await expect(fdvToggle).toBeVisible();
  await expect(fdvToggle).toHaveCSS('width', '42px');
  expect(await dialog.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(1);
});

test('renders the FOMO shortcut link for Solana tokens', async ({ page }) => {
  await openAuthenticatedWorkspace(page, ROBINHOOD_API_FIXTURES);
  const manualSection = page.locator('#manual-tokens-section');
  const fomoLink = manualSection.locator('.trade-link.fomo').first();
  await expect(fomoLink).toHaveAttribute('href', `https://fomo.family/tokens/solana/${SOLANA_MANUAL}`);
  await expect(fomoLink).toContainText('FOMO');
  await expect(fomoLink.locator('.terminal-icon-fomo')).toHaveAttribute('src', /terminal-fomo/);
});

test('filters a combined Solana and Robinhood alert feed through the master selector', async ({ page }) => {
  test.setTimeout(50_000);
  const diagnostics = await openAuthenticatedWorkspace(page, ROBINHOOD_API_FIXTURES);
  const selector = page.getByRole('group', { name: 'Filter workspace by blockchain' });
  const solanaButton = selector.locator('[data-chain="solana"]');
  const robinhoodButton = selector.locator('[data-chain="robinhood"]');
  const solanaAlert = page.locator('article.alert-row[data-alert-id="backend:hvnc:101"]');
  const robinhoodAlert = page.locator('article.alert-row[data-alert-id="backend:hvnc:102"]');

  const monitoredSolanaRow = page.locator('.monitored-panel article.monitored-token-row[data-address="So11111111111111111111111111111111111111112"]');
  await expect(monitoredSolanaRow).toBeVisible();
  await expect(page.locator('#top-performers-section')).toContainText('TOPSOL');
  const manualSection = page.locator('#manual-tokens-section');
  await expect(manualSection).toContainText('MANUALSOL');

  await expect(selector.locator('.workspace-chain-selector-btn')).toHaveCount(2);
  await expect(solanaButton).toHaveAttribute('aria-pressed', 'true');
  await expect(robinhoodButton).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => page.evaluate(() => window.trendscopeAlertDebug?.snapshot()?.memory?.count)).toBe(2);
  await expect(solanaAlert).toBeVisible();
  await expect(robinhoodAlert).toBeVisible();
  const primaryLaunchpadBadge = robinhoodAlert.getByLabel('Uniswap · Pool: Uniswap V2', { exact: true });
  await expect(primaryLaunchpadBadge).toHaveAttribute('data-tooltip', 'Uniswap · Pool: Uniswap V2');
  await expect(primaryLaunchpadBadge).toHaveCSS('pointer-events', 'auto');
  await expect(robinhoodAlert).toContainText('5m vol');
  await expect(robinhoodAlert).toContainText('FDV');
  await expect(robinhoodAlert.locator('.alert-stats-v68')).not.toContainText('AGE -');
  await expect(robinhoodAlert.locator('.alert-ticker-peers-badge-mark')).toHaveText('#1');
  await expect(robinhoodAlert.locator('.alert-ticker-peers-badge')).toHaveAttribute(
    'title', 'FDV leader among exact ticker peers',
  );
  await expect(robinhoodAlert.locator('[data-action="open-alert-chart"]')).toHaveCount(1);
  await expect(robinhoodAlert.locator('[data-action="toggle-star"]'))
    .toHaveAttribute('data-chain', 'robinhood');
  await expect(robinhoodAlert.locator('[data-action="block-token"]'))
    .toHaveAttribute('data-chain', 'robinhood');
  await expect(robinhoodAlert.locator('.trade-link.axiom')).toHaveAttribute(
    'href',
    `https://axiom.trade/meme/${ROBINHOOD_POOL}?chain=robinhood&pulseChains=sol,robinhood,bnb&trackerChains=sol,robinhood,bnb,eth`,
  );
  await expect(robinhoodAlert.locator('.trade-link.padre'))
    .toHaveAttribute('href', `https://trade.padre.gg/trade/robinhood/${ROBINHOOD_POOL}`);
  await expect(robinhoodAlert.locator('.trade-link.gmgn'))
    .toHaveAttribute('href', `https://gmgn.ai/robinhood/token/${ROBINHOOD_TOKEN}`);
  await expect(robinhoodAlert.locator('.trade-link.fomo'))
    .toHaveAttribute('href', `https://fomo.family/tokens/robinhood/${ROBINHOOD_TOKEN}`);
  await expect(robinhoodAlert.locator('.trade-link.photon, .trade-link.bullx')).toHaveCount(0);

  await solanaButton.click();

  await expect(page.locator('article.alert-row[data-alert-id="backend:hvnc:101"]')).toHaveCount(0);
  await expect(page.locator('article.alert-row[data-alert-id="backend:hvnc:102"]')).toBeVisible();
  await expect(selector.locator('[data-chain="solana"]')).toHaveAttribute('aria-pressed', 'false');
  await expect(selector.locator('[data-chain="robinhood"]')).toBeDisabled();
  await expect(monitoredSolanaRow).toHaveCount(0);
  await expect(page.locator('#top-performers-section')).not.toContainText('TOPSOL');
  await expect(page.locator('#manual-tokens-section')).not.toContainText('MANUALSOL');
  await expect(page.locator('[data-chain-readiness-surface="monitored"]')).toContainText('syncing market coverage');
  await expect(page.locator('[data-chain-readiness-surface="top-performers"]')).toContainText('syncing market coverage');
  await expect(page.locator('#manual-tokens-section [data-chain-readiness-surface="manual"]')).toHaveCount(0);
  await expect(page.locator('#manual-tokens-section [data-role="manual-token-form"] [data-selected-chain="robinhood"]')).toBeAttached();
  expect(diagnostics.unexpectedRequests).toEqual([]);
  expect(diagnostics.pageErrors).toEqual([]);
});

test('refetches market panels by chain and rejects a stale combined response', async ({ page }) => {
  test.setTimeout(40_000);
  marketPinPayloads.length = 0;
  compactChartRequestPayloads.length = 0;
  const diagnostics = await openAuthenticatedWorkspace(page, ROBINHOOD_MARKET_API_FIXTURES);
  const configPatchPayloads = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (request.method() === 'PATCH' && url.pathname === '/api/config') {
      configPatchPayloads.push(request.postDataJSON()?.configs);
    }
  });
  const selector = page.getByRole('group', { name: 'Filter workspace by blockchain' });
  const solanaButton = selector.locator('[data-chain="solana"]');
  const robinhoodButton = selector.locator('[data-chain="robinhood"]');

  await expect(page.locator('.monitored-panel')).toContainText('MONSOL');
  await expect(page.locator('#top-performers-section')).toContainText('TOPSOL');

  await robinhoodButton.click();
  await expect.poll(() => diagnostics.apiRequests.some((requestUrl) => {
    const url = new URL(requestUrl);
    return url.pathname === '/api/dashboard/monitored'
      && url.searchParams.get('chains') === 'solana,robinhood';
  })).toBe(true);
  await solanaButton.click();

  const robinhoodRow = page.locator(`.monitored-panel article.monitored-token-row[data-address="${ROBINHOOD_TOKEN}"]`);
  await expect(robinhoodRow).toBeVisible();
  await expect(robinhoodRow).toContainText('RHFRESH');
  await expect(robinhoodRow).toContainText('FDV');
  await expect(robinhoodRow).toHaveAttribute('data-identity', `robinhood:${ROBINHOOD_TOKEN}`);
  await expect(robinhoodRow).not.toContainText('STALE VALUATION');
  await expect(robinhoodRow).not.toContainText('NO RECENT ACTIVITY');
  await expect(robinhoodRow).toHaveClass(/monitored-activity-stale/);
  await expect(robinhoodRow.locator('.monitored-valuation-stale')).toHaveCSS('color', 'rgb(255, 178, 92)');
  await expect(robinhoodRow.locator('.monitored-main-metric')).toHaveText('$0');
  await expect(robinhoodRow.locator('.monitored-coverage-partial')).toContainText('~');
  await expect(robinhoodRow.locator('.monitored-coverage-unavailable')).toHaveText('-');
  const monitoredFilters = page.locator('[data-monitored-filters]');
  const filtersToggle = monitoredFilters.getByRole('button', { name: 'FILTERS', exact: true });
  await expect(filtersToggle).toHaveAttribute(
    'data-tooltip',
    'Configure sorting and valuation limits for Monitored tokens.',
  );
  await filtersToggle.hover();
  await page.waitForTimeout(300);
  await expect(filtersToggle).not.toHaveAttribute('data-tooltip-visible');
  await expect(filtersToggle).toHaveAttribute('data-tooltip-visible', 'true', { timeout: 1000 });
  const filterToggleBox = await filtersToggle.boundingBox();
  if (filterToggleBox) {
    await page.mouse.move(filterToggleBox.x + (filterToggleBox.width / 2) + 2, filterToggleBox.y + (filterToggleBox.height / 2));
  }
  await expect(filtersToggle).toHaveAttribute('data-tooltip-visible', 'true');
  const mcapMinInput = monitoredFilters.locator('[data-action="monitored-mcap-min"]');
  const mcapMaxInput = monitoredFilters.locator('[data-action="monitored-mcap-max"]');
  const fdvMinInput = monitoredFilters.locator('[data-action="monitored-fdv-min"]');
  const fdvMaxInput = monitoredFilters.locator('[data-action="monitored-fdv-max"]');
  await filtersToggle.click();
  await expect(filtersToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(monitoredFilters.locator('.monitored-filter-section-title')).toHaveText(['SORT ORDER', 'VALUATION LIMITS']);
  await expect(monitoredFilters.locator('.monitored-filter-row-label'))
    .toHaveText(['VOLUME WINDOW', 'MCAP / FDV ORDER', 'AGE ORDER']);
  await expect(monitoredFilters.locator('.monitored-filter-option'))
    .toHaveText(['5M', '1H', '6H', '24H', 'HIGHEST', 'LOWEST', 'NEWEST', 'OLDEST']);
  await expect(mcapMinInput).toHaveValue('30000');
  await expect(mcapMaxInput).toHaveValue('');
  await expect(fdvMinInput).toHaveValue('30000');
  await expect(fdvMaxInput).toHaveValue('');
  await mcapMinInput.click();
  await monitoredFilters.locator('.monitored-filters-hint').click();
  await expect(filtersToggle).toHaveAttribute('aria-expanded', 'true');
  await monitoredFilters.getByRole('button', { name: 'HIGHEST', exact: true }).click();
  await expect(filtersToggle).toHaveAttribute('aria-expanded', 'true');
  await mcapMinInput.fill('31000');
  await mcapMinInput.press('Escape');
  await expect(filtersToggle).toHaveAttribute('aria-expanded', 'false');
  expect(configPatchPayloads).toEqual([]);
  await filtersToggle.click();
  await expect(mcapMinInput).toHaveValue('30000');
  await expect(mcapMaxInput).toHaveValue('');
  await expect(fdvMinInput).toHaveValue('30000');
  await expect(fdvMaxInput).toHaveValue('');
  await mcapMaxInput.fill('20000');
  await page.locator('.monitored-panel-title').click();
  await expect(filtersToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(monitoredFilters.locator('[data-monitored-filters-error]'))
    .toHaveText('MCAP MAX MUST BE GREATER THAN OR EQUAL TO MIN');
  expect(configPatchPayloads).toEqual([]);
  await mcapMinInput.fill('45000');
  await mcapMaxInput.fill('950000');
  await fdvMinInput.fill('65000');
  await fdvMaxInput.fill('1250000');
  await page.locator('.monitored-panel-title').click();
  await expect.poll(() => configPatchPayloads).toContainEqual({
    'monitored-mcap-min': 45000,
    'monitored-view-mcap-max': 950000,
    'monitored-fdv-min': 65000,
    'monitored-view-fdv-max': 1250000,
  });
  await expect(page.locator('.monitored-header-bottom').getByRole('button', { name: 'MCAP / FDV', exact: true })).toHaveCount(0);
  await expect.poll(() => diagnostics.apiRequests.some((requestUrl) => {
    const url = new URL(requestUrl);
    return url.pathname === '/api/dashboard/monitored'
      && url.searchParams.get('minMcap') === '45000'
      && url.searchParams.get('maxMcap') === '950000'
      && url.searchParams.get('minFdv') === '65000'
      && url.searchParams.get('maxFdv') === '1250000';
  })).toBe(true);
  await expect(page.locator('#top-performers-section')).toContainText('TOPRHFRESH');
  await expect(page.locator('#top-performers-section')).toContainText('FDV');
  await expect.poll(() => compactChartRequestPayloads.some((payload) => (
    payload.identities?.some((identity) => (
      identity.chain === 'robinhood' && identity.address === ROBINHOOD_TOP
    ))
  ))).toBe(true);
  const topSparkline = page.locator(
    `.top-performer-card:not(.is-duplicate)[data-address="${ROBINHOOD_TOP}"] .sparkline-wrap`,
  );
  await expect(topSparkline).toHaveAttribute('data-chain', 'robinhood');
  await expect(topSparkline).toHaveAttribute('data-sparkline-key', `robinhood:${ROBINHOOD_TOP}`);
  await expect(topSparkline).toHaveAttribute('data-sparkline-summary', /Mini FDV chart · 2 pts/);
  const monitoredSparkline = robinhoodRow.locator('.monitored-mini-chart .sparkline-wrap');
  await expect(monitoredSparkline).toHaveAttribute('data-sparkline-key', `robinhood:${ROBINHOOD_TOKEN}`);
  await expect(monitoredSparkline.locator('[data-action="toggle-token-sparkline-range"]')).toHaveCount(0);
  const monitoredDefaultRange = page.locator('.monitored-panel .sparkline-range-button');
  await expect(monitoredDefaultRange).toHaveAttribute(
    'data-tooltip',
    'Select the default range used to load sparklines for Monitored and Manual tokens.',
  );
  await monitoredDefaultRange.click();
  const monitoredDefaultOptions = page.locator('.monitored-panel [data-action="set-sparkline-range-preset"]');
  await expect(monitoredDefaultOptions).toHaveText(['1H', '4H', '12H', '1D', '3D', '7D', '14D', 'ALL']);
  await page.locator('.monitored-panel [data-action="set-sparkline-range-preset"][data-sparkline-range-preset="all"]').click();
  await expect.poll(() => compactChartRequestPayloads.some((payload) => (
    payload.allAvailable === true
      && payload.points === 500
      && payload.granularityMinutes === 60
      && payload.identities?.some((identity) => identity.address === ROBINHOOD_TOKEN)
  ))).toBe(true);
  const monitoredQuickRanges = robinhoodRow.getByRole('group', { name: 'Monitored chart range' });
  await expect(monitoredQuickRanges).toHaveCSS('opacity', '0');
  await robinhoodRow.locator('.monitored-mini-chart-figure').hover();
  await expect(monitoredQuickRanges).toHaveCSS('opacity', '1');
  await expect(monitoredQuickRanges.locator('button')).toHaveCount(8);
  await expect(monitoredQuickRanges.locator('button')).toHaveText(['1h', '4h', '12h', '1d', '3d', '7d', '14d', 'all']);
  await monitoredQuickRanges.getByRole('button', { name: '4h', exact: true }).click();
  await expect.poll(() => compactChartRequestPayloads.some((payload) => (
    payload.hours === 4
      && payload.granularityMinutes === 1
      && payload.identities?.some((identity) => (
        identity.chain === 'robinhood' && identity.address === ROBINHOOD_TOKEN
      ))
  ))).toBe(true);
  await expect(monitoredQuickRanges.getByRole('button', { name: '4h', exact: true }))
    .toHaveAttribute('aria-pressed', 'true');
  await topSparkline.hover();
  await expect(topSparkline.locator('.sparkline-hover-tooltip')).toContainText('FDV');
  await topSparkline.locator('[data-action="toggle-token-sparkline-range"]').click();
  await topSparkline.locator('[data-action="set-token-sparkline-range-preset"][data-sparkline-range-preset="7d"]').click();
  await expect.poll(() => compactChartRequestPayloads.some((payload) => (
    payload.hours === 168 && payload.identities?.some((identity) => (
      identity.chain === 'robinhood' && identity.address === ROBINHOOD_TOP
    ))
  ))).toBe(true);
  await page.waitForTimeout(500);
  await expect(page.locator('.monitored-panel')).not.toContainText('RHSTALE');
  await expect(page.locator('#top-performers-section')).not.toContainText('TOPRHSTALE');

  const pinHandle = robinhoodRow.locator('.monitored-pin-handle');
  await pinHandle.click();
  await expect.poll(() => marketPinPayloads.length).toBe(1);
  expect(marketPinPayloads[0].chains).toEqual(['robinhood']);
  expect(marketPinPayloads[0].pinnedTokens[0].chain).toBe('robinhood');
  await expect(pinHandle).toHaveAttribute('data-pinned', 'true');
  await pinHandle.dblclick();
  await expect.poll(() => marketPinPayloads.length).toBe(2);
  expect(marketPinPayloads[1]).toEqual({ chains: ['robinhood'], pinnedTokens: [] });

  const marketRequests = diagnostics.apiRequests
    .map((requestUrl) => new URL(requestUrl))
    .filter((url) => (
      url.pathname === '/api/dashboard/monitored'
      || url.pathname === '/api/dashboard/top-performers'
    ));
  for (const path of ['/api/dashboard/monitored', '/api/dashboard/top-performers']) {
    const robinhoodRequest = marketRequests.find((url) => (
      url.pathname === path && url.searchParams.get('chains') === 'robinhood'
    ));
    expect(robinhoodRequest).toBeTruthy();
    expect(robinhoodRequest.searchParams.get('minMcap')).toBe('30000');
    expect(robinhoodRequest.searchParams.get('minFdv')).toBe('30000');
  }
  const robinhoodMonitoredPages = marketRequests.filter((url) => (
    url.pathname === '/api/dashboard/monitored'
      && url.searchParams.get('chains') === 'robinhood'
  ));
  expect(robinhoodMonitoredPages[0].searchParams.get('perPage')).toBe('100');
  expect(robinhoodMonitoredPages.some((url) => (
    url.searchParams.get('page') === '1'
      && url.searchParams.get('asOf') === '2026-07-14T18:00:00.000Z'
  ))).toBe(true);

  expect(diagnostics.unexpectedRequests).toEqual([]);
  expect(diagnostics.pageErrors).toEqual([]);
});

test('sends Robinhood identity through manual, star and block actions', async ({ page }) => {
  collectionMutationPayloads.length = 0;
  const diagnostics = await openAuthenticatedWorkspace(page, ROBINHOOD_COLLECTION_API_FIXTURES);
  const selector = page.getByRole('group', { name: 'Filter workspace by blockchain' });
  await selector.locator('[data-chain="robinhood"]').click();
  await selector.locator('[data-chain="solana"]').click();

  const robinhoodRow = page.locator(
    `.monitored-panel article.monitored-token-row[data-address="${ROBINHOOD_TOKEN}"]`,
  );
  await expect(robinhoodRow).toBeVisible();

  await robinhoodRow.locator('[data-action="toggle-star"]').click();
  await expect.poll(() => collectionMutationPayloads.length).toBe(1);

  await robinhoodRow.locator('[data-action="manual-quick-add"]').click();
  await expect.poll(() => collectionMutationPayloads.length).toBe(2);

  await robinhoodRow.locator('[data-action="block-token"]').click();
  await expect.poll(() => collectionMutationPayloads.length).toBe(3);

  assertCollectionMutation('star', {
    chain: 'robinhood', address: ROBINHOOD_TOKEN,
  });
  assertCollectionMutation('manual', {
    chain: 'robinhood', address: ROBINHOOD_TOKEN, label: null,
  });
  assertCollectionMutation('block', {
    chain: 'robinhood', address: ROBINHOOD_TOKEN,
  });
  expect(diagnostics.unexpectedRequests).toEqual([]);
  expect(diagnostics.pageErrors).toEqual([]);
});

test('renders compact expanded chart metrics with direct value tooltips', async ({ page }) => {
  const diagnostics = await openAuthenticatedWorkspace(page, ROBINHOOD_IDENTITY_BADGE_API_FIXTURES);
  const selector = page.getByRole('group', { name: 'Filter workspace by blockchain' });
  await selector.locator('[data-chain="robinhood"]').click();
  await selector.locator('[data-chain="solana"]').click();

  const row = page.locator(
    `.monitored-panel article.monitored-token-row[data-address="${ROBINHOOD_TOKEN}"]`,
  );
  await expect(row).toBeVisible();
  await row.locator('.monitored-mini-chart .sparkline-wrap').click();

  const dialog = page.locator('[data-auth-modal="expanded-sparkline"]');
  await expect(dialog).toBeVisible();
  await expect(page.locator('.workspace-market-ticker')).toHaveCSS('z-index', '980');
  await expect(page.locator('.workspace-market-ticker')).toBeVisible();
  const toolbar = dialog.locator('.expanded-sparkline-toolbar');
  await expect(toolbar).toHaveCSS('height', '28px');
  await expect(toolbar).toHaveCSS('padding', '0px 10px');
  await expect(toolbar.locator('.expanded-sparkline-avatar')).toHaveCSS('width', '16px');
  await expect(toolbar.locator('.expanded-sparkline-rank')).toHaveText('OG');
  await expect(toolbar.locator('.expanded-sparkline-network')).toHaveText('Robinhood Chain');
  await expect(toolbar.locator('.expanded-sparkline-stat-strip')).toContainText('FDV');
  await expect(toolbar.locator('.expanded-sparkline-stat-strip')).toContainText('LIQ');
  await expect(toolbar.locator('.expanded-sparkline-stat-strip')).toContainText('HOLDERS');
  const ageStat = toolbar.locator('.expanded-sparkline-stat-age');
  await expect(ageStat).toContainText('AGE');
  await expect(ageStat.locator('strong')).toHaveClass('warn');
  await expect(toolbar.locator('.expanded-sparkline-stat.is-active')).toContainText('1H');
  await expect(dialog.getByRole('group', { name: 'Chart resolution' })
    .getByRole('button', { name: '1M', exact: true })).toBeVisible();
  await expect(toolbar.locator('.expanded-sparkline-details')).toHaveCount(0);
  const liquidityValue = toolbar.locator('.expanded-sparkline-stat-hover').filter({ hasText: 'LIQ' })
    .locator('.expanded-sparkline-stat-hover-target');
  await liquidityValue.hover();
  await expect(liquidityValue.getByRole('tooltip')).toBeVisible();
  const holderValue = toolbar.locator('.expanded-sparkline-stat-hover').filter({ hasText: 'HOLDERS' })
    .locator('.expanded-sparkline-stat-hover-target');
  await holderValue.focus();
  await expect(holderValue.getByRole('tooltip')).toBeVisible();
  expect(diagnostics.unexpectedRequests).toEqual([]);
  expect(diagnostics.pageErrors).toEqual([]);
});

test('opens a Robinhood FDV chart and applies only its realtime updates', async ({ page }) => {
  chartRequestPayloads.length = 0;
  const socketScenario = { socket: null, clientFrames: [] };
  const diagnostics = await openAuthenticatedWorkspace(
    page,
    ROBINHOOD_ONE_MINUTE_MARKET_API_FIXTURES,
    '/',
    socketScenario,
  );

  await page.getByRole('group', { name: 'Filter workspace by blockchain' }).locator('[data-chain="robinhood"]').click();
  const robinhoodAlert = page.locator('article.alert-row[data-alert-id="backend:hvnc:102"]');
  await expect(robinhoodAlert).toBeVisible();
  await robinhoodAlert.locator('[data-action="open-alert-chart"]').click();
  await expect(page).toHaveURL(`/alerts/robinhood/${ROBINHOOD_TOKEN}`);

  const dialog = page.locator('[data-auth-modal="expanded-sparkline"]');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.expanded-sparkline-stat-strip')).toContainText('FDV');
  await expect(dialog.locator('.expanded-sparkline-footnote')).toHaveCount(0);
  const timeZoneControl = dialog.locator('.expanded-sparkline-time-zone-control');
  const timeZoneLabel = timeZoneControl.locator('[data-expanded-sparkline-time-zone-label]');
  await expect(timeZoneControl).toHaveCSS('width', '124px');
  await expect(timeZoneLabel).toContainText('(UTC');
  await expect(timeZoneLabel).toHaveCSS('white-space', 'nowrap');
  await expect(timeZoneLabel).toHaveCSS('overflow', 'hidden');
  await expect(dialog.locator('[data-expanded-candlestick-chart]')).toHaveAttribute(
    'aria-label',
    'Interactive FDV candlestick chart',
  );
  const granularityControls = dialog.getByRole('group', { name: 'Chart resolution' });
  const oneMinuteButton = granularityControls.getByRole('button', { name: '1M', exact: true });
  await expect(granularityControls.getByRole('button', { name: '15M', exact: true }))
    .toHaveAttribute('aria-pressed', 'true');
  await expect(granularityControls.getByRole('button', { name: '30M', exact: true })).toBeVisible();
  await expect(granularityControls).toHaveCSS('top', '8px');
  await expect(granularityControls).toHaveCSS('left', '8px');
  await expect(granularityControls).toHaveCSS('width', '205px');
  await expect(granularityControls).toHaveCSS('height', '24px');
  await expect(oneMinuteButton).toHaveCSS('height', '18px');
  await expect(oneMinuteButton).toBeVisible();
  await oneMinuteButton.click();
  await expect(oneMinuteButton).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => chartRequestPayloads.some((payload) => payload.granularityMinutes === 1)).toBe(true);
  await expect(dialog.locator('.expanded-chart-alert-marker')).toHaveCount(1);
  await expect.poll(() => chartRequestPayloads.some((payload) => payload.granularityMinutes === 15)).toBe(true);
  expect(chartRequestPayloads[0]).toMatchObject({
    chain: 'robinhood', address: ROBINHOOD_TOKEN, granularityMinutes: 15,
    allAvailable: true, points: 10_000,
  });
  expect(chartRequestPayloads.find((payload) => payload.granularityMinutes === 1)).toMatchObject({
    allAvailable: false, points: 10_000,
  });
  await expect.poll(() => socketScenario.clientFrames.some((frame) => (
    frame.includes('"market:sync"') && frame.includes(`"address":"${ROBINHOOD_TOKEN}"`)
  ))).toBe(true);
  await expect.poll(() => socketScenario.clientFrames.some((frame) => (
    frame.includes('"market:trade:sync"') && frame.includes(`"address":"${ROBINHOOD_TOKEN}"`)
  ))).toBe(true);

  const tradesPanel = dialog.locator('[data-robinhood-trades-panel]');
  await expect(tradesPanel).toHaveCSS('width', '300px');
  const tradesHead = tradesPanel.locator('.robinhood-trades-head');
  const tradeScopes = tradesPanel.locator('.robinhood-trades-scopes');
  await expect(tradesHead).toHaveCSS('padding', '6px 10px');
  await expect(tradeScopes).toHaveCSS('height', '24px');
  const scopeContainment = await tradesPanel.evaluate((panel) => {
    const head = panel.querySelector('.robinhood-trades-head').getBoundingClientRect();
    const scopes = panel.querySelector('.robinhood-trades-scopes').getBoundingClientRect();
    return { headBottom: head.bottom, scopesBottom: scopes.bottom };
  });
  expect(scopeContainment.scopesBottom).toBeLessThanOrEqual(scopeContainment.headBottom);
  await expect(tradesPanel).toContainText('$10');
  sendSocketEvent(socketScenario, 'market:trade', {
    type: 'market:trade', chain: 'robinhood', address: ROBINHOOD_TOKEN,
    transactionHash: `0x${'3'.repeat(64)}`, actionIndex: 2, blockNumber: 100,
    blockTime: '2026-07-15T11:01:00.000Z', side: 'sell',
    walletAddress: `0x${'4'.repeat(40)}`, amountUsd: 777, priceUsd: 0.2, mcUsd: 420000,
  });
  await expect(tradesPanel).toContainText('$777');

  await tradesPanel.getByRole('tab', { name: 'Dev' }).click();
  await expect(tradesPanel.getByRole('tab', { name: 'Dev' })).toHaveAttribute('aria-selected', 'true');
  await expect(tradesPanel).toContainText('$25');
  await expect(tradesPanel).not.toContainText('$777');
  sendSocketEvent(socketScenario, 'market:trade', {
    type: 'market:trade', chain: 'robinhood', address: ROBINHOOD_TOKEN,
    transactionHash: `0x${'5'.repeat(64)}`, actionIndex: 3, blockNumber: 101,
    blockTime: '2026-07-15T11:02:00.000Z', side: 'buy',
    walletAddress: `0x${'4'.repeat(40)}`, amountUsd: 999, priceUsd: 0.2, mcUsd: 420000,
  });
  await expect(tradesPanel).not.toContainText('$999');
  sendSocketEvent(socketScenario, 'market:trade', {
    type: 'market:trade', chain: 'robinhood', address: ROBINHOOD_TOKEN,
    transactionHash: `0x${'6'.repeat(64)}`, actionIndex: 4, blockNumber: 102,
    blockTime: '2026-07-15T11:03:00.000Z', side: 'buy',
    walletAddress: ROBINHOOD_DEV, amountUsd: 888, priceUsd: 0.2, mcUsd: 420000,
  });
  await expect(tradesPanel).toContainText('$888');

  const legend = dialog.locator('[data-expanded-chart-legend]');
  await expect(legend).toContainText('350K');
  await expect(dialog.locator('[data-auth-panel="expanded-sparkline"]'))
    .toHaveCSS('background-color', 'rgb(5, 12, 22)');
  await expect(dialog.locator('.expanded-sparkline-toolbar'))
    .toHaveCSS('background-color', 'rgb(7, 16, 26)');
  await expect(dialog.locator('.expanded-sparkline-stat.is-active'))
    .toHaveCSS('color', 'rgb(0, 212, 255)');
  const chartTools = await dialog.evaluate(() => {
    const resolutions = document.querySelector('.expanded-sparkline-resolution-control').getBoundingClientRect();
    const chartLegend = document.querySelector('[data-expanded-chart-legend]').getBoundingClientRect();
    return {
      resolutionsBottom: resolutions.bottom,
      resolutionsWidth: resolutions.width,
      legendTop: chartLegend.top,
      legendWidth: chartLegend.width,
    };
  });
  expect(chartTools.legendTop).toBeGreaterThanOrEqual(chartTools.resolutionsBottom + 4);
  expect(Math.abs(chartTools.legendWidth - chartTools.resolutionsWidth)).toBeLessThanOrEqual(1);
  const livePayload = {
    type: 'market:bucket', address: ROBINHOOD_TOKEN,
    bucketTs: '2026-07-15T11:01:00.000Z', granularityMinutes: 1,
    sequence: 'robinhood:000000000000000000000002:000000000000000000000001:000000000000000000000001',
    valuation: { type: 'fdv', fdvUsd: 420000, observedAt: '2026-07-15T11:01:10.000Z' },
    candle: {
      bucketTs: '2026-07-15T11:01:00.000Z', granularityMinutes: 1,
      openFdvUsd: 350000, highFdvUsd: 425000, lowFdvUsd: 340000,
      closeFdvUsd: 420000, sampleCount: 4,
    },
  };
  sendSocketEvent(socketScenario, 'market:bucket', { ...livePayload, chain: 'robinhood' });
  await expect(legend).toContainText('420K');

  sendSocketEvent(socketScenario, 'market:bucket', {
    ...livePayload,
    chain: 'base',
    sequence: 'base:000000000000000000000003:000000000000000000000001:000000000000000000000001',
    valuation: { ...livePayload.valuation, fdvUsd: 999000 },
    candle: { ...livePayload.candle, closeFdvUsd: 999000 },
  });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(legend).not.toContainText('999K');
  const alertHistoryRequest = diagnostics.apiRequests.find((requestUrl) => (
    new URL(requestUrl).pathname === '/api/dashboard/chart-alert-events'
  ));
  expect(alertHistoryRequest).toBeTruthy();
  expect(new URL(alertHistoryRequest).searchParams.get('chain')).toBe('robinhood');
  expect(new URL(alertHistoryRequest).searchParams.get('address')).toBe(ROBINHOOD_TOKEN);
  expect(diagnostics.unexpectedRequests).toEqual([]);
  expect(diagnostics.pageErrors).toEqual([]);
});

test('renders and switches Robinhood holder hover bars', async ({ page }) => {
  const socketScenario = { socket: null, clientFrames: [] };
  const diagnostics = await openAuthenticatedWorkspace(
    page, ROBINHOOD_ONE_MINUTE_MARKET_API_FIXTURES, '/alerts', socketScenario,
  );
  await page.evaluate(() => {
    document.querySelector('[aria-label="Filter workspace by blockchain"] [data-chain="robinhood"]')?.click();
  });
  const row = page.locator(`article.monitored-token-row[data-address="${ROBINHOOD_TOKEN}"]`);
  await expect(row).toBeVisible();
  const holderTrigger = row.locator('[data-holder-hover-address]');
  expect(await holderTrigger.getAttribute('title')).toBeNull();
  expect(await holderTrigger.evaluate((element) => ({
    color: getComputedStyle(element).color,
    cursor: getComputedStyle(element).cursor,
  }))).toEqual({ color: 'rgb(255, 255, 255)', cursor: 'text' });
  await holderTrigger.hover();
  const holderHover = page.locator('[data-holder-hover-card]');
  await expect(holderHover).toBeVisible();
  await expect(holderHover.locator('[data-holder-hover-count]')).toHaveText('4,424');
  await expect(holderHover.locator('.rh-holder-hover-delta')).toHaveCount(4);
  await expect(holderHover).toContainText('+4 / +0.09%');
  await expect(holderHover.locator('[data-holder-hover-bar]')).toHaveCount(179);
  await expect(holderHover.locator('[data-holder-hover-bar].is-positive, [data-holder-hover-bar].is-negative, [data-holder-hover-bar].is-unavailable')).toHaveCount(0);
  expect(await holderHover.locator('[data-holder-hover-bar]').evaluateAll((bars) => bars.every((bar) => {
    const y = Number(bar.getAttribute('y'));
    const height = Number(bar.getAttribute('height'));
    return height >= 24 && Math.abs((y + height) - 96) < 0.01;
  }))).toBe(true);
  const hoverPosition = await holderHover.evaluate((element) => ({
    left: getComputedStyle(element).left, top: getComputedStyle(element).top,
  }));
  await holderHover.getByRole('button', { name: '24H', exact: true }).click();
  await page.waitForTimeout(180);
  await expect(holderHover).toBeVisible();
  await expect(holderHover.getByRole('button', { name: '24H', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(holderHover.locator('[data-holder-hover-bar]')).toHaveCount(29);
  expect(await holderHover.locator('[data-holder-hover-bar]').last().evaluate((bar) => (
    Number(bar.getAttribute('x')) + Number(bar.getAttribute('width'))
  ))).toBeGreaterThan(990);
  expect(await holderHover.evaluate((element) => ({
    left: getComputedStyle(element).left, top: getComputedStyle(element).top,
  }))).toEqual(hoverPosition);
  expect(diagnostics.unexpectedRequests).toEqual([]);
  expect(diagnostics.pageErrors).toEqual([]);
});

test('renders holder pages without the holder bar chart in the Robinhood expanded chart', async ({ page }) => {
  const socketScenario = { socket: null, clientFrames: [] };
  const diagnostics = await openAuthenticatedWorkspace(
    page, ROBINHOOD_ONE_MINUTE_MARKET_API_FIXTURES, '/alerts', socketScenario,
  );
  await page.getByRole('group', { name: 'Filter workspace by blockchain' })
    .locator('[data-chain="robinhood"]').click();
  const row = page.locator(`article.monitored-token-row[data-address="${ROBINHOOD_TOKEN}"]`);
  await expect(row).toBeVisible();
  const holderTrigger = row.locator('[data-holder-hover-address]');
  await holderTrigger.hover();
  const holderHover = page.locator('[data-holder-hover-card]');
  await expect(holderHover).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(holderHover).toBeHidden();
  await row.locator('.monitored-mini-chart .sparkline-wrap').click();

  const dialog = page.locator('[data-auth-modal="expanded-sparkline"]');
  await expect(dialog).toBeVisible();
  const panel = dialog.locator('[data-holder-panel]');
  await expect(panel).toBeVisible();
  await expect(dialog.locator('[data-holder-tab]')).toHaveCount(0);
  await expect(dialog.locator('[data-holder-chart-view]')).toBeVisible();
  await expect(dialog.locator('[data-robinhood-trades-panel]')).toBeVisible();
  await expect(panel.locator('[data-holder-history]')).toHaveCount(0);
  await expect(panel.locator('[data-holder-bar]')).toHaveCount(0);
  await expect(panel.locator('[data-holder-count]')).toHaveCount(0);
  const holderStat = dialog.locator('.expanded-sparkline-stat-hover').filter({ hasText: 'HOLDERS' });
  await expect(holderStat).toBeAttached();
  await expect.poll(() => socketScenario.clientFrames.some((frame) => (
    frame.includes('"market:sync"') && frame.includes(`"address":"${ROBINHOOD_TOKEN}"`)
  ))).toBe(true);
  const holderCount = holderStat.locator('[data-holder-count]');
  const holderPayload = {
    type: 'holder:count', chain: 'robinhood', address: ROBINHOOD_TOKEN,
    holderCount: 4429, source: 'ledger_live', observedAt: '2026-07-15T12:01:00.000Z',
    ledgerVersion: '7', liveThroughBlock: '32653260', liveThroughHash: `0x${'b'.repeat(64)}`,
    sequence: `robinhood-holder:${ROBINHOOD_TOKEN}:000000000000000000000007`,
  };
  sendSocketEvent(socketScenario, 'holder:count', holderPayload);
  await expect(holderCount).toHaveText('4,429');
  sendSocketEvent(socketScenario, 'holder:count', { ...holderPayload, holderCount: 9999 });
  await expect(holderCount).toHaveText('4,429');
  const holderReads = diagnostics.apiRequests.filter((requestUrl) => (
    new URL(requestUrl).pathname === '/api/robinhood/holder-count-series'
  )).length;
  sendSocketEvent(socketScenario, 'holder:invalidate', {
    ...holderPayload, type: 'holder:invalidate', holderCount: undefined,
    ledgerVersion: '8', sequence: `robinhood-holder:${ROBINHOOD_TOKEN}:000000000000000000000008`,
    reason: 'reorg_resync',
  });
  await expect(holderCount).toHaveText('4,424');
  expect(diagnostics.apiRequests.filter((requestUrl) => (
    new URL(requestUrl).pathname === '/api/robinhood/holder-count-series'
  ))).toHaveLength(holderReads);
  await expect(panel).toContainText('Main whale');
  await expect(panel.locator('.rh-remaining-pct').first()).toHaveText('10%');
  await expect(panel.locator('.rh-native-balance').first()).toHaveText('3.4 Ξ');
  await expect(panel.locator('.rh-financial-cell').nth(0)).toContainText('$18.4K@125K');
  await expect(panel.locator('.rh-financial-cell').nth(1)).toContainText('$44.8K@200K');
  await expect(panel.locator('.rh-pnl').first()).toContainText('+$5K');
  await expect(panel.locator('.rh-pnl').first()).toContainText('10%');
  await expect(panel.locator('.rh-holder-distribution')).toHaveCSS('width', '300px');
  await expect(panel.locator('.rh-holder-distribution')).toContainText('Top 10');
  await expect(panel.locator('.rh-holder-distribution')).toContainText('10%');
  await expect(panel.locator('.rh-distribution-flags')).toContainText('DEV HOLD1.2%');
  await expect(panel.locator('.rh-distribution-flags')).toContainText('BUNDLED10%');
  await expect(panel.locator('tbody .rh-holder-glyph').first()).toHaveText('◈');
  await expect(panel.locator('tbody .rh-holder-glyph').first()).toHaveAttribute(
    'title', 'BUNDLED · connected_funding_launch_cluster',
  );
  await expect(panel.getByRole('button', { name: 'BUNDLED' })).toBeEnabled();
  const insidersFilter = panel.getByRole('button', { name: 'INSIDERS' });
  await expect(insidersFilter).toBeEnabled();
  const insiderRequest = page.waitForRequest((request) => (
    request.url().includes('/api/robinhood/holders')
      && new URL(request.url()).searchParams.get('filter') === 'insiders'
  ));
  await insidersFilter.click();
  await insiderRequest;
  await expect(insidersFilter).toHaveClass(/active/);
  await expect(panel.locator('.robinhood-holder-table-wrap')).toHaveCSS('overflow-y', 'auto');
  await expect(panel.locator('tbody tr').first()).toHaveCSS('height', '26px');
  expect(await panel.locator('tbody .rh-col-holder').first().evaluate((cell) => (
    cell.lastElementChild?.classList.contains('rh-holder-glyph')
  ))).toBe(true);
  await expect(dialog.locator('.expanded-sparkline-chart.has-trades')).toHaveCSS('gap', '0px');
  await expect(dialog.locator('[data-auth-panel="expanded-sparkline"]'))
    .toHaveCSS('background-color', 'rgb(0, 0, 0)');

  const resizeHandle = dialog.locator('[data-holder-resize-handle]');
  const beforeResize = await dialog.evaluate((element) => ({
    holders: element.querySelector('[data-holder-panel]')?.getBoundingClientRect().height ?? 0,
    chart: element.querySelector('[data-holder-chart-view]')?.getBoundingClientRect().height ?? 0,
  }));
  await resizeHandle.press('ArrowUp');
  const afterResize = await dialog.evaluate((element) => ({
    holders: element.querySelector('[data-holder-panel]')?.getBoundingClientRect().height ?? 0,
    chart: element.querySelector('[data-holder-chart-view]')?.getBoundingClientRect().height ?? 0,
  }));
  expect(afterResize.holders).toBeGreaterThan(beforeResize.holders);
  expect(afterResize.chart).toBeLessThan(beforeResize.chart);

  await panel.getByRole('button', { name: 'Next' }).click();
  await expect(panel).toContainText('Second page whale');
  await panel.getByRole('button', { name: 'Previous' }).click();
  await expect(panel).toContainText('Main whale');
  await expect(dialog.locator('[data-holder-chart-view]')).toBeVisible();
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  await holderTrigger.focus();
  await expect(holderHover).toBeVisible();
  await holderHover.getByRole('button', { name: '24H', exact: true }).click();
  await holderTrigger.evaluate((element) => {
    window.__holderHoverStableTarget = element;
  });
  const holderReadsOnHover = diagnostics.apiRequests.filter((requestUrl) => (
    new URL(requestUrl).pathname === '/api/robinhood/holder-count-series'
  )).length;
  sendSocketEvent(socketScenario, 'market:bucket', {
    type: 'market:bucket', chain: 'robinhood', address: ROBINHOOD_TOKEN,
    bucketTs: '2026-07-15T12:01:00.000Z', granularityMinutes: 1,
    sequence: 'robinhood:000000000000000000000010:000000000000000000000001:000000000000000000000001',
    valuation: { type: 'fdv', fdvUsd: 360000, observedAt: '2026-07-15T12:01:10.000Z' },
    candle: {
      bucketTs: '2026-07-15T12:01:00.000Z', granularityMinutes: 1,
      openFdvUsd: 350000, highFdvUsd: 365000, lowFdvUsd: 348000,
      closeFdvUsd: 360000, sampleCount: 4,
    },
  });
  await expect(row.locator('.monitored-meta-line')).toContainText('$360K');
  expect(await row.locator('[data-holder-hover-address]').evaluate((element) => (
    element === window.__holderHoverStableTarget
  ))).toBe(true);
  await expect(holderHover).toBeVisible();
  await expect(holderHover.getByRole('button', { name: '24H', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(holderHover.locator('[data-holder-hover-bar]')).toHaveCount(29);
  expect(diagnostics.apiRequests.filter((requestUrl) => (
    new URL(requestUrl).pathname === '/api/robinhood/holder-count-series'
  ))).toHaveLength(holderReadsOnHover);
  expect(diagnostics.unexpectedRequests).toEqual([]);
  expect(diagnostics.pageErrors).toEqual([]);
});

test('renders Robinhood peer badges and terminals across tracked token lists', async ({ page }) => {
  const diagnostics = await openAuthenticatedWorkspace(page, ROBINHOOD_RADAR_API_FIXTURES);
  const monitoredRow = page.locator(
    `.monitored-panel article.monitored-token-row[data-address="${ROBINHOOD_TOKEN}"]`,
  );
  await expect(monitoredRow).toBeVisible();
  await expect(monitoredRow.locator('.monitored-ticker-peer-badge')).toHaveText('#1');
  await expect(monitoredRow.locator('.trade-link')).toHaveCount(2);
  await expect(monitoredRow).toContainText('HOLDERS 4,424');
  await expect(monitoredRow.locator('.trade-link.axiom, .trade-link.padre')).toHaveCount(0);
  await expect(monitoredRow.locator('.trade-link.gmgn'))
    .toHaveAttribute('href', `https://gmgn.ai/robinhood/token/${ROBINHOOD_TOKEN}`);
  const manualRow = page.locator(`#manual-tokens-section tr[data-token-identity="robinhood:${ROBINHOOD_MANUAL}"]`);
  await expect(manualRow).toBeVisible();
  await expect(manualRow.locator('.monitored-ticker-peer-badge')).toHaveText('OG');
  await expect(manualRow.locator('.trade-link')).toHaveCount(2);
  await expect(manualRow.locator('.radar-size-item').filter({ hasText: 'HLD' })).toContainText('2,001');
  await expect(manualRow.locator('.trade-link.axiom, .trade-link.padre')).toHaveCount(0);
  await expect(manualRow.locator('.trade-link.fomo'))
    .toHaveAttribute('href', `https://fomo.family/tokens/robinhood/${ROBINHOOD_MANUAL}`);
  await page.goto('/radar');

  const recentRow = page.locator(
    `.recent-bar tr[data-token-identity="robinhood:${ROBINHOOD_TOKEN}"]`,
  );
  await expect(recentRow).toBeVisible();
  await expect(recentRow.locator('.monitored-ticker-peer-badge')).toHaveText('#1');
  await expect(recentRow.locator('.trade-link')).toHaveCount(2);
  await expect(recentRow.locator('.radar-size-item').filter({ hasText: 'HLD' })).toContainText('4,424');
  await expect(recentRow.locator('.trade-link.gmgn'))
    .toHaveAttribute('href', `https://gmgn.ai/robinhood/token/${ROBINHOOD_TOKEN}`);
  const oldRow = page.locator(
    `.old-week-bar tr[data-token-identity="robinhood:${ROBINHOOD_OLD}"]`,
  );
  await expect(oldRow).toBeVisible();
  await expect(oldRow.locator('.monitored-ticker-peer-badge')).toHaveText('#1');
  await expect(oldRow.locator('.trade-link')).toHaveCount(2);
  await expect(oldRow.locator('.radar-size-item').filter({ hasText: 'HLD' })).toContainText('4,424');
  await expect(oldRow.locator('.trade-link.gmgn'))
    .toHaveAttribute('href', `https://gmgn.ai/robinhood/token/${ROBINHOOD_OLD}`);
  const solanaRow = page.locator(
    `.recent-bar tr[data-token-identity="solana:${SOLANA_TOP}"]`,
  );
  await expect(solanaRow.locator('.radar-size-item').filter({ hasText: 'HLD' }).locator('dd')).toHaveText('-');

  expect(diagnostics.unexpectedRequests).toEqual([]);
  expect(diagnostics.pageErrors).toEqual([]);
});

test('renders Radar valuation freshness and follows the master chain filter', async ({ page }) => {
  radarBootstrapPayloads.length = 0;
  compactChartRequestPayloads.length = 0;
  const diagnostics = await openAuthenticatedWorkspace(page, ROBINHOOD_RADAR_API_FIXTURES);
  await page.goto('/radar');

  const radarChainSelector = page.getByRole('group', { name: 'Filter workspace by blockchain' });
  const solanaChainButton = radarChainSelector.locator('[data-chain="solana"]');
  const robinhoodChainButton = radarChainSelector.locator('[data-chain="robinhood"]');
  await expect(solanaChainButton).toHaveAttribute('aria-pressed', 'true');
  await expect(robinhoodChainButton).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => radarBootstrapPayloads.some((payload) => (
    payload.chains?.length === 2
      && payload.chains.includes('solana')
      && payload.chains.includes('robinhood')
  ))).toBe(true);
  await solanaChainButton.click();
  await expect(solanaChainButton).toHaveAttribute('aria-pressed', 'false');
  await expect(robinhoodChainButton).toBeDisabled();
  await expect.poll(() => radarBootstrapPayloads.some((payload) => (
    payload.chains?.length === 1 && payload.chains[0] === 'robinhood'
  ))).toBe(true);
  await solanaChainButton.click();
  await expect(solanaChainButton).toHaveAttribute('aria-pressed', 'true');
  const solanaIdentity = `solana:${SOLANA_TOP}`;
  const solanaRow = page.locator(`.recent-bar tbody tr[data-token-identity="${solanaIdentity}"]`);
  await expect(solanaRow).toBeVisible();
  await expect(solanaRow).toContainText('RADARSOL');

  const identity = `robinhood:${ROBINHOOD_TOKEN}`;
  const row = page.locator(`.recent-bar tbody tr[data-token-identity="${identity}"]`);
  await expect(row).toBeVisible();
  await expect(row.locator('.token-launchpad-pons')).toHaveAttribute('aria-label', 'pons');
  await expect(row.locator('.token-launchpad-pons'))
    .toHaveAttribute('title', 'pons · Pool: Uniswap V3');
  await expect(row.locator('.token-launchpad-pons')).not.toHaveCSS('cursor', 'help');
  await expect(row).toContainText('RADARST');
  await expect(row).toContainText('FDV $350K');
  await expect(row).toContainText('STALE VALUATION');
  await expect(row).toContainText('NO RECENT ACTIVITY');
  await expect(row.locator('.radar-coverage-partial')).toContainText(['~', '~']);
  await expect(row.locator('.radar-coverage-unavailable').first()).toHaveText('-');
  await expect(row.locator('.radar-coverage-complete')).toContainText(['$0', '+0.00%']);
  const radarSparkline = row.locator('.sparkline-wrap');
  await expect(radarSparkline).toHaveAttribute('data-chain', 'robinhood');
  await expect(radarSparkline).toHaveAttribute('data-sparkline-summary', /Mini FDV chart · 2 pts/);

  const recentBar = page.locator('.recent-bar');
  const recentRangeButton = recentBar.locator('.sparkline-range-button');
  await expect(recentRangeButton).toHaveAttribute(
    'data-tooltip',
    'Select the default range used to load sparklines for Recent tokens.',
  );
  await recentRangeButton.click();
  await expect(recentBar.locator('[data-action="set-sparkline-range-preset"]'))
    .toHaveText(['1H', '4H', '12H', '1D', '3D', '7D', '14D', 'ALL']);
  await recentBar.locator('[data-action="set-sparkline-range-preset"][data-sparkline-range-preset="all"]').click();
  await expect.poll(() => compactChartRequestPayloads.some((payload) => (
    payload.allAvailable === false
      && payload.hours >= 120
      && payload.hours <= 121
      && payload.points === 500
      && payload.granularityMinutes === 15
      && payload.identities?.some((item) => item.address === ROBINHOOD_TOKEN)
  ))).toBe(true);
  await expect(page.locator('.old-week-bar [data-action="set-sparkline-range-preset"][data-sparkline-range-preset="all"]')).toHaveText('ALL');
  await expect(recentBar.locator('input[name="old-mcap-min"]')).toHaveValue('120000');
  await expect(recentBar.locator('input[name="old-fdv-min"]')).toHaveValue('130000');
  await expect(recentBar.locator('input[name="old-fdv-max"]')).toHaveValue('90000000');
  const valuationPopover = recentBar.locator('.history-valuation-popover');
  await expect(valuationPopover).toBeHidden();
  await recentBar.locator('[data-action="history-valuation-toggle"]').click();
  await expect(valuationPopover).toBeVisible();
  const filterGeometry = await recentBar.locator('.recent-ctrl-filters').evaluate((filters) => {
    const ageRect = filters.querySelector('input[name="recent-age-min"]')
      ?.closest('.recent-ctrl-cluster')?.getBoundingClientRect();
    const sort = filters.querySelector('.recent-ctrl-cluster-sort');
    const sortRect = sort?.getBoundingClientRect();
    return {
      ageCenter: ageRect ? ageRect.top + (ageRect.height / 2) : null,
      sortCenter: sortRect ? sortRect.top + (sortRect.height / 2) : null,
      sortButtonTops: [...(sort?.querySelectorAll('.old-filter-btn') || [])]
        .map((button) => button.getBoundingClientRect().top),
    };
  });
  expect(filterGeometry.ageCenter).toBe(filterGeometry.sortCenter);
  expect(new Set(filterGeometry.sortButtonTops).size).toBe(1);
  // The compact toolbar drops the divider between sort pills; the alignment
  // assertions above stay as the real regression guard for this cluster.
  await expect(recentBar.locator('.recent-ctrl-cluster-sort .sort-menu-wrap').nth(1))
    .toHaveCSS('border-left-width', '0px');
  const fdvMinInput = recentBar.locator('input[name="old-fdv-min"]');
  await fdvMinInput.fill('175000');
  await fdvMinInput.press('Enter');
  await expect.poll(() => radarBootstrapPayloads.some((payload) => (
    payload.recent?.mcapMin === 120000 && payload.recent?.fdvMin === 175000
  ))).toBe(true);

  expect(diagnostics.unexpectedRequests).toEqual([]);
  expect(diagnostics.pageErrors).toEqual([]);
});

function assertCollectionMutation(action, expectedPayload) {
  expect(collectionMutationPayloads.find((item) => item.action === action)?.payload)
    .toMatchObject(expectedPayload);
}
