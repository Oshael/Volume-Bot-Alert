process.env.NODE_ENV = 'test';
process.env.EMAIL_ENABLED = 'true';
process.env.EMAIL_PROVIDER = 'local';
process.env.EMAIL_FROM = 'tests@trendscope.local';
process.env.APP_BASE_URL = 'http://localhost:5173';
process.env.EMAIL_DEV_EXPOSE_DEBUG = 'true';
process.env.ROBINHOOD_INGESTION_ENABLED = 'true';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { app, server } = require('../src/server');
const db = require('../src/models/db');
const Invite = require('../src/models/invite');
const tokenCatalog = require('../src/models/token-catalog');
const tokenMarketBucket1m = require('../src/models/token-market-bucket-1m');
const tokenMarketVolumeBucket1m = require('../src/models/token-market-volume-bucket-1m');
const tokenMeteoraState = require('../src/models/token-meteora-state');
const userBlocklist = require('../src/models/user-blocklist');
const userPinnedMonitoredToken = require('../src/models/user-pinned-monitored-token');
const backendAlertFeed = require('../src/services/backend-alert-feed');
const dashboardChainReader = require('../src/services/dashboard-chain-reader');
const dashboardRadarReader = require('../src/services/dashboard-radar-reader');
const dashboardRoutes = require('../src/routes/dashboard');
const uiMeteoraSummaryCache = require('../src/services/ui-meteora-summary-cache');
const workspaceChainReadiness = require('../src/services/workspace-chain-readiness');

const TEST_USER = {
  username: `dashboardtest_${Date.now()}`,
  email: `dashboardtest_${Date.now()}@test.com`,
  password: 'TestPass123!',
};

function getQueryToken(actionUrl) {
  assert.ok(actionUrl, 'Expected actionUrl in email debug payload');
  const parsed = new URL(actionUrl);
  const token = parsed.searchParams.get('token');
  assert.ok(token, 'Expected token query param in actionUrl');
  return token;
}

function normalizedMonitoredRow(chain, overrides = {}) {
  const address = chain === 'solana'
    ? 'So11111111111111111111111111111111111111112' : `0x${'a'.repeat(40)}`;
  return {
    identity: { chain, address, key: `${chain}:${address}` },
    symbol: chain === 'solana' ? 'WSOL' : 'RHA',
    name: 'Workspace token',
    source: 'catalog',
    firstSeenAt: '2026-04-01T12:00:00.000Z',
    lastSeenAt: '2026-07-15T17:59:00.000Z',
    lastEvaluatedAt: '2026-07-15T17:59:00.000Z',
    tokenCreatedAt: Date.UTC(2026, 3, 1, 12, 0, 0),
    tokenAgeProvenance: 'chain-native',
    priceUsd: chain === 'solana' ? 123 : 0.03,
    liquidityUsd: chain === 'solana' ? 90_000 : null,
    pairAddress: 'pair_test_123',
    pairUrl: 'https://dexscreener.com/testpair',
    pairDexId: chain === 'solana' ? 'raydium' : 'uniswap-v3',
    imageUrl: 'https://example.com/token.png',
    twitterUrl: 'https://x.com/token',
    communityUrl: null,
    monitorPriority: 'normal',
    valuation: { type: chain === 'solana' ? 'mcap' : 'fdv', usd: 150_000,
      observedAt: '2026-07-15T17:59:00.000Z', freshness: 'fresh' },
    windowEnd: '2026-07-15T18:00:00.000Z',
    lastActivityAt: '2026-07-15T17:59:00.000Z',
    volume5mUsd: 1_000, volume1hUsd: 5_000,
    volume6hUsd: 15_000, volume24hUsd: 60_000,
    coverage: { '5m': 'complete', '1h': 'complete', '6h': 'complete', '24h': 'complete' },
    activityState: 'fresh', riskState: 'unknown', dataQuality: [],
    ...overrides,
  };
}

function installExactMonitoredStubs(options = {}) {
  const originals = {
    monitored: dashboardChainReader.listExactMonitored,
    pinned: dashboardChainReader.listExactPinned,
    blocklist: userBlocklist.getAllForChains,
    pinList: userPinnedMonitoredToken.getAllForChains,
    readiness: workspaceChainReadiness.getWorkspaceChainReadiness,
  };
  dashboardChainReader.listExactMonitored = async (input) => {
    options.onMonitored?.(input);
    const rows = options.rows || [];
    return { asOf: input.asOf, total: options.total ?? rows.length,
      page: input.page, perPage: input.perPage,
      hasMore: ((input.page + 1) * input.perPage) < (options.total ?? rows.length), rows };
  };
  dashboardChainReader.listExactPinned = async (input) => {
    options.onPinned?.(input);
    return options.pinnedRows || [];
  };
  userBlocklist.getAllForChains = async () => options.blockedItems || [];
  userPinnedMonitoredToken.getAllForChains = async () => options.pinnedItems || [];
  workspaceChainReadiness.getWorkspaceChainReadiness = async () => ({
    solana: { status: 'ready' }, robinhood: { status: 'ready' },
  });
  dashboardRoutes.__private.resetMonitoredCache();
  return () => {
    dashboardChainReader.listExactMonitored = originals.monitored;
    dashboardChainReader.listExactPinned = originals.pinned;
    userBlocklist.getAllForChains = originals.blocklist;
    userPinnedMonitoredToken.getAllForChains = originals.pinList;
    workspaceChainReadiness.getWorkspaceChainReadiness = originals.readiness;
    dashboardRoutes.__private.resetMonitoredCache();
  };
}

async function verifyEmailFromRegisterResponse(registerResponse) {
  assert.equal(registerResponse.status, 201);
  const verificationToken = getQueryToken(registerResponse.body.emailDebug?.actionUrl);
  const verifyRes = await request(app)
    .post('/api/auth/verify-email/confirm')
    .send({ token: verificationToken });

  assert.equal(verifyRes.status, 200);
}

async function completeLogin(email, password) {
  const loginRes = await request(app)
    .post('/api/auth/login')
    .send({ email, password });

  assert.equal(loginRes.status, 200);
  assert.equal(loginRes.body.otpRequired, true);
  assert.ok(loginRes.body.challengeToken);
  assert.ok(loginRes.body.emailDebug?.otpCode);

  const verifyRes = await request(app)
    .post('/api/auth/login-otp/verify')
    .send({
      challengeToken: loginRes.body.challengeToken,
      code: loginRes.body.emailDebug.otpCode,
    });

  assert.equal(verifyRes.status, 200);
  assert.ok(verifyRes.body.token);
  return verifyRes.body.token;
}

