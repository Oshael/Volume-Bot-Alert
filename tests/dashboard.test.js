process.env.NODE_ENV = 'test';
process.env.EMAIL_ENABLED = 'true';
process.env.EMAIL_PROVIDER = 'local';
process.env.EMAIL_FROM = 'tests@trendscope.local';
process.env.APP_BASE_URL = 'http://localhost:5173';
process.env.EMAIL_DEV_EXPOSE_DEBUG = 'true';

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
const backendAlertFeed = require('../src/services/backend-alert-feed');

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

  it('returns a lean monitored dashboard payload without blocking on Meteora summaries', async () => {
    const originalListDashboardMonitored = tokenCatalog.listDashboardMonitored;
    const originalListSummaryByAddresses = tokenMeteoraState.listSummaryByAddresses;
    const originalListCurrentAndBaselineByAddresses = tokenMarketBucket1m.listCurrentAndBaselineByAddresses;
    const originalListVolumeBaselineByAddresses = tokenMarketVolumeBucket1m.listCurrentAndBaselineByAddresses;

    tokenCatalog.listDashboardMonitored = async () => [{
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
    }];
    tokenMeteoraState.listSummaryByAddresses = async () => {
      throw new Error('listSummaryByAddresses should not be called for /api/dashboard/monitored');
    };
    tokenMarketBucket1m.listCurrentAndBaselineByAddresses = async () => [];
    tokenMarketVolumeBucket1m.listCurrentAndBaselineByAddresses = async () => [];

    try {
      const res = await request(app)
        .get('/api/dashboard/monitored')
        .set('Authorization', `Bearer ${token}`);

      assert.equal(res.status, 200);
      assert.equal(res.body.tokens.length, 1);
      assert.equal(res.body.tokens[0].meteora, undefined);
      assert.equal(res.body.tokens[0].riskReview, undefined);
      assert.equal(res.body.tokens[0].blockStatus, undefined);
      assert.equal(res.body.tokens[0].effectiveRiskLabel, undefined);
      assert.equal(res.body.tokens[0].structuralRisk, undefined);
      assert.equal(res.body.tokens[0].junkAssessment, undefined);
    } finally {
      tokenCatalog.listDashboardMonitored = originalListDashboardMonitored;
      tokenMeteoraState.listSummaryByAddresses = originalListSummaryByAddresses;
      tokenMarketBucket1m.listCurrentAndBaselineByAddresses = originalListCurrentAndBaselineByAddresses;
      tokenMarketVolumeBucket1m.listCurrentAndBaselineByAddresses = originalListVolumeBaselineByAddresses;
    }
  });

  it('returns paginated monitored dashboard slices when page params are provided', async () => {
    const originalListDashboardMonitored = tokenCatalog.listDashboardMonitored;
    const originalListDashboardMonitoredSlice = tokenCatalog.listDashboardMonitoredSlice;
    const originalListCurrentAndBaselineByAddresses = tokenMarketBucket1m.listCurrentAndBaselineByAddresses;
    const originalListVolumeBaselineByAddresses = tokenMarketVolumeBucket1m.listCurrentAndBaselineByAddresses;

    tokenCatalog.listDashboardMonitored = async () => {
      throw new Error('listDashboardMonitored should not be called for paginated /api/dashboard/monitored');
    };
    let capturedSorts = null;
    tokenCatalog.listDashboardMonitoredSlice = async (page, perPage, _minMcap, sorts) => {
      capturedSorts = sorts;
      return {
      total: 5,
      page,
      perPage,
      rows: [{
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
    tokenMarketBucket1m.listCurrentAndBaselineByAddresses = async () => [];
    tokenMarketVolumeBucket1m.listCurrentAndBaselineByAddresses = async () => [];

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
      assert.deepEqual(capturedSorts, [{ mode: 'mcap', window: 'highest' }]);
    } finally {
      tokenCatalog.listDashboardMonitored = originalListDashboardMonitored;
      tokenCatalog.listDashboardMonitoredSlice = originalListDashboardMonitoredSlice;
      tokenMarketBucket1m.listCurrentAndBaselineByAddresses = originalListCurrentAndBaselineByAddresses;
      tokenMarketVolumeBucket1m.listCurrentAndBaselineByAddresses = originalListVolumeBaselineByAddresses;
    }
  });

  it('returns enriched high-cap dump alert events', async () => {
    const originalListDashboardAlertEvents = backendAlertFeed.listDashboardAlertEvents;
    let capturedOptions = null;

    backendAlertFeed.listDashboardAlertEvents = async (options) => {
      capturedOptions = options;
      return {
        generatedAt: '2026-04-05T18:05:06.000Z',
        kind: 'high-cap-dump-5m',
        ruleKey: 'high-cap-dump-5m',
        mode: 'all',
        cursor: {
          ruleKey: 'high-cap-dump-5m',
          lastSeenEventId: null,
          lastAckedEventId: null,
          updatedAt: null,
        },
        count: 1,
        events: [{
          id: 17,
          kind: 'high-cap-dump-5m',
          ruleKey: 'high-cap-dump-5m',
          address: 'So11111111111111111111111111111111111111112',
          symbol: 'WSOL',
          name: 'Wrapped SOL',
          pairAddress: 'pair_test_123',
          pairUrl: 'https://dexscreener.com/solana/testpair',
          imageUrl: 'https://example.com/token.png',
          twitterUrl: 'https://x.com/wsol',
          tokenCreatedAt: Date.UTC(2026, 3, 1, 12, 0, 0),
          mcap: 4100000,
          volume1h: 200000,
          volume6h: 900000,
          volume24h: 3400000,
          baselineTs: '2026-04-05T18:00:00.000Z',
          baselineMcap: 8000000,
          windowLowMcap: 3200000,
          currentTs: '2026-04-05T18:05:00.000Z',
          currentCloseMcap: 4100000,
          dumpPct: -60,
          thresholdPct: 50,
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
      assert.equal(res.body.kind, 'high-cap-dump-5m');
      assert.equal(res.body.mode, 'all');
      assert.equal(res.body.ruleKey, 'high-cap-dump-5m');
      assert.equal(res.body.events[0].id, 17);
      assert.equal(res.body.events[0].kind, 'high-cap-dump-5m');
      assert.equal(res.body.events[0].symbol, 'WSOL');
      assert.equal(res.body.events[0].currentCloseMcap, 4100000);
      assert.equal(res.body.events[0].volume24h, 3400000);
      assert.equal(res.body.events[0].dumpPct, -60);
    } finally {
      backendAlertFeed.listDashboardAlertEvents = originalListDashboardAlertEvents;
    }
  });

  it('requests unseen dashboard alert events with cursor-aware options', async () => {
    const originalListDashboardAlertEvents = backendAlertFeed.listDashboardAlertEvents;
    let capturedOptions = null;

    backendAlertFeed.listDashboardAlertEvents = async (options) => {
      capturedOptions = options;
      return {
        generatedAt: '2026-04-05T18:05:06.000Z',
        kind: 'high-cap-dump-5m',
        ruleKey: 'high-cap-dump-5m',
        mode: 'unseen',
        cursor: {
          ruleKey: 'high-cap-dump-5m',
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
        .get('/api/dashboard/alert-events?mode=unseen&afterId=22')
        .set('Authorization', `Bearer ${token}`);

      assert.equal(res.status, 200);
      assert.deepEqual(capturedOptions, { userId, ruleKey: undefined, limit: undefined, mode: 'unseen', afterId: 22 });
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
            kind: 'high-cap-dump-5m',
            ruleKey: 'high-cap-dump-5m',
            mode: 'unseen',
            cursor: { ruleKey: 'high-cap-dump-5m', lastSeenEventId: 30, lastAckedEventId: 28, updatedAt: '2026-04-16T12:05:11.000Z' },
            count: 1,
            events: [{ id: 30, kind: 'high-cap-dump-5m', ruleKey: 'high-cap-dump-5m', address: 'B' }],
          },
        ],
      };
    };

    try {
      const res = await request(app)
        .get('/api/dashboard/alert-feeds?mode=unseen&limit=25')
        .set('Authorization', `Bearer ${token}`);

      assert.equal(res.status, 200);
      assert.deepEqual(capturedOptions, {
        userId,
        ruleKeys: undefined,
        limit: '25',
        mode: 'unseen',
      });
      assert.equal(res.body.mode, 'unseen');
      assert.equal(res.body.count, 2);
      assert.equal(res.body.feeds.length, 2);
      assert.equal(res.body.feeds[0].ruleKey, 'monitored-vol');
      assert.equal(res.body.feeds[1].ruleKey, 'high-cap-dump-5m');
    } finally {
      backendAlertFeed.listDashboardAlertFeeds = originalListDashboardAlertFeeds;
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
        ruleKey: 'high-cap-dump-5m',
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
          ruleKey: 'high-cap-dump-5m',
          lastSeenEventId: 31,
          lastAckedEventId: 29,
        });

      assert.equal(res.status, 200);
      assert.deepEqual(capturedArgs, [userId, {
        ruleKey: 'high-cap-dump-5m',
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
    const originalListSummaryByAddresses = tokenMeteoraState.listSummaryByAddresses;
    const originalListCurrentAndBaselineByAddresses = tokenMarketBucket1m.listCurrentAndBaselineByAddresses;
    const originalListVolumeBaselineByAddresses = tokenMarketVolumeBucket1m.listCurrentAndBaselineByAddresses;
    const capturedCalls = [];

    tokenCatalog.listDashboardHistoryBucket = async (bucket, options) => {
      capturedCalls.push([bucket, options]);
      if (bucket === 'recent') {
        return {
          total: 41,
          page: 1,
          perPage: 20,
          rows: [{
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
            last_token_created_at_ms: Date.UTC(2026, 3, 10, 12, 0, 0),
            last_pair_address: 'pair_test_123',
            last_pair_url: 'https://dexscreener.com/solana/testpair',
            last_image_url: 'https://example.com/token.png',
            last_twitter_url: 'https://x.com/wsol',
            monitor_priority: 'normal',
            last_seen_at: '2026-04-15T21:10:00.000Z',
            last_evaluated_at: '2026-04-15T21:09:00.000Z',
            risk_review_label: null,
            risk_review_source: null,
            risk_review_notes: null,
            risk_review_updated_at: null,
            blocked_label: null,
            blocked_created_by: null,
            blocked_created_at: null,
            risk_enrichment_last_attempted_at: null,
            risk_enrichment_last_enriched_at: null,
            risk_enrichment_last_error: null,
            risk_holder_count: null,
            risk_mint_authority_active: false,
            risk_freeze_authority_active: false,
            risk_top_10_pct: null,
            risk_top_20_pct: null,
            risk_reason_codes: [],
          }],
        };
      }

      return {
        total: 11,
        page: 0,
        perPage: 30,
        rows: [{
          address: 'So11111111111111111111111111111111111111113',
          symbol: 'BONK',
          name: 'Bonk',
          eligible_for_monitoring: true,
          last_mcap: '250000',
          last_price: '1.2',
          last_vol_5m: '900',
          last_vol_1h: '4500',
          last_vol_6h: '17000',
          last_vol_24h: '91000',
          last_price_change_1h: '3',
          last_price_change_6h: '7',
          last_price_change_24h: '14',
          last_token_created_at_ms: Date.UTC(2026, 3, 1, 12, 0, 0),
          last_pair_address: 'pair_test_456',
          last_pair_url: 'https://dexscreener.com/solana/testpair2',
          last_image_url: 'https://example.com/token2.png',
          last_twitter_url: 'https://x.com/bonk',
          monitor_priority: 'normal',
          last_seen_at: '2026-04-15T20:10:00.000Z',
          last_evaluated_at: '2026-04-15T20:09:00.000Z',
          risk_review_label: null,
          risk_review_source: null,
          risk_review_notes: null,
          risk_review_updated_at: null,
          blocked_label: null,
          blocked_created_by: null,
          blocked_created_at: null,
          risk_enrichment_last_attempted_at: null,
          risk_enrichment_last_enriched_at: null,
          risk_enrichment_last_error: null,
          risk_holder_count: null,
          risk_mint_authority_active: false,
          risk_freeze_authority_active: false,
          risk_top_10_pct: null,
          risk_top_20_pct: null,
          risk_reason_codes: [],
        }],
      };
    };
    tokenMeteoraState.listSummaryByAddresses = async (addresses) => addresses.map((address) => ({
      tokenAddress: address,
      lastCheckedAt: '2026-04-15T21:08:00.000Z',
      hasPool: false,
      currentTvl: null,
      bestPoolAddress: null,
      poolCount: 0,
      lastError: null,
      lastSnapshotAt: '2026-04-15T19:00:00.000Z',
      baselineTvl1h: null,
      baselineTvl6h: null,
      baselineTvl24h: null,
    }));
    tokenMarketBucket1m.listCurrentAndBaselineByAddresses = async () => [];
    tokenMarketVolumeBucket1m.listCurrentAndBaselineByAddresses = async () => [];

    try {
      const res = await request(app)
        .post('/api/dashboard/history-bootstrap')
        .set('Authorization', `Bearer ${token}`)
        .set('Origin', 'http://localhost:5173')
        .send({
          starredTokens: ['So11111111111111111111111111111111111111112'],
          recent: {
            page: 1,
            perPage: 20,
            searchQuery: 'wsol',
            starredOnly: false,
            sorts: [{ mode: 'vol', window: '1h' }, { mode: 'age', window: 'newest' }],
            dismissedAddresses: [],
            mcapMin: 120000,
            mcapMax: 0,
            ageMinMinutes: 30,
            ageMaxMinutes: 120,
          },
          oldWeek: {
            page: 0,
            perPage: 30,
            searchQuery: '',
            starredOnly: true,
            sorts: [{ mode: 'mcap', window: 'highest' }],
            dismissedAddresses: ['So11111111111111111111111111111111111111114'],
            mcapMin: 90000,
            mcapMax: 500000,
            ageMinMinutes: 20160,
            ageMaxMinutes: 43200,
          },
        });

      assert.equal(res.status, 200);
      assert.equal(capturedCalls.length, 2);
      assert.deepEqual(capturedCalls[0], ['recent', {
        page: 1,
        perPage: 20,
        searchQuery: 'wsol',
        starredOnly: false,
        sorts: [{ mode: 'vol', window: '1h' }, { mode: 'age', window: 'newest' }],
        dismissedAddresses: [],
        mcapMin: 120000,
        mcapMax: 0,
        ageMinMinutes: 30,
        ageMaxMinutes: 120,
        starredAddresses: ['So11111111111111111111111111111111111111112'],
      }]);
      assert.deepEqual(capturedCalls[1], ['oldWeek', {
        page: 0,
        perPage: 30,
        searchQuery: '',
        starredOnly: true,
        sorts: [{ mode: 'mcap', window: 'highest' }],
        dismissedAddresses: ['So11111111111111111111111111111111111111114'],
        mcapMin: 90000,
        mcapMax: 500000,
        ageMinMinutes: 20160,
        ageMaxMinutes: 43200,
        starredAddresses: ['So11111111111111111111111111111111111111112'],
      }]);
      assert.equal(res.body.recent.total, 41);
      assert.equal(res.body.recent.page, 1);
      assert.equal(res.body.recent.tokens.length, 1);
      assert.equal(res.body.oldWeek.total, 11);
      assert.equal(res.body.oldWeek.tokens[0].symbol, 'BONK');
    } finally {
      tokenCatalog.listDashboardHistoryBucket = originalListDashboardHistoryBucket;
      tokenMeteoraState.listSummaryByAddresses = originalListSummaryByAddresses;
      tokenMarketBucket1m.listCurrentAndBaselineByAddresses = originalListCurrentAndBaselineByAddresses;
      tokenMarketVolumeBucket1m.listCurrentAndBaselineByAddresses = originalListVolumeBaselineByAddresses;
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
});
