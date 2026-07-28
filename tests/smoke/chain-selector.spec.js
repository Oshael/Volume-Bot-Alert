const { expect, test } = require('@playwright/test');

const SOLANA_MANUAL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOLANA_MONITORED = 'So11111111111111111111111111111111111111112';
const SOLANA_TOP = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const SOLANA_BLOCKED = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6QXgB263vZyVfSRm';
const ROBINHOOD_TOKEN = '0xabcdef0123456789abcdef0123456789abcdef01';
const ROBINHOOD_TOP = '0xabcdef0123456789abcdef0123456789abcdef02';

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
    enabledTradeTerminals: ['axiom', 'photon', 'bullx', 'gmgn', 'padre'],
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
          symbol: 'RHV',
          mcap: null,
          fdv: 500000,
          valuationType: 'fdv',
          priceUsd: 0.0042,
          liquidityUsd: 5000,
          transactions: 15,
          volume5m: 2000,
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

function marketToken(chain, symbol) {
  const isTop = symbol.startsWith('TOP');
  return chain === 'robinhood'
    ? {
        chain,
        address: isTop ? ROBINHOOD_TOP : ROBINHOOD_TOKEN,
        symbol,
        name: `${symbol} Robinhood`,
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
      points: 720,
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

const ROBINHOOD_ONE_MINUTE_MARKET_API_FIXTURES = {
  ...ROBINHOOD_MARKET_API_FIXTURES,
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
  ...ROBINHOOD_MARKET_API_FIXTURES,
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
    return {
      generatedAt: '2026-07-14T18:00:00.000Z',
      asOf: '2026-07-14T18:00:00.000Z',
      recent: { total: recentTokens.length, page: 0, perPage: 15, count: recentTokens.length, hasMore: false, tokens: recentTokens, pinnedTokens: [] },
      oldWeek: { total: 0, page: 0, perPage: 15, count: 0, hasMore: false, tokens: [], pinnedTokens: [] },
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
  await dialog.getByRole('tab', { name: 'Alerts & Chains' }).click();

  const alertFeedMenu = dialog.locator('[data-chain-filter-surface="alertFeedChains"]');
  const alertFeedToggle = alertFeedMenu.locator('.config-menu-button');
  await expect(alertFeedToggle).toHaveText('1/1 on');
  await alertFeedToggle.click();
  await expect(alertFeedMenu.locator('[data-chain-filter-chain="solana"]')).toBeVisible();
  await expect(alertFeedMenu.locator('[data-chain-filter-chain="solana"]')).toBeDisabled();
  await alertFeedToggle.click();
  await expect(alertFeedMenu.locator('.config-menu-dropdown')).toBeHidden();

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

test('filters a combined Solana and Robinhood alert feed through master and surface selectors', async ({ page }) => {
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

  const manualForm = manualSection.locator('[data-role="manual-token-form"]');
  const manualAddress = manualForm.locator('input[name="address"]');
  await expect(manualAddress).toBeHidden();
  await manualForm.getByRole('button', { name: 'Add manual token' }).click();
  await expect(manualAddress).toBeVisible();
  await manualForm.getByRole('button', { name: 'Token chain: Solana' }).click();
  await manualForm.getByRole('menuitemradio', { name: 'Robinhood Chain' }).click();
  await expect(manualForm.locator('[data-action="manual-token-chain"]')).toHaveValue('robinhood');
  await manualAddress.press('Escape');
  await expect(manualAddress).toBeHidden();

  await manualSection.getByRole('button', { name: 'Open actions for Watchlist' }).click();
  const folderEntry = manualSection.locator('.manual-folder-add-inline[data-folder-id="1"]');
  const folderAddress = folderEntry.locator('[data-action="manual-folder-token-input"]');
  await expect(folderAddress).toBeHidden();
  await folderEntry.getByRole('button', { name: 'Add token to Watchlist' }).click();
  await expect(folderAddress).toBeVisible();
  await folderAddress.press('Escape');
  await expect(folderAddress).toBeHidden();

  await expect(selector.locator('.workspace-chain-selector-btn')).toHaveCount(2);
  await expect(solanaButton).toHaveAttribute('aria-pressed', 'true');
  await expect(robinhoodButton).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => page.evaluate(() => window.trendscopeAlertDebug?.snapshot()?.memory?.count)).toBe(2);
  await expect(solanaAlert).toBeVisible();
  await expect(robinhoodAlert).toHaveCount(0);

  await page.getByRole('button', { name: 'Open user menu' }).click();
  await page.getByRole('button', { name: 'Bot Settings' }).click();
  const dialog = page.getByRole('dialog', { name: 'Bot Settings' });
  await dialog.getByRole('tab', { name: 'Alerts & Chains' }).click();
  const alertFeedMenu = dialog.locator('[data-chain-filter-surface="alertFeedChains"]');
  await expect(alertFeedMenu.locator('.config-menu-button')).toHaveText('1/2 on');
  await alertFeedMenu.locator('.config-menu-button').click();
  await alertFeedMenu.locator('[data-chain-filter-chain="robinhood"]').click();
  await expect(alertFeedMenu.locator('.config-menu-button')).toHaveText('2/2 on');
  await dialog.getByRole('button', { name: 'Close dialog' }).click();

  await expect(solanaAlert).toBeVisible();
  await expect(robinhoodAlert).toBeVisible();
  await expect(robinhoodAlert).toContainText('5m vol');
  await expect(robinhoodAlert).toContainText('FDV');

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
  await page.getByRole('button', { name: 'Open user menu' }).click();
  await page.getByRole('button', { name: 'Blocked Tokens' }).click();
  const blockedTokensModal = page.locator('[data-auth-modal="blocked-tokens"]');
  await expect(blockedTokensModal).not.toContainText('BLOCKSOL');
  await expect(blockedTokensModal.locator('[data-chain-readiness-surface="blocklist"]')).toHaveCount(0);
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

test('places expanded token identity badges below the subtitle', async ({ page }) => {
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
  const identityCopy = dialog.locator('.expanded-sparkline-identity-copy');
  const identityBadges = identityCopy.locator(':scope > .expanded-sparkline-identity-badges');
  await expect(identityCopy.locator(':scope > strong .token-chain-badge')).toHaveCount(0);
  await expect(identityBadges.locator('.monitored-ticker-peer-badge')).toHaveText('OG');
  await expect(identityBadges.locator('.token-chain-badge')).toHaveAttribute('data-chain', 'robinhood');
  const expandedAge = dialog.locator('.expanded-sparkline-stat-age > strong');
  await expect(expandedAge).toHaveClass('warn');
  await expect(expandedAge).toHaveCSS('color', 'rgb(255, 138, 0)');
  const identityRows = await identityCopy.evaluate((copy) => {
    const subtitle = copy.querySelector(':scope > small')?.getBoundingClientRect();
    const badges = copy.querySelector(':scope > .expanded-sparkline-identity-badges')?.getBoundingClientRect();
    return {
      subtitleBottom: subtitle?.bottom ?? 0,
      badgesTop: badges?.top ?? 0,
    };
  });
  expect(identityRows.badgesTop).toBeGreaterThanOrEqual(identityRows.subtitleBottom);
  expect(diagnostics.unexpectedRequests).toEqual([]);
  expect(diagnostics.pageErrors).toEqual([]);
});

test('opens a Robinhood FDV chart and applies only its realtime updates', async ({ page }) => {
  chartRequestPayloads.length = 0;
  const socketScenario = { socket: null, clientFrames: [] };
  const diagnostics = await openAuthenticatedWorkspace(
    page,
    ROBINHOOD_ONE_MINUTE_MARKET_API_FIXTURES,
    `/alerts/robinhood/${ROBINHOOD_TOKEN}`,
    socketScenario,
  );

  const dialog = page.locator('[data-auth-modal="expanded-sparkline"]');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.expanded-sparkline-stat-mcap')).toContainText('FDV');
  await expect(dialog.locator('.expanded-sparkline-footnote')).toContainText('Minute and hourly history');
  const timeZoneControl = dialog.locator('.expanded-sparkline-time-zone-control');
  const timeZoneLabel = timeZoneControl.locator('[data-expanded-sparkline-time-zone-label]');
  await expect(timeZoneControl).toHaveCSS('width', '160px');
  await expect(timeZoneLabel).toHaveCSS('white-space', 'nowrap');
  await expect(timeZoneLabel).toHaveCSS('overflow', 'hidden');
  await expect(dialog.locator('[data-expanded-candlestick-chart]')).toHaveAttribute(
    'aria-label',
    'Interactive FDV candlestick chart',
  );
  const granularityControls = dialog.getByRole('group', { name: 'Chart resolution' });
  const oneMinuteButton = granularityControls.getByRole('button', { name: '1m', exact: true });
  await expect(granularityControls.getByRole('button', { name: '15m', exact: true }))
    .toHaveAttribute('aria-pressed', 'true');
  await expect(oneMinuteButton).toBeVisible();
  await oneMinuteButton.click();
  await expect(oneMinuteButton).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => chartRequestPayloads.some((payload) => payload.granularityMinutes === 1)).toBe(true);
  await expect(dialog.locator('.expanded-chart-alert-marker')).toHaveCount(1);
  await expect.poll(() => chartRequestPayloads.some((payload) => payload.granularityMinutes === 15)).toBe(true);
  expect(chartRequestPayloads[0]).toMatchObject({
    chain: 'robinhood', address: ROBINHOOD_TOKEN, granularityMinutes: 15,
  });
  await expect.poll(() => socketScenario.clientFrames.some((frame) => (
    frame.includes('"market:sync"') && frame.includes(`"address":"${ROBINHOOD_TOKEN}"`)
  ))).toBe(true);

  const legend = dialog.locator('[data-expanded-chart-legend]');
  await expect(legend).toContainText('350K');
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

test('renders Radar valuation freshness, coverage and independent chain filters honestly', async ({ page }) => {
  radarBootstrapPayloads.length = 0;
  compactChartRequestPayloads.length = 0;
  const diagnostics = await openAuthenticatedWorkspace(page, ROBINHOOD_RADAR_API_FIXTURES);
  await page.goto('/radar');

  const radarChainSelector = page.getByRole('group', { name: 'Filter Radar by blockchain' });
  const solanaChainButton = radarChainSelector.locator('[data-chain="solana"]');
  const robinhoodChainButton = radarChainSelector.locator('[data-chain="robinhood"]');
  await expect(solanaChainButton).toHaveAttribute('aria-pressed', 'false');
  await expect(robinhoodChainButton).toHaveAttribute('aria-pressed', 'true');
  await expect(robinhoodChainButton).toBeDisabled();
  await expect.poll(() => radarBootstrapPayloads.some((payload) => (
    payload.chains?.length === 1 && payload.chains[0] === 'robinhood'
  ))).toBe(true);
  await solanaChainButton.click();
  await expect(solanaChainButton).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => radarBootstrapPayloads.some((payload) => (
    payload.chains?.length === 2
      && payload.chains.includes('solana')
      && payload.chains.includes('robinhood')
  ))).toBe(true);
  const solanaIdentity = `solana:${SOLANA_TOP}`;
  const solanaRow = page.locator(`.recent-bar tbody tr[data-token-identity="${solanaIdentity}"]`);
  await expect(solanaRow).toBeVisible();
  await expect(solanaRow).toContainText('RADARSOL');

  const identity = `robinhood:${ROBINHOOD_TOKEN}`;
  const row = page.locator(`.recent-bar tbody tr[data-token-identity="${identity}"]`);
  await expect(row).toBeVisible();
  await expect(row.locator('.token-launchpad-uniswap')).toHaveAttribute('aria-label', 'Uniswap');
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