async function ensureAccessSchema() {
  const statements = [
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS access_status VARCHAR(16) NOT NULL DEFAULT 'inactive'`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS access_granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS access_expires_at TIMESTAMPTZ`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS access_source VARCHAR(16) NOT NULL DEFAULT 'manual'`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS access_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
    `ALTER TABLE users ALTER COLUMN access_status SET DEFAULT 'inactive'`,
    `ALTER TABLE users ALTER COLUMN access_granted_at SET DEFAULT NOW()`,
    `ALTER TABLE users ALTER COLUMN access_source SET DEFAULT 'manual'`,
    `ALTER TABLE users ALTER COLUMN access_updated_at SET DEFAULT NOW()`,
    `ALTER TABLE invites ADD COLUMN IF NOT EXISTS grant_access_days INTEGER`,
    `ALTER TABLE invites ADD COLUMN IF NOT EXISTS grant_access_source VARCHAR(16) NOT NULL DEFAULT 'invite'`,
    `ALTER TABLE invites ALTER COLUMN grant_access_source SET DEFAULT 'invite'`,
  ];
  for (const statement of statements) {
    await db.query(statement);
  }
}

describe('Dashboard routes', () => {
  let token;
  let userId;

  before(async () => {
    await ensureAccessSchema();
    const invite = await Invite.create(null, { maxUses: 2, expiryHours: 24, grantAccessDays: 30 });
    const regRes = await request(app)
      .post('/api/auth/register')
      .send({ ...TEST_USER, inviteCode: invite.code });

    await verifyEmailFromRegisterResponse(regRes);
    token = await completeLogin(TEST_USER.email, TEST_USER.password);
    const meRes = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`);
    assert.equal(meRes.status, 200);
    userId = meRes.body.user.id;
  });

  after(async () => {
    if (server && server.close) server.close();
    await db.pool.end().catch(() => {});
  });

  it('rejects dashboard alert-events without auth', async () => {
    const res = await request(app).get('/api/dashboard/alert-events');
    assert.equal(res.status, 401);
  });

  it('rejects dashboard chart-alert-events without auth', async () => {
    const res = await request(app)
      .get('/api/dashboard/chart-alert-events?address=So11111111111111111111111111111111111111112');
    assert.equal(res.status, 401);
  });

  it('returns a lean monitored dashboard payload with Meteora summaries but without risk payloads', async () => {
    const originalListDashboardMonitored = tokenCatalog.listDashboardMonitored;
    const originalListDashboardPinnedMonitored = tokenCatalog.listDashboardPinnedMonitored;
    const originalListSummaryByAddresses = tokenMeteoraState.listSummaryByAddresses;
    const originalListCurrentAndBaselineByAddresses = tokenMarketBucket1m.listCurrentAndBaselineByAddresses;
    const originalListVolumeBaselineByAddresses = tokenMarketVolumeBucket1m.listCurrentAndBaselineByAddresses;

    tokenCatalog.listDashboardMonitored = async () => [{
      chain: 'solana',
      address: 'So11111111111111111111111111111111111111112',
      symbol: 'WSOL',
      name: 'Wrapped SOL',
      eligible_for_monitoring: true,
      last_mcap: '150000',
      last_price: '123',
      last_vol_5m: '1000',
      last_vol_1h: '5000',
      last_vol_6h: '15000',
      last_vol_24h: '60000',
      last_price_change_1h: '2',
      last_price_change_6h: '5',
      last_price_change_24h: '9',
      last_token_created_at_ms: Date.UTC(2026, 3, 1, 12, 0, 0),
      last_pair_address: 'pair_test_123',
      last_pair_url: 'https://dexscreener.com/solana/testpair',
      last_dex_id: 'raydium',
      last_image_url: 'https://example.com/token.png',
      last_twitter_url: 'https://x.com/wsol',
      monitor_priority: 'normal',
      last_seen_at: '2026-04-05T21:10:00.000Z',
      last_evaluated_at: '2026-04-05T21:09:00.000Z',
    }];
    tokenCatalog.listDashboardPinnedMonitored = async () => [];
    uiMeteoraSummaryCache.clearUiMeteoraSummaryCache();
    tokenMeteoraState.listSummaryByAddresses = async (addresses) => addresses.map((address) => ({
      tokenAddress: address,
      hasPool: true,
      currentTvl: 125000,
      bestPoolAddress: 'meteora_pool_123',
      poolCount: 2,
      lastCheckedAt: '2026-04-05T21:08:00.000Z',
      lastSnapshotAt: '2026-04-05T21:08:00.000Z',
      baselineTvl1h: 100000,
      baselineTvl4h: 95000,
      baselineTvl6h: 90000,
      baselineTvl24h: 80000,
      volume1h: 7500,
      volume4h: 18000,
      volume24h: 52000,
    }));
    tokenMarketBucket1m.listCurrentAndBaselineByAddresses = async () => [];
    tokenMarketVolumeBucket1m.listCurrentAndBaselineByAddresses = async () => [];
    let exactCalls = 0;
    const exactInputs = [];
    const exactOptions = {
      rows: [normalizedMonitoredRow('solana')],
      blockedItems: [],
      onMonitored(input) { exactCalls += 1; exactInputs.push(input); },
    };
    const restoreExact = installExactMonitoredStubs(exactOptions);

    try {
      const res = await request(app)
        .get('/api/dashboard/monitored')
        .set('Authorization', `Bearer ${token}`);

      assert.equal(res.status, 200);
      assert.equal(res.body.tokens.length, 1);
      assert.equal(res.body.tokens[0].chain, 'solana');
      assert.equal(res.body.tokens[0].pairDexId, 'raydium');
      assert.deepEqual(res.body.tokens[0].meteora, {
        address: 'So11111111111111111111111111111111111111112',
        tvl: 125000,
        poolAddress: 'meteora_pool_123',
        poolCount: 2,
        lastCheckedAt: '2026-04-05T21:08:00.000Z',
        lastSnapshotAt: '2026-04-05T21:08:00.000Z',
        change1h: 25,
        change4h: 31.57894736842105,
        change6h: 38.88888888888889,
        change24h: 56.25,
        volume1h: 7500,
        volume4h: 18000,
        volume24h: 52000,
        noPool: false,
      });
      assert.equal(res.body.tokens[0].riskReview, undefined);
      assert.equal(res.body.tokens[0].blockStatus, undefined);
      assert.equal(res.body.tokens[0].effectiveRiskLabel, undefined);
      assert.equal(res.body.tokens[0].structuralRisk, undefined);
      assert.equal(res.body.tokens[0].junkAssessment, undefined);
      const cachedRes = await request(app)
        .get('/api/dashboard/monitored')
        .set('Authorization', `Bearer ${token}`);
      assert.equal(cachedRes.status, 200);
      assert.equal(cachedRes.body.cached, true);
      assert.equal(exactCalls, 1);
      exactOptions.blockedItems.push({
        chain: 'solana', address: '11111111111111111111111111111111',
      });
      const afterBlockRes = await request(app)
        .get('/api/dashboard/monitored')
        .set('Authorization', `Bearer ${token}`);
      assert.equal(afterBlockRes.status, 200);
      assert.equal(afterBlockRes.body.cached, false);
      assert.equal(exactCalls, 2);
      assert.deepEqual(exactInputs[1].excludedIdentities, exactOptions.blockedItems);
    } finally {
      restoreExact();
      tokenCatalog.listDashboardMonitored = originalListDashboardMonitored;
      tokenCatalog.listDashboardPinnedMonitored = originalListDashboardPinnedMonitored;
      tokenMeteoraState.listSummaryByAddresses = originalListSummaryByAddresses;
      tokenMarketBucket1m.listCurrentAndBaselineByAddresses = originalListCurrentAndBaselineByAddresses;
      tokenMarketVolumeBucket1m.listCurrentAndBaselineByAddresses = originalListVolumeBaselineByAddresses;
    }
  });

  it('returns paginated monitored dashboard slices when page params are provided', async () => {
    const originalListDashboardMonitored = tokenCatalog.listDashboardMonitored;
    const originalListDashboardMonitoredSlice = tokenCatalog.listDashboardMonitoredSlice;
    const originalListDashboardPinnedMonitored = tokenCatalog.listDashboardPinnedMonitored;
    const originalListSummaryByAddresses = tokenMeteoraState.listSummaryByAddresses;
    const originalListCurrentAndBaselineByAddresses = tokenMarketBucket1m.listCurrentAndBaselineByAddresses;
    const originalListVolumeBaselineByAddresses = tokenMarketVolumeBucket1m.listCurrentAndBaselineByAddresses;

    tokenCatalog.listDashboardMonitored = async () => {
      throw new Error('listDashboardMonitored should not be called for paginated /api/dashboard/monitored');
    };
    tokenCatalog.listDashboardPinnedMonitored = async () => [];
    let capturedSorts = null;
    tokenCatalog.listDashboardMonitoredSlice = async (page, perPage, _minMcap, sorts) => {
      capturedSorts = sorts;
      return {
      total: 5,
      page,
      perPage,
      rows: [{
        chain: 'solana',
        address: 'So11111111111111111111111111111111111111112',
        symbol: 'WSOL',
        name: 'Wrapped SOL',
        eligible_for_monitoring: true,
        last_mcap: '150000',
        last_price: '123',
        last_vol_5m: '1000',
        last_vol_1h: '5000',
        last_vol_6h: '15000',
        last_vol_24h: '60000',
        last_price_change_1h: '2',
        last_price_change_6h: '5',
        last_price_change_24h: '9',
        last_token_created_at_ms: Date.UTC(2026, 3, 1, 12, 0, 0),
        last_pair_address: 'pair_test_123',
        last_pair_url: 'https://dexscreener.com/solana/testpair',
        last_image_url: 'https://example.com/token.png',
        last_twitter_url: 'https://x.com/wsol',
        monitor_priority: 'normal',
        last_seen_at: '2026-04-05T21:10:00.000Z',
        last_evaluated_at: '2026-04-05T21:09:00.000Z',
      }],
      };
    };
    uiMeteoraSummaryCache.clearUiMeteoraSummaryCache();
    tokenMeteoraState.listSummaryByAddresses = async () => [];
    tokenMarketBucket1m.listCurrentAndBaselineByAddresses = async () => [];
    tokenMarketVolumeBucket1m.listCurrentAndBaselineByAddresses = async () => [];
    const restoreExact = installExactMonitoredStubs({
      rows: [normalizedMonitoredRow('solana')], total: 5,
      onMonitored(input) { capturedSorts = input.sorts; },
    });

    try {
      const res = await request(app)
        .get(`/api/dashboard/monitored?page=1&perPage=2&sorts=${encodeURIComponent(JSON.stringify([{ mode: 'mcap', window: 'highest' }]))}`)
        .set('Authorization', `Bearer ${token}`);

      assert.equal(res.status, 200);
      assert.equal(res.body.page, 1);
      assert.equal(res.body.perPage, 2);
      assert.equal(res.body.total, 5);
      assert.equal(res.body.hasMore, true);
      assert.equal(res.body.count, 1);
      assert.equal(res.body.tokens.length, 1);
      assert.equal(res.body.tokens[0].chain, 'solana');
      assert.deepEqual(capturedSorts, [{ mode: 'mcap', window: 'highest' }]);
    } finally {
      restoreExact();
      tokenCatalog.listDashboardMonitored = originalListDashboardMonitored;
      tokenCatalog.listDashboardMonitoredSlice = originalListDashboardMonitoredSlice;
      tokenCatalog.listDashboardPinnedMonitored = originalListDashboardPinnedMonitored;
      tokenMeteoraState.listSummaryByAddresses = originalListSummaryByAddresses;
      tokenMarketBucket1m.listCurrentAndBaselineByAddresses = originalListCurrentAndBaselineByAddresses;
      tokenMarketVolumeBucket1m.listCurrentAndBaselineByAddresses = originalListVolumeBaselineByAddresses;
    }
  });

  it('returns Robinhood monitored rows with FDV kept separate from market cap', async () => {
    const originalListMonitored = dashboardChainReader.listMonitored;
    const originalListPinned = tokenCatalog.listDashboardPinnedMonitored;
    let capturedOptions = null;
    dashboardChainReader.listMonitored = async (options) => {
      capturedOptions = options;
      return {
        total: 1,
        page: 0,
        perPage: 30,
        rows: [{
          chain: 'robinhood',
          address: `0x${'a'.repeat(40)}`,
          symbol: 'RHA',
          eligible_for_monitoring: true,
          last_mcap: '99999',
          last_fdv: '30000',
          last_price: '0.03',
          last_liquidity_usd: '99999',
          last_vol_5m: '500',
          last_vol_1h: '5000',
          last_vol_6h: '12000',
          last_vol_24h: '250000',
          last_seen_at: '2026-07-14T18:00:00.000Z',
        }],
      };
    };
    tokenCatalog.listDashboardPinnedMonitored = async (_userId, chains) => {
      assert.deepEqual(chains, ['robinhood']);
      return [];
    };
    const restoreExact = installExactMonitoredStubs({
      rows: [normalizedMonitoredRow('robinhood', {
        valuation: { type: 'fdv', usd: 30_000,
          observedAt: '2026-07-15T17:59:00.000Z', freshness: 'fresh' },
      })],
      onMonitored(input) { capturedOptions = input; },
    });

    try {
      const res = await request(app)
        .get('/api/dashboard/monitored?chains=robinhood&page=0&perPage=30&minFdv=30000&priority=true')
        .set('Authorization', `Bearer ${token}`);

      assert.equal(res.status, 200);
      assert.deepEqual(capturedOptions.chains, ['robinhood']);
      assert.equal(capturedOptions.minMcap, 30000);
      assert.equal(capturedOptions.minFdv, 30000);
      assert.equal(capturedOptions.preferCatalogValuation, true);
      assert.equal(res.body.tokens[0].mcap, null);
      assert.equal(res.body.tokens[0].fdv, 30000);
      assert.equal(res.body.tokens[0].valuationType, 'fdv');
      assert.equal(res.body.tokens[0].liquidityUsd, null);
      assert.equal(res.body.tokens[0].meteora, undefined);
    } finally {
      restoreExact();
      dashboardChainReader.listMonitored = originalListMonitored;
      tokenCatalog.listDashboardPinnedMonitored = originalListPinned;
    }
  });

  it('rejects invalid monitored snapshots, deep prefixes, and valuation bounds', async () => {
    const headers = { Authorization: `Bearer ${token}` };
    const invalidSnapshot = await request(app)
      .get('/api/dashboard/monitored?asOf=invalid')
      .set(headers);
    const deepPrefix = await request(app)
      .get('/api/dashboard/monitored?page=5&perPage=100')
      .set(headers);
    const invalidBounds = await request(app)
      .get('/api/dashboard/monitored?minMcap=50000&maxMcap=40000')
      .set(headers);
    const invalidPriority = await request(app)
      .get('/api/dashboard/monitored?priority=sometimes')
      .set(headers);

    assert.equal(invalidSnapshot.status, 400);
    assert.equal(deepPrefix.status, 400);
    assert.equal(invalidBounds.status, 400);
    assert.equal(invalidPriority.status, 400);
  });

  it('persists monitored pin order through dashboard pin routes', async () => {
    const originalGetAll = userPinnedMonitoredToken.getAllForChains;
    const originalSetAll = userPinnedMonitoredToken.setAllForChains;
    const captured = [];

    userPinnedMonitoredToken.getAllForChains = async (id, chains) => {
      assert.equal(id, userId);
      assert.deepEqual(chains, ['solana']);
      return [{ chain: 'solana', address: 'So11111111111111111111111111111111111111112', sortOrder: 0 }];
    };
    userPinnedMonitoredToken.setAllForChains = async (id, pinnedTokens, chains) => {
      assert.equal(id, userId);
      assert.deepEqual(chains, ['solana']);
      captured.push(pinnedTokens);
      return pinnedTokens;
    };

    try {
      const listRes = await request(app)
        .get('/api/dashboard/monitored-pins')
        .set('Authorization', `Bearer ${token}`);
      assert.equal(listRes.status, 200);
      assert.equal(listRes.body.pinnedTokens[0].address, 'So11111111111111111111111111111111111111112');

      const saveRes = await request(app)
        .put('/api/dashboard/monitored-pins')
        .set('Authorization', `Bearer ${token}`)
        .send({
          pinnedTokens: [
            { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', sortOrder: 2 },
            { address: 'So11111111111111111111111111111111111111112', sortOrder: 7 },
          ],
        });

      assert.equal(saveRes.status, 200);
      assert.deepEqual(captured[0], [
        { chain: 'solana', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', sortOrder: 2 },
        { chain: 'solana', address: 'So11111111111111111111111111111111111111112', sortOrder: 7 },
      ]);
      assert.deepEqual(saveRes.body.pinnedTokens.map((item) => item.sortOrder), [2, 7]);
    } finally {
      userPinnedMonitoredToken.getAllForChains = originalGetAll;
      userPinnedMonitoredToken.setAllForChains = originalSetAll;
    }
  });

  it('resets monitored pins through dashboard pin routes', async () => {
    const originalRemove = userPinnedMonitoredToken.remove;
    const originalRemoveAll = userPinnedMonitoredToken.removeAllForChains;
    const removed = [];

    userPinnedMonitoredToken.remove = async (id, address, chain) => {
      assert.equal(id, userId);
      removed.push({ address, chain });
      return true;
    };
    userPinnedMonitoredToken.removeAllForChains = async (id, chains) => {
      assert.equal(id, userId);
      assert.deepEqual(chains, ['solana']);
      return 3;
    };

    try {
      const removeOneRes = await request(app)
        .delete('/api/dashboard/monitored-pins/So11111111111111111111111111111111111111112')
        .set('Authorization', `Bearer ${token}`);
      assert.equal(removeOneRes.status, 200);
      assert.equal(removeOneRes.body.removed, true);
      assert.deepEqual(removed, [{
        address: 'So11111111111111111111111111111111111111112', chain: 'solana',
      }]);

      const resetAllRes = await request(app)
        .delete('/api/dashboard/monitored-pins')
        .set('Authorization', `Bearer ${token}`);
      assert.equal(resetAllRes.status, 200);
      assert.equal(resetAllRes.body.removed, 3);
    } finally {
      userPinnedMonitoredToken.remove = originalRemove;
      userPinnedMonitoredToken.removeAllForChains = originalRemoveAll;
    }
  });

  it('exposes custom-alert capabilities and stable readiness/validation errors', async () => {
    const originalReadiness = workspaceChainReadiness.getWorkspaceChainReadiness;
    const originalBaseline = tokenCatalog.getMarketBaselineByAddress;
    let baselineReads = 0;
    workspaceChainReadiness.getWorkspaceChainReadiness = async () => ({
      solana: {
        publicationReady: true,
        blockers: [],
        capabilities: { customAlerts: true },
      },
      robinhood: {
        publicationReady: false,
        blockers: ['rollout_not_publishable'],
        capabilities: { customAlerts: false },
      },
    });
    tokenCatalog.getMarketBaselineByAddress = async () => {
      baselineReads += 1;
      return null;
    };

    try {
      const capabilities = await request(app)
        .get('/api/dashboard/custom-alert-rules?chains=solana,robinhood')
        .set('Authorization', `Bearer ${token}`);
      assert.equal(capabilities.status, 200);
      assert.equal(capabilities.body.capabilities.solana.ready, true);
      assert.deepEqual(capabilities.body.capabilities.solana.metrics, ['price', 'mcap']);
      assert.equal(capabilities.body.capabilities.robinhood.supported, true);
      assert.equal(capabilities.body.capabilities.robinhood.ready, false);
      assert.equal(capabilities.body.capabilities.robinhood.reason, 'rollout_not_publishable');
      assert.deepEqual(capabilities.body.capabilities.robinhood.metrics, ['price', 'fdv']);

      const blocked = await request(app)
        .post('/api/dashboard/custom-alert-rules')
        .set('Authorization', `Bearer ${token}`)
        .set('Origin', 'http://localhost:5173')
        .send({
          chain: 'robinhood', tokenAddress: `0x${'c'.repeat(40)}`,
          metric: 'fdv', window: 'spot', target: '1m',
        });
      assert.equal(blocked.status, 409);
      assert.equal(blocked.body.code, 'CUSTOM_ALERT_NOT_READY');
      assert.equal(blocked.body.reason, 'rollout_not_publishable');

      const unsupported = await request(app)
        .post('/api/dashboard/custom-alert-rules')
        .set('Authorization', `Bearer ${token}`)
        .set('Origin', 'http://localhost:5173')
        .send({
          chain: 'robinhood', tokenAddress: `0x${'c'.repeat(40)}`,
          metric: 'fdv', window: '5m', target: '1m',
        });
      assert.equal(unsupported.status, 400);
      assert.equal(unsupported.body.code, 'CUSTOM_ALERT_WINDOW_UNSUPPORTED');
      assert.equal(baselineReads, 0);
    } finally {
      workspaceChainReadiness.getWorkspaceChainReadiness = originalReadiness;
      tokenCatalog.getMarketBaselineByAddress = originalBaseline;
    }
  });

  it('round-trips Robinhood price and FDV rules with chain-owned mutations', async () => {
    const originalReadiness = workspaceChainReadiness.getWorkspaceChainReadiness;
    const originalBaseline = tokenCatalog.getMarketBaselineByAddress;
    const address = `0x${Number(userId).toString(16).padStart(40, '0')}`;
    const headers = {
      Authorization: `Bearer ${token}`,
      Origin: 'http://localhost:5173',
    };
    const baselineReads = [];
    workspaceChainReadiness.getWorkspaceChainReadiness = async () => ({
      solana: {
        publicationReady: true, blockers: [], capabilities: { customAlerts: true },
      },
      robinhood: {
        publicationReady: true, blockers: [], capabilities: { customAlerts: true },
      },
    });
    tokenCatalog.getMarketBaselineByAddress = async (tokenAddress, chain) => {
      baselineReads.push({ tokenAddress, chain });
      return {
        last_price: '0.02',
        last_mcap: '999999',
        last_fdv: baselineReads.length === 1 ? null : '2000000',
      };
    };

    try {
      const price = await request(app)
        .post('/api/dashboard/custom-alert-rules')
        .set(headers)
        .send({ chain: 'robinhood', tokenAddress: address,
          metric: 'price', window: 'spot', target: '0.03' });
      const fdv = await request(app)
        .post('/api/dashboard/custom-alert-rules')
        .set(headers)
        .send({ chain: 'robinhood', tokenAddress: address,
          metric: 'fdv', window: 'spot', target: '3m' });

      assert.equal(price.status, 201);
      assert.equal(fdv.status, 201);
      assert.equal(price.body.rule.chain, 'robinhood');
      assert.equal(price.body.rule.metadata.baselineFdv, null);
      assert.equal(fdv.body.rule.metric, 'fdv');
      assert.equal(fdv.body.rule.window, 'spot');
      assert.equal(fdv.body.rule.metadata.baselineFdv, 2000000);
      assert.equal(fdv.body.rule.metadata.baselineMcap, null);
      assert.deepEqual(baselineReads, [
        { tokenAddress: address, chain: 'robinhood' },
        { tokenAddress: address, chain: 'robinhood' },
      ]);

      const listed = await request(app)
        .get('/api/dashboard/custom-alert-rules?chains=robinhood')
        .set('Authorization', `Bearer ${token}`);
      const listedIds = listed.body.rules.map((rule) => rule.id);
      assert.equal(listed.status, 200);
      assert.ok(listedIds.includes(price.body.rule.id));
      assert.ok(listedIds.includes(fdv.body.rule.id));

      const wrongChainUpdate = await request(app)
        .patch(`/api/dashboard/custom-alert-rules/${fdv.body.rule.id}`)
        .set(headers)
        .send({ chain: 'solana', metric: 'price', window: 'spot', target: '4' });
      assert.equal(wrongChainUpdate.status, 404);

      const updated = await request(app)
        .patch(`/api/dashboard/custom-alert-rules/${fdv.body.rule.id}`)
        .set(headers)
        .send({ chain: 'robinhood', metric: 'fdv', window: 'spot', target: '4m' });
      assert.equal(updated.status, 200);
      assert.equal(updated.body.rule.targetValue, 4000000);

      const wrongChainDelete = await request(app)
        .delete(`/api/dashboard/custom-alert-rules/${price.body.rule.id}?chain=solana`)
        .set(headers);
      assert.equal(wrongChainDelete.status, 200);
      assert.equal(wrongChainDelete.body.disabled, false);

      for (const ruleId of [price.body.rule.id, fdv.body.rule.id]) {
        const disabled = await request(app)
          .delete(`/api/dashboard/custom-alert-rules/${ruleId}?chain=robinhood`)
          .set(headers);
        assert.equal(disabled.status, 200);
        assert.equal(disabled.body.disabled, true);
      }
    } finally {
      workspaceChainReadiness.getWorkspaceChainReadiness = originalReadiness;
      tokenCatalog.getMarketBaselineByAddress = originalBaseline;
      await db.query(
        'DELETE FROM user_custom_alert_rules WHERE user_id = $1 AND token_address = $2',
        [userId, address],
      );
    }
  });

  it('returns cached top performers ranked by mixed 24h change and volume score', async () => {
    const originalListDashboardTopPerformers = tokenCatalog.listDashboardTopPerformers;
    const originalListTopPerformers = dashboardChainReader.listTopPerformers;
    dashboardRoutes.__private.resetTopPerformersCache();
    const capturedOptions = [];

    tokenCatalog.listDashboardTopPerformers = async (options) => {
      capturedOptions.push(options);
      return [{
        address: 'So11111111111111111111111111111111111111112',
        symbol: 'WSOL',
        name: 'Wrapped SOL',
        eligible_for_monitoring: true,
        last_mcap: '1500000',
        last_price: '123',
        last_vol_5m: '1000',
        last_vol_1h: '50000',
        last_vol_6h: '150000',
        last_vol_24h: '600000',
        last_price_change_1h: '2',
        last_price_change_6h: '5',
        last_price_change_24h: '42',
        last_token_created_at_ms: Date.UTC(2026, 3, 1, 12, 0, 0),
        last_pair_address: 'pair_test_123',
        last_pair_url: 'https://dexscreener.com/solana/testpair',
        last_image_url: 'https://example.com/token.png',
        last_twitter_url: 'https://x.com/wsol',
        monitor_priority: 'normal',
        last_seen_at: '2026-04-05T21:10:00.000Z',
        last_evaluated_at: '2026-04-05T21:09:00.000Z',
        performance_score: '557.12',
      }];
    };

    try {
      const firstRes = await request(app)
        .get('/api/dashboard/top-performers')
        .set('Authorization', `Bearer ${token}`);
      const secondRes = await request(app)
        .get('/api/dashboard/top-performers')
        .set('Authorization', `Bearer ${token}`);

      assert.equal(firstRes.status, 200);
      assert.equal(secondRes.status, 200);
      assert.deepEqual(capturedOptions, [{
        chains: ['solana'], limit: 15, minMcap: 30000, minFdv: 30000,
        minVol24h: 200000,
      }]);
      assert.equal(firstRes.body.cached, false);
      assert.equal(secondRes.body.cached, true);
      assert.equal(firstRes.body.ranking, 'split_volume24h_7_pchange24h_8');
      assert.equal(firstRes.body.minMcap, 30000);
      assert.equal(firstRes.body.minVol24h, 200000);
      assert.equal(firstRes.body.count, 1);
      assert.equal(firstRes.body.tokens[0].performanceRank, 1);
      assert.equal(firstRes.body.tokens[0].performanceScore, 557.12);
      assert.equal(firstRes.body.tokens[0].symbol, 'WSOL');
      assert.equal(firstRes.body.tokens[0].volume24h, 600000);
      assert.equal(firstRes.body.tokens[0].priceChange24h, 42);
      assert.equal(firstRes.body.tokens[0].meteora, undefined);
      assert.equal(firstRes.body.tokens[0].riskReview, undefined);

      dashboardRoutes.__private.resetTopPerformersCache();
      dashboardChainReader.listTopPerformers = async (options) => {
        assert.deepEqual(options.chains, ['solana', 'robinhood']);
        assert.equal(options.minFdv, 30000);
        return [{
          chain: 'robinhood',
          address: `0x${'b'.repeat(40)}`,
          last_mcap: null,
          last_fdv: '500000',
          last_vol_24h: '800000',
          last_price_change_24h: '20',
          performance_score: '88',
        }];
      };
      const combinedRes = await request(app)
        .get('/api/dashboard/top-performers?chains=solana,robinhood&minFdv=30000')
        .set('Authorization', `Bearer ${token}`);
      assert.equal(combinedRes.status, 200);
      assert.deepEqual(combinedRes.body.chains, ['solana', 'robinhood']);
      assert.equal(combinedRes.body.minFdv, 30000);
      assert.equal(combinedRes.body.tokens[0].valuationType, 'fdv');
    } finally {
      dashboardRoutes.__private.resetTopPerformersCache();
      tokenCatalog.listDashboardTopPerformers = originalListDashboardTopPerformers;
      dashboardChainReader.listTopPerformers = originalListTopPerformers;
    }
  });

  it('rejects invalid top performer limits', async () => {
    const res = await request(app)
      .get('/api/dashboard/top-performers?limit=25')
      .set('Authorization', `Bearer ${token}`);

    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'limit must be between 1 and 20');
  });

  it('returns enriched backend alert events', async () => {
    const originalListDashboardAlertEvents = backendAlertFeed.listDashboardAlertEvents;
    let capturedOptions = null;

    backendAlertFeed.listDashboardAlertEvents = async (options) => {
      capturedOptions = options;
      return {
        generatedAt: '2026-04-05T18:05:06.000Z',
        kind: 'monitored-vol',
        ruleKey: 'monitored-vol',
        mode: 'all',
        cursor: {
          ruleKey: 'monitored-vol',
          lastSeenEventId: null,
          lastAckedEventId: null,
          updatedAt: null,
        },
        count: 1,
        events: [{
          id: 17,
          kind: 'monitored-vol',
          ruleKey: 'monitored-vol',
          address: 'So11111111111111111111111111111111111111112',
          symbol: 'WSOL',
          name: 'Wrapped SOL',
          pairAddress: 'pair_test_123',
          pairUrl: 'https://dexscreener.com/solana/testpair',
          imageUrl: 'https://example.com/token.png',
          twitterUrl: 'https://x.com/wsol',
          tokenCreatedAt: Date.UTC(2026, 3, 1, 12, 0, 0),
          mcap: 4100000,
          volume5m: 120000,
          volume1h: 200000,
          volume6h: 900000,
          volume24h: 3400000,
          pct: 80,
          triggeredAt: '2026-04-05T18:05:05.000Z',
        }],
      };
    };

    try {
      const res = await request(app)
        .get('/api/dashboard/alert-events?limit=25')
        .set('Authorization', `Bearer ${token}`);

      assert.equal(res.status, 200);
      assert.deepEqual(capturedOptions, { userId, ruleKey: undefined, limit: '25', mode: undefined, afterId: undefined });
      assert.equal(res.body.count, 1);
      assert.equal(res.body.kind, 'monitored-vol');
      assert.equal(res.body.mode, 'all');
      assert.equal(res.body.ruleKey, 'monitored-vol');
      assert.equal(res.body.events[0].id, 17);
      assert.equal(res.body.events[0].kind, 'monitored-vol');
      assert.equal(res.body.events[0].symbol, 'WSOL');
      assert.equal(res.body.events[0].mcap, 4100000);
      assert.equal(res.body.events[0].volume24h, 3400000);
      assert.equal(res.body.events[0].pct, 80);
    } finally {
      backendAlertFeed.listDashboardAlertEvents = originalListDashboardAlertEvents;
    }
  });

  it('returns chart alert history scoped to the authenticated user and token', async () => {
    const originalListDashboardChartAlertEvents = backendAlertFeed.listDashboardChartAlertEvents;
    let capturedOptions = null;

    backendAlertFeed.listDashboardChartAlertEvents = async (options) => {
      capturedOptions = options;
      return {
        generatedAt: '2026-07-03T06:00:00.000Z',
        windowHours: 24,
        address: options.tokenAddress,
        count: 1,
        truncated: false,
        events: [{
          id: 71,
          ruleKey: 'monitored-mcap',
          kind: 'monitored-mcap',
          address: options.tokenAddress,
          triggeredAt: '2026-07-03T05:47:42.000Z',
          mcap: 100000,
          pct: 25,
          label: 'MCAP',
        }],
      };
    };

    try {
      const address = 'So11111111111111111111111111111111111111112';
      const res = await request(app)
        .get(`/api/dashboard/chart-alert-events?address=${address}`)
        .set('Authorization', `Bearer ${token}`);

      assert.equal(res.status, 200);
      assert.deepEqual(capturedOptions, { userId, tokenAddress: address });
      assert.equal(res.body.windowHours, 24);
      assert.equal(res.body.events[0].mcap, 100000);
    } finally {
      backendAlertFeed.listDashboardChartAlertEvents = originalListDashboardChartAlertEvents;
    }
  });

  it('rejects invalid chart alert token addresses before querying history', async () => {
    const originalListDashboardChartAlertEvents = backendAlertFeed.listDashboardChartAlertEvents;
    let called = false;
    backendAlertFeed.listDashboardChartAlertEvents = async () => {
      called = true;
      return {};
    };

    try {
      const res = await request(app)
        .get('/api/dashboard/chart-alert-events?address=invalid')
        .set('Authorization', `Bearer ${token}`);

      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'Valid token address is required');
      assert.equal(called, false);
    } finally {
      backendAlertFeed.listDashboardChartAlertEvents = originalListDashboardChartAlertEvents;
    }
  });

  it('requests unseen dashboard alert events with cursor-aware options', async () => {
    const originalListDashboardAlertEvents = backendAlertFeed.listDashboardAlertEvents;
    let capturedOptions = null;

    backendAlertFeed.listDashboardAlertEvents = async (options) => {
      capturedOptions = options;
      return {
        generatedAt: '2026-04-05T18:05:06.000Z',
        kind: 'monitored-vol',
        ruleKey: 'monitored-vol',
        mode: 'unseen',
        cursor: {
          ruleKey: 'monitored-vol',
          lastSeenEventId: 21,
          lastAckedEventId: 19,
          updatedAt: '2026-04-05T18:06:00.000Z',
        },
        count: 0,
        events: [],
      };
    };

    try {
      const res = await request(app)
        .get('/api/dashboard/alert-events?mode=unseen&afterId=22&chains=solana,robinhood')
        .set('Authorization', `Bearer ${token}`);

      assert.equal(res.status, 200);
      assert.deepEqual(capturedOptions, {
        userId,
        ruleKey: undefined,
        limit: undefined,
        mode: 'unseen',
        afterId: 22,
        chains: 'solana,robinhood',
      });
      assert.equal(res.body.mode, 'unseen');
      assert.equal(res.body.cursor.lastSeenEventId, 21);
      assert.equal(res.body.count, 0);
    } finally {
      backendAlertFeed.listDashboardAlertEvents = originalListDashboardAlertEvents;
    }
  });

  it('loads aggregated dashboard alert feeds for all backend-owned rule keys', async () => {
    const originalListDashboardAlertFeeds = backendAlertFeed.listDashboardAlertFeeds;
    let capturedOptions = null;

    backendAlertFeed.listDashboardAlertFeeds = async (options) => {
      capturedOptions = options;
      return {
        generatedAt: '2026-04-16T12:05:10.000Z',
        mode: 'unseen',
        count: 2,
        feeds: [
          {
            generatedAt: '2026-04-16T12:05:10.000Z',
            kind: 'monitored-vol',
            ruleKey: 'monitored-vol',
            mode: 'unseen',
            cursor: { ruleKey: 'monitored-vol', lastSeenEventId: 21, lastAckedEventId: null, updatedAt: '2026-04-16T12:05:11.000Z' },
            count: 1,
            events: [{ id: 21, kind: 'monitored-vol', ruleKey: 'monitored-vol', address: 'A' }],
          },
          {
            generatedAt: '2026-04-16T12:05:10.000Z',
            kind: 'gmgn-claim-signal',
            ruleKey: 'gmgn-claim-signal',
            mode: 'unseen',
            cursor: { ruleKey: 'gmgn-claim-signal', lastSeenEventId: 30, lastAckedEventId: 28, updatedAt: '2026-04-16T12:05:11.000Z' },
            count: 1,
            events: [{ id: 30, kind: 'gmgn-claim-signal', ruleKey: 'gmgn-claim-signal', address: 'B' }],
          },
        ],
      };
    };

    try {
      const res = await request(app)
        .get('/api/dashboard/alert-feeds?mode=unseen&limit=25&chains=solana,robinhood')
        .set('Authorization', `Bearer ${token}`);

      assert.equal(res.status, 200);
      assert.deepEqual(capturedOptions, {
        userId,
        ruleKeys: undefined,
        limit: '25',
        mode: 'unseen',
        chains: 'solana,robinhood',
      });
      assert.equal(res.body.mode, 'unseen');
      assert.equal(res.body.count, 2);
      assert.equal(res.body.feeds.length, 2);
      assert.equal(res.body.feeds[0].ruleKey, 'monitored-vol');
      assert.equal(res.body.feeds[1].ruleKey, 'gmgn-claim-signal');
    } finally {
      backendAlertFeed.listDashboardAlertFeeds = originalListDashboardAlertFeeds;
    }
  });

  it('clears dashboard alert feeds for the authenticated user', async () => {
    const originalClearDashboardAlertFeeds = backendAlertFeed.clearDashboardAlertFeeds;
    let capturedArgs = null;

    backendAlertFeed.clearDashboardAlertFeeds = async (clearUserId, options) => {
      capturedArgs = [clearUserId, options];
      return {
        generatedAt: '2026-04-16T12:06:10.000Z',
        count: 1,
        cursors: [{
          ruleKey: 'monitored-vol',
          lastSeenEventId: 31,
          lastAckedEventId: 31,
          updatedAt: '2026-04-16T12:06:11.000Z',
        }],
      };
    };

    try {
      const res = await request(app)
        .post('/api/dashboard/alert-events/clear')
        .set('Authorization', `Bearer ${token}`)
        .set('Origin', 'http://localhost:5173')
        .send({ ruleKeys: ['monitored-vol'], chains: ['solana'] });

      assert.equal(res.status, 200);
      assert.deepEqual(capturedArgs, [userId, {
        ruleKeys: ['monitored-vol'],
        chains: ['solana'],
      }]);
      assert.equal(res.body.count, 1);
      assert.equal(res.body.cursors[0].lastAckedEventId, 31);
    } finally {
      backendAlertFeed.clearDashboardAlertFeeds = originalClearDashboardAlertFeeds;
    }
  });

  it('dismisses one owned dashboard alert event without advancing a cursor', async () => {
    const originalDismissDashboardAlertEvent = backendAlertFeed.dismissDashboardAlertEvent;
    let capturedArgs = null;
    backendAlertFeed.dismissDashboardAlertEvent = async (dismissUserId, payload) => {
      capturedArgs = [dismissUserId, payload];
      return { userId: dismissUserId, ...payload, dismissedAt: '2026-07-16T12:00:00.000Z' };
    };

    try {
      const res = await request(app)
        .post('/api/dashboard/alert-events/dismiss')
        .set('Authorization', `Bearer ${token}`)
        .set('Origin', 'http://localhost:5173')
        .send({ ruleKey: 'custom-alert', chain: 'robinhood', eventId: 91 });

      assert.equal(res.status, 200);
      assert.deepEqual(capturedArgs, [userId, {
        ruleKey: 'custom-alert', chain: 'robinhood', eventId: 91,
      }]);
      assert.equal(res.body.dismissal.eventId, 91);
      assert.equal(res.body.dismissal.chain, 'robinhood');
    } finally {
      backendAlertFeed.dismissDashboardAlertEvent = originalDismissDashboardAlertEvent;
    }
  });

  it('rejects unsupported dashboard alert rule keys', async () => {
    const originalListDashboardAlertEvents = backendAlertFeed.listDashboardAlertEvents;

    backendAlertFeed.listDashboardAlertEvents = async () => {
      const error = new Error('Unsupported dashboard alert rule key');
      error.code = 'UNSUPPORTED_ALERT_RULE';
      throw error;
    };

    try {
      const res = await request(app)
        .get('/api/dashboard/alert-events?ruleKey=unsupported-rule')
        .set('Authorization', `Bearer ${token}`);

      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'Unsupported dashboard alert rule key');
    } finally {
      backendAlertFeed.listDashboardAlertEvents = originalListDashboardAlertEvents;
    }
  });

  it('updates the dashboard alert cursor for the authenticated user', async () => {
    const originalUpdateDashboardAlertCursor = backendAlertFeed.updateDashboardAlertCursor;
    let capturedArgs = null;

    backendAlertFeed.updateDashboardAlertCursor = async (userId, payload) => {
      capturedArgs = [userId, payload];
      return {
        ruleKey: 'custom-alert',
        chain: 'robinhood',
        lastSeenEventId: 31,
        lastAckedEventId: 29,
        updatedAt: '2026-04-05T18:07:00.000Z',
      };
    };

    try {
      const res = await request(app)
        .post('/api/dashboard/alert-events/cursor')
        .set('Authorization', `Bearer ${token}`)
        .send({
          ruleKey: 'custom-alert',
          chain: 'robinhood',
          lastSeenEventId: 31,
          lastAckedEventId: 29,
        });

      assert.equal(res.status, 200);
      assert.deepEqual(capturedArgs, [userId, {
        ruleKey: 'custom-alert',
        chain: 'robinhood',
        lastSeenEventId: 31,
        lastAckedEventId: 29,
      }]);
      assert.equal(res.body.cursor.lastSeenEventId, 31);
      assert.equal(res.body.cursor.lastAckedEventId, 29);
    } finally {
      backendAlertFeed.updateDashboardAlertCursor = originalUpdateDashboardAlertCursor;
    }
  });

  it('rejects invalid cursor updates', async () => {
    const res = await request(app)
      .post('/api/dashboard/alert-events/cursor')
      .set('Authorization', `Bearer ${token}`)
      .send({ lastSeenEventId: 'abc' });

    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'lastSeenEventId must be a positive integer');
  });

  it('returns recent and old-week history bootstrap slices without loading full monitored payloads', async () => {
    const originalListDashboardHistoryBucket = tokenCatalog.listDashboardHistoryBucket;
    const originalListDashboardHistoryBucketDebugProbe = tokenCatalog.listDashboardHistoryBucketDebugProbe;
    const originalListDashboardMetadataByIdentities = tokenCatalog.listDashboardMetadataByIdentities;
    const originalListCurrentAndBaselineByAddresses = tokenMarketBucket1m.listCurrentAndBaselineByAddresses;
    const originalListVolumeBaselineByAddresses = tokenMarketVolumeBucket1m.listCurrentAndBaselineByAddresses;
    const originalListExactRadar = dashboardRadarReader.listExactRadar;
    const originalListRadarPins = dashboardRadarReader.listRadarPins;
    const originalUserBlocklist = userBlocklist.getAllForChains;
    const originalUiMeteora = uiMeteoraSummaryCache.listUiSummaryByAddresses;
    const capturedRadarCalls = [];
    const capturedRadarPinCalls = [];
    let solanaNativeCalls = 0;

    dashboardRadarReader.listExactRadar = async (input) => {
      capturedRadarCalls.push(input);
      const recentBucket = input.bucket === 'recent';
      return {
        asOf: input.asOf,
        total: recentBucket ? 41 : 11,
        page: input.page,
        perPage: input.perPage,
        hasMore: recentBucket,
        rows: [normalizedMonitoredRow('robinhood', {
          symbol: recentBucket ? 'RREC' : 'ROLD',
          valuation: { type: 'fdv', usd: recentBucket ? 150_000 : 250_000,
            observedAt: '2026-07-14T21:00:00.000Z', freshness: 'stale' },
          tokenCreatedAt: null,
          tokenAgeProvenance: null,
          tokenAge: { state: 'known', timestampMs: Date.UTC(2026, 6, recentBucket ? 14 : 1),
            provenance: 'first-seen' },
        })],
      };
    };
    dashboardRadarReader.listRadarPins = async (input) => {
      capturedRadarPinCalls.push(input);
      return [normalizedMonitoredRow('robinhood', {
        symbol: input.bucket === 'recent' ? 'PINREC' : 'PINOLD',
      })];
    };
    userBlocklist.getAllForChains = async () => [{
      chain: 'robinhood', address: '0x9999999999999999999999999999999999999999',
    }];

    const failLegacyHistoryCall = async () => {
      throw new Error('legacy history-bootstrap path must not run');
    };
    tokenCatalog.listDashboardHistoryBucket = failLegacyHistoryCall;
    tokenCatalog.listDashboardHistoryBucketDebugProbe = failLegacyHistoryCall;
    tokenCatalog.listDashboardMetadataByIdentities = failLegacyHistoryCall;
    uiMeteoraSummaryCache.listUiSummaryByAddresses = async () => { solanaNativeCalls += 1; return []; };
    tokenMarketBucket1m.listCurrentAndBaselineByAddresses = async () => { solanaNativeCalls += 1; return []; };
    tokenMarketVolumeBucket1m.listCurrentAndBaselineByAddresses = async () => { solanaNativeCalls += 1; return []; };

    try {
      const res = await request(app)
        .post('/api/dashboard/history-bootstrap')
        .set('Authorization', `Bearer ${token}`)
        .set('Origin', 'http://localhost:5173')
        .send({
          asOf: '2026-07-15T18:00:45.000Z',
          chains: ['robinhood'],
          starredTokenIdentities: ['robinhood:0x1111111111111111111111111111111111111111'],
          recentPinnedIdentities: ['robinhood:0x2222222222222222222222222222222222222222'],
          oldWeekPinnedIdentities: ['robinhood:0x3333333333333333333333333333333333333333'],
          recentDebugProbeIdentities: ['robinhood:0x4444444444444444444444444444444444444444'],
          recent: {
            page: 1,
            perPage: 20,
            searchQuery: 'rrec',
            starredOnly: false,
            sorts: [{ mode: 'vol', window: '1h' }, { mode: 'age', window: 'newest' }],
            dismissedTokenIdentities: ['robinhood:0x8888888888888888888888888888888888888888'],
            mcapMin: 120000,
            mcapMax: 0,
            fdvMin: 130000,
            fdvMax: 300000,
            ageMinMinutes: 30,
            ageMaxMinutes: 120,
          },
          oldWeek: {
            page: 0,
            perPage: 30,
            searchQuery: '',
            starredOnly: true,
            sorts: [{ mode: 'mcap', window: 'highest' }],
            dismissedTokenIdentities: [],
            mcapMin: 90000,
            mcapMax: 500000,
            fdvMin: 140000,
            fdvMax: 400000,
            ageMinMinutes: 20160,
            ageMaxMinutes: 43200,
          },
        });

      assert.equal(res.status, 200);
      assert.equal(capturedRadarCalls.length, 2);
      assert.equal(capturedRadarCalls[0].asOf, '2026-07-15T18:00:00.000Z');
      assert.deepEqual(capturedRadarCalls[0].chains, ['robinhood']);
      assert.equal(capturedRadarCalls[0].minFdv, 130000);
      assert.deepEqual(capturedRadarCalls[0].dismissedIdentities, [
        'robinhood:0x8888888888888888888888888888888888888888',
        'robinhood:0x9999999999999999999999999999999999999999',
      ]);
      assert.equal(capturedRadarPinCalls.length, 2);
      assert.deepEqual(capturedRadarPinCalls[0].excludedIdentities,
        ['robinhood:0x9999999999999999999999999999999999999999']);
      assert.equal(res.body.asOf, '2026-07-15T18:00:00.000Z');
      assert.equal(res.body.recent.total, 41);
      assert.equal(res.body.recent.page, 1);
      assert.equal(res.body.recent.tokens.length, 1);
      assert.equal(res.body.recent.tokens[0].chain, 'robinhood');
      assert.equal(res.body.recent.tokens[0].mcap, null);
      assert.equal(res.body.recent.tokens[0].fdv, 150000);
      assert.equal(res.body.recent.tokens[0].tokenAgeProvenance, 'first-seen');
      assert.equal(res.body.recent.pinnedTokens.length, 1);
      assert.equal(res.body.recent.pinnedTokens[0].symbol, 'PINREC');
      assert.equal(res.body.oldWeek.total, 11);
      assert.equal(res.body.oldWeek.tokens[0].symbol, 'ROLD');
      assert.equal(res.body.oldWeek.pinnedTokens.length, 1);
      assert.equal(res.body.oldWeek.pinnedTokens[0].symbol, 'PINOLD');
      assert.equal(res.body.debug, undefined);
      assert.equal(solanaNativeCalls, 0);
    } finally {
      tokenCatalog.listDashboardHistoryBucket = originalListDashboardHistoryBucket;
      tokenCatalog.listDashboardHistoryBucketDebugProbe = originalListDashboardHistoryBucketDebugProbe;
      tokenCatalog.listDashboardMetadataByIdentities = originalListDashboardMetadataByIdentities;
      tokenMarketBucket1m.listCurrentAndBaselineByAddresses = originalListCurrentAndBaselineByAddresses;
      tokenMarketVolumeBucket1m.listCurrentAndBaselineByAddresses = originalListVolumeBaselineByAddresses;
      dashboardRadarReader.listExactRadar = originalListExactRadar;
      dashboardRadarReader.listRadarPins = originalListRadarPins;
      userBlocklist.getAllForChains = originalUserBlocklist;
      uiMeteoraSummaryCache.listUiSummaryByAddresses = originalUiMeteora;
    }
  });

  it('rejects malformed history bootstrap payloads', async () => {
    const res = await request(app)
      .post('/api/dashboard/history-bootstrap')
      .set('Authorization', `Bearer ${token}`)
      .set('Origin', 'http://localhost:5173')
      .send({
        starredTokens: [],
        recent: {
          page: 0,
          perPage: 30,
          searchQuery: '',
          starredOnly: false,
          sorts: [{ mode: 'wat', window: '1h' }],
          dismissedAddresses: [],
          mcapMin: 120000,
          mcapMax: 0,
        },
        oldWeek: {
          page: 0,
          perPage: 30,
          searchQuery: '',
          starredOnly: false,
          sorts: [{ mode: 'vol', window: '1h' }],
          dismissedAddresses: [],
          mcapMin: 120000,
          mcapMax: 0,
        },
      });

    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'recent.sorts contains an invalid sort criterion');
  });

  it('rejects history bootstrap chains that are recognized but not available', async () => {
    const res = await request(app)
      .post('/api/dashboard/history-bootstrap')
      .set('Authorization', `Bearer ${token}`)
      .set('Origin', 'http://localhost:5173')
      .send({ chains: ['base'] });

    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'chains contains a chain that is not available');
  });
});
