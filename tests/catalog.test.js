process.env.NODE_ENV = 'test';
process.env.EMAIL_ENABLED = 'true';
process.env.EMAIL_PROVIDER = 'local';
process.env.EMAIL_FROM = 'tests@trendscope.local';
process.env.APP_BASE_URL = 'http://localhost:5173';
process.env.EMAIL_DEV_EXPOSE_DEBUG = 'true';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const dexscreener = require('../src/services/dexscreener');
const catalogWorker = require('../src/services/catalog-worker');
const tokenCatalog = require('../src/models/token-catalog');
const adminBlockedToken = require('../src/models/admin-blocked-token');
const tokenMeteoraSnapshot = require('../src/models/token-meteora-snapshot');
const tokenMeteoraState = require('../src/models/token-meteora-state');
const tokenMarketLateralizationRun = require('../src/models/token-market-lateralization-run');
const tokenMarketBidZoneRun = require('../src/models/token-market-bid-zone-run');
const bidZoneWorker = require('../src/services/bid-zone-worker');
const tokenMarketBucket1m = require('../src/models/token-market-bucket-1m');
const { app, server } = require('../src/server');
const db = require('../src/models/db');
const Invite = require('../src/models/invite');

const TEST_USER = {
  username: `catalogtest_${Date.now()}`,
  email: `catalogtest_${Date.now()}@test.com`,
  password: 'TestPass123!',
};

const VALID_ADDR = 'So11111111111111111111111111111111111111112';

const originalGetTokenPairs = dexscreener.getTokenPairs;
const originalGetBestPair = dexscreener.getBestPair;
const originalClearCache = dexscreener.clearCache;
const originalEvaluateTokenWithData = catalogWorker.__private.evaluateTokenWithData;

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

function buildPair(overrides = {}) {
  return {
    chainId: 'solana',
    pairAddress: 'pair_test_123',
    url: 'https://dexscreener.com/solana/testpair',
    marketCap: 123456,
    priceUsd: '1.23',
    pairCreatedAt: Date.now() - (2 * 24 * 60 * 60 * 1000),
    volume: { h24: 25000 },
    priceChange: { h1: 120, h6: 160 },
    baseToken: { symbol: 'WSOL', name: 'Wrapped SOL' },
    info: {
      imageUrl: 'https://example.com/token.png',
      socials: [{ type: 'twitter', url: 'https://x.com/wsol' }],
    },
    ...overrides,
  };
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

describe('Catalog routes', () => {
  let token;
  let mockPair;
  let mockDataAvailable;

  before(async () => {
    await ensureAccessSchema();
    const invite = await Invite.create(null, { maxUses: 2, expiryHours: 24, grantAccessDays: 30 });
    const regRes = await request(app)
      .post('/api/auth/register')
      .send({ ...TEST_USER, inviteCode: invite.code });

    await verifyEmailFromRegisterResponse(regRes);
    token = await completeLogin(TEST_USER.email, TEST_USER.password);

    await adminBlockedToken.ensureTable();
    await db.query('DELETE FROM admin_blocked_tokens WHERE address = $1', [VALID_ADDR]);
    await db.query('DELETE FROM token_catalog WHERE address = $1', [VALID_ADDR]);

    dexscreener.getTokenPairs = async () => (mockDataAvailable ? { pairs: [mockPair] } : null);
    dexscreener.getBestPair = () => (mockDataAvailable ? mockPair : null);
  });

  beforeEach(() => {
    mockPair = buildPair();
    mockDataAvailable = true;
    dexscreener.clearCache = () => {};
    catalogWorker.__private.evaluateTokenWithData = async () => ({ address: VALID_ADDR });
  });

  after(async () => {
    dexscreener.getTokenPairs = originalGetTokenPairs;
    dexscreener.getBestPair = originalGetBestPair;
    dexscreener.clearCache = originalClearCache;
    catalogWorker.__private.evaluateTokenWithData = originalEvaluateTokenWithData;
    await db.query('DELETE FROM admin_blocked_tokens WHERE address = $1', [VALID_ADDR]).catch(() => {});
    await db.query('DELETE FROM token_catalog WHERE address = $1', [VALID_ADDR]).catch(() => {});
    if (server && server.close) server.close();
    await db.pool.end().catch(() => {});
  });

  it('rejects promote without auth', async () => {
    const res = await request(app)
      .post('/api/catalog/promote')
      .send({ address: VALID_ADDR, source: 'monitored-token' });

    assert.equal(res.status, 401);
  });

  it('reactivates soft-archived tokens for manual catalog tracking', async () => {
    const originalGetByAddress = tokenCatalog.getByAddress;
    const originalReactivateSoftArchivedToken = tokenCatalog.reactivateSoftArchivedToken;
    const originalUpsertToken = tokenCatalog.upsertToken;
    const originalScheduleImmediateEvaluation = tokenCatalog.scheduleImmediateEvaluation;
    let reactivatedAddress = null;
    let upsertCalls = 0;
    let scheduleCalls = 0;

    tokenCatalog.getByAddress = async (address) => ({
      address,
      suppressed_reason: 'cleanup_soft_archive',
    });
    tokenCatalog.reactivateSoftArchivedToken = async (address) => {
      reactivatedAddress = address;
      return { address };
    };
    tokenCatalog.upsertToken = async () => {
      upsertCalls += 1;
      return { address: VALID_ADDR };
    };
    tokenCatalog.scheduleImmediateEvaluation = async () => {
      scheduleCalls += 1;
      return null;
    };

    try {
      const res = await request(app)
        .post('/api/catalog/manual-track')
        .set('Authorization', `Bearer ${token}`)
        .send({ address: VALID_ADDR });

      assert.equal(res.status, 201);
      assert.equal(reactivatedAddress, VALID_ADDR);
      assert.equal(upsertCalls, 0);
      assert.equal(scheduleCalls, 0);
      assert.equal(res.body.bootstrapState, 'evaluated');
    } finally {
      tokenCatalog.getByAddress = originalGetByAddress;
      tokenCatalog.reactivateSoftArchivedToken = originalReactivateSoftArchivedToken;
      tokenCatalog.upsertToken = originalUpsertToken;
      tokenCatalog.scheduleImmediateEvaluation = originalScheduleImmediateEvaluation;
    }
  });

  it('eagerly evaluates manual catalog tracking so new manual tokens do not wait for the worker loop', async () => {
    const originalGetByAddress = tokenCatalog.getByAddress;
    const originalUpsertToken = tokenCatalog.upsertToken;
    const originalScheduleImmediateEvaluation = tokenCatalog.scheduleImmediateEvaluation;
    const originalEvaluateToken = catalogWorker.__private.evaluateTokenWithData;
    let evaluatedToken = null;
    let evaluatedPayload = null;

    tokenCatalog.getByAddress = async () => null;
    tokenCatalog.upsertToken = async () => ({ address: VALID_ADDR, source: 'user-manual', last_eligible_at: null });
    tokenCatalog.scheduleImmediateEvaluation = async () => ({ address: VALID_ADDR, source: 'user-manual', last_eligible_at: null });
    catalogWorker.__private.evaluateTokenWithData = async (tokenRow, payload) => {
      evaluatedToken = tokenRow;
      evaluatedPayload = payload;
      return { address: tokenRow.address, eligible_for_monitoring: true };
    };

    try {
      const res = await request(app)
        .post('/api/catalog/manual-track')
        .set('Authorization', `Bearer ${token}`)
        .send({ address: VALID_ADDR });

      assert.equal(res.status, 201);
      assert.deepEqual(evaluatedToken, { address: VALID_ADDR, source: 'user-manual', last_eligible_at: null });
      assert.deepEqual(evaluatedPayload, { pairs: [mockPair] });
      assert.equal(res.body.bootstrapState, 'evaluated');
    } finally {
      tokenCatalog.getByAddress = originalGetByAddress;
      tokenCatalog.upsertToken = originalUpsertToken;
      tokenCatalog.scheduleImmediateEvaluation = originalScheduleImmediateEvaluation;
      catalogWorker.__private.evaluateTokenWithData = originalEvaluateToken;
    }
  });

  it('upserts monitored token into token_catalog when Dex data is available', async () => {
    const res = await request(app)
      .post('/api/catalog/promote')
      .set('Authorization', `Bearer ${token}`)
      .send({
        address: VALID_ADDR,
        source: 'monitored-token',
        chain: 'solana',
        symbol: 'FAKE',
        name: 'Spoofed Name',
        mcap: 999,
        pairUrl: 'https://attacker.example/token',
        imageUrl: 'https://attacker.example/token.png',
      });

    assert.equal(res.status, 201);
    assert.equal(res.body.token.address, VALID_ADDR);
    assert.equal(res.body.token.source, 'monitored-token');

    const { rows } = await db.query(
      'SELECT address, source, symbol, name, last_mcap, last_pair_url, last_image_url, last_twitter_url FROM token_catalog WHERE address = $1',
      [VALID_ADDR]
    );

    assert.equal(rows.length, 1);
    assert.equal(rows[0].address, VALID_ADDR);
    assert.equal(rows[0].source, 'monitored-token');
    assert.equal(rows[0].symbol, 'WSOL');
    assert.equal(rows[0].name, 'Wrapped SOL');
    assert.equal(Number(rows[0].last_mcap), 123456);
    assert.equal(rows[0].last_pair_url, 'https://dexscreener.com/solana/testpair');
    assert.equal(rows[0].last_image_url, 'https://example.com/token.png');
    assert.equal(rows[0].last_twitter_url, 'https://x.com/wsol');
  });

  it('defers monitored token promotion when Dex data is unavailable', async () => {
    mockDataAvailable = false;

    const res = await request(app)
      .post('/api/catalog/promote')
      .set('Authorization', `Bearer ${token}`)
      .send({
        address: VALID_ADDR,
        source: 'monitored-token',
        chain: 'solana',
      });

    assert.equal(res.status, 202);
    assert.equal(res.body.reason, 'dex_unavailable');
    assert.equal(typeof res.body.retryAt, 'number');
  });

  it('keeps admin-blocked tokens suppressed if a delayed catalog evaluation finishes later', async () => {
    await db.query('DELETE FROM admin_blocked_tokens WHERE address = $1', [VALID_ADDR]);
    await db.query('DELETE FROM token_catalog WHERE address = $1', [VALID_ADDR]);

    try {
      await tokenCatalog.upsertToken({
        address: VALID_ADDR,
        chain: 'solana',
        source: 'dexscreener-discovery',
        symbol: 'TRWUMP',
        mcap: 87260,
        isActiveMonitorCandidate: true,
      });
      await adminBlockedToken.add({ address: VALID_ADDR, label: 'TRWUMP' });
      await tokenCatalog.upsertToken({
        address: VALID_ADDR,
        chain: 'solana',
        source: 'admin-blocked',
        symbol: 'TRWUMP',
        isActiveMonitorCandidate: false,
      });

      const delayedEvaluation = await tokenCatalog.applyEvaluationResult(VALID_ADDR, {
        eligibilityState: 'dex-normal',
        eligibleForMonitoring: true,
        suppressedReason: null,
        monitorPriority: 'normal',
        nextEvaluationAt: new Date(),
        mcap: 999999,
        price: '0.99',
        vol24h: 500000,
      });

      assert.equal(delayedEvaluation.source, 'admin-blocked');
      assert.equal(delayedEvaluation.is_active_monitor_candidate, false);
      assert.equal(delayedEvaluation.eligible_for_monitoring, false);
      assert.equal(delayedEvaluation.eligibility_state, 'admin-blocked');
      assert.equal(delayedEvaluation.suppressed_reason, 'admin_blocked');
      assert.equal(delayedEvaluation.monitor_priority, 'dormant');
      assert.equal(Number(delayedEvaluation.last_mcap), 87260);
      assert.ok(new Date(delayedEvaluation.next_evaluation_at).getTime() > Date.now() + (9 * 365 * 24 * 60 * 60 * 1000));
    } finally {
      await db.query('DELETE FROM admin_blocked_tokens WHERE address = $1', [VALID_ADDR]).catch(() => {});
      await db.query('DELETE FROM token_catalog WHERE address = $1', [VALID_ADDR]).catch(() => {});
    }
  });

  it('does not let GMGN evaluation overwrite existing positive volume windows with zero', async () => {
    await db.query('DELETE FROM admin_blocked_tokens WHERE address = $1', [VALID_ADDR]);
    await db.query('DELETE FROM token_catalog WHERE address = $1', [VALID_ADDR]);

    try {
      await tokenCatalog.upsertToken({
        address: VALID_ADDR,
        chain: 'solana',
        source: 'dexscreener-discovery',
        symbol: 'TRWUMP',
        mcap: 250000,
        isActiveMonitorCandidate: true,
      });
      await tokenCatalog.applyEvaluationResult(VALID_ADDR, {
        debugSource: 'dexscreener',
        eligibilityState: 'dex-high',
        eligibleForMonitoring: true,
        suppressedReason: null,
        monitorPriority: 'high',
        nextEvaluationAt: new Date(),
        mcap: 250000,
        vol1h: 72382.4,
        vol6h: 953689.09,
        vol24h: 3932979.94,
      });

      const gmgnEvaluation = await tokenCatalog.applyEvaluationResult(VALID_ADDR, {
        debugSource: 'gmgn',
        eligibilityState: 'gmgn-high',
        eligibleForMonitoring: true,
        suppressedReason: null,
        monitorPriority: 'high',
        nextEvaluationAt: new Date(),
        mcap: 250000,
        vol1h: 0,
        vol6h: 0,
        vol24h: 3932160,
      });

      assert.equal(Number(gmgnEvaluation.last_vol_1h), 72382.4);
      assert.equal(Number(gmgnEvaluation.last_vol_6h), 953689.09);
      assert.equal(Number(gmgnEvaluation.last_vol_24h), 3932160);
    } finally {
      await db.query('DELETE FROM admin_blocked_tokens WHERE address = $1', [VALID_ADDR]).catch(() => {});
      await db.query('DELETE FROM token_catalog WHERE address = $1', [VALID_ADDR]).catch(() => {});
    }
  });

  it('assigns migration grace to PumpFun migrated tokens even without initial market cap', async () => {
    await db.query('DELETE FROM admin_blocked_tokens WHERE address = $1', [VALID_ADDR]);
    await db.query('DELETE FROM token_catalog WHERE address = $1', [VALID_ADDR]);

    try {
      const token = await tokenCatalog.upsertToken({
        address: VALID_ADDR,
        chain: 'solana',
        source: 'pumpfun-migrated',
        symbol: 'BOOT',
        isActiveMonitorCandidate: true,
      });

      assert.equal(token.source, 'pumpfun-migrated');
      assert.equal(token.is_active_monitor_candidate, true);
      assert.equal(token.eligible_for_monitoring, false);
      assert.ok(token.migration_grace_until);
      assert.ok(new Date(token.migration_grace_until).getTime() > Date.now() + (9 * 60 * 1000));
      assert.ok(new Date(token.next_evaluation_at).getTime() <= Date.now() + 1000);
    } finally {
      await db.query('DELETE FROM token_catalog WHERE address = $1', [VALID_ADDR]).catch(() => {});
    }
  });

  it('skips hotlink-blocked pumpfun image hosts and falls back to dex metadata', async () => {
    const originalFetch = global.fetch;
    global.fetch = async (url) => {
      if (String(url).includes(`https://frontend-api.pump.fun/coins/${VALID_ADDR}`)) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              symbol: 'WSOL',
              name: 'Wrapped SOL',
              image_uri: 'https://metadata.j7tracker.io/images/blocked.png',
            };
          },
        };
      }

      throw new Error(`Unexpected fetch in pumpfun metadata test: ${url}`);
    };

    try {
      const res = await request(app)
        .get(`/api/catalog/pumpfun/${VALID_ADDR}/meta`)
        .set('Authorization', `Bearer ${token}`);

      assert.equal(res.status, 200);
      assert.equal(res.body.mint, VALID_ADDR);
      assert.equal(res.body.imageUrl, 'https://example.com/token.png');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('rejects private metadata URI lookups for pumpfun metadata', async () => {
    const res = await request(app)
      .get(`/api/catalog/pumpfun/${VALID_ADDR}/meta`)
      .set('Authorization', `Bearer ${token}`)
      .query({ uri: 'http://127.0.0.1:8787/private.json' });

    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Invalid metadata URI');
  });

  it('rejects malformed market history query params', async () => {
    const res = await request(app)
      .get(`/api/catalog/history/${VALID_ADDR}`)
      .set('Authorization', `Bearer ${token}`)
      .query({ hours: 'abc' });

    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'hours must be an integer');
  });

  it('rejects malformed meteora history query params', async () => {
    const res = await request(app)
      .get(`/api/catalog/meteora/${VALID_ADDR}/history`)
      .set('Authorization', `Bearer ${token}`)
      .query({ limit: '1.5' });

    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'limit must be an integer');
  });

  it('returns Meteora batch summaries for explicit addresses outside the monitored dashboard payload', async () => {
    const originalListSummaryByAddresses = tokenMeteoraState.listSummaryByAddresses;
    let capturedAddresses = null;

    tokenMeteoraState.listSummaryByAddresses = async (addresses) => {
      capturedAddresses = addresses;
      return [{
        tokenAddress: VALID_ADDR,
        lastCheckedAt: '2026-04-05T22:00:00.000Z',
        hasPool: true,
        currentTvl: 42000,
        bestPoolAddress: 'pool_test_456',
        poolCount: 2,
        lastError: null,
        lastSnapshotAt: '2026-04-05T22:00:00.000Z',
        baselineTvl1h: 21000,
        baselineTvl6h: 14000,
        baselineTvl24h: 7000,
      }];
    };

    try {
      const res = await request(app)
        .post('/api/catalog/meteora/batch')
        .set('Authorization', `Bearer ${token}`)
        .send({ addresses: [VALID_ADDR] });

      assert.equal(res.status, 200);
      assert.deepEqual(capturedAddresses, [VALID_ADDR]);
      assert.equal(res.body.count, 1);
      assert.equal(res.body.items[0].address, VALID_ADDR);
      assert.equal(res.body.items[0].tvl, 42000);
      assert.equal(res.body.items[0].poolCount, 2);
      assert.equal(res.body.items[0].noPool, false);
      assert.equal(res.body.items[0].change1h, 100);
    } finally {
      tokenMeteoraState.listSummaryByAddresses = originalListSummaryByAddresses;
    }
  });

  it('builds Meteora history summary from current state instead of stale snapshot presence alone', async () => {
    const originalListHistoryByAddress = tokenMeteoraSnapshot.listHistoryByAddress;
    const originalGetSummaryByAddress = tokenMeteoraState.getSummaryByAddress;

    tokenMeteoraSnapshot.listHistoryByAddress = async () => [{
      token_address: VALID_ADDR,
      ts: '2026-04-05T18:00:00.000Z',
      total_tvl: '9000',
      best_pool_address: 'pool_test_123',
      pool_count: 1,
      source: 'meteora',
    }];
    tokenMeteoraState.getSummaryByAddress = async () => ({
      tokenAddress: VALID_ADDR,
      lastCheckedAt: '2026-04-05T21:00:00.000Z',
      hasPool: false,
      currentTvl: null,
      bestPoolAddress: null,
      poolCount: 0,
      lastError: null,
      lastSnapshotAt: '2026-04-05T18:00:00.000Z',
      baselineTvl1h: null,
      baselineTvl6h: null,
      baselineTvl24h: null,
    });

    try {
      const res = await request(app)
        .get(`/api/catalog/meteora/${VALID_ADDR}/history`)
        .set('Authorization', `Bearer ${token}`);

      assert.equal(res.status, 200);
      assert.equal(res.body.count, 1);
      assert.equal(res.body.summary.noPool, true);
      assert.equal(res.body.summary.tvl, null);
      assert.equal(res.body.summary.lastSnapshotAt, '2026-04-05T18:00:00.000Z');
    } finally {
      tokenMeteoraSnapshot.listHistoryByAddress = originalListHistoryByAddress;
      tokenMeteoraState.getSummaryByAddress = originalGetSummaryByAddress;
    }
  });

  it('rejects malformed sparkline batch params', async () => {
    const res = await request(app)
      .post('/api/catalog/sparklines')
      .set('Authorization', `Bearer ${token}`)
      .send({ addresses: [VALID_ADDR], points: 'abc' });

    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'points must be an integer');
  });

  it('returns sparkline batches for the requested addresses', async () => {
    const originalListSparklineByAddresses = tokenMarketBucket1m.listSparklineByAddresses;
    let capturedAddresses = null;
    let capturedOptions = null;

    tokenMarketBucket1m.listSparklineByAddresses = async (addresses, options) => {
      capturedAddresses = addresses;
      capturedOptions = options;
      return [
        {
          address: VALID_ADDR,
          pairAddress: 'pair_test_123',
          bucketCount: 2400,
          coverageRatio: 0.92,
          effectiveHours: 72,
          granularityMinutes: 5,
          latestBucketAt: '2026-04-20T12:00:00.000Z',
          series: [100, 105, 102],
        },
      ];
    };

    try {
      const res = await request(app)
        .post('/api/catalog/sparklines')
        .set('Authorization', `Bearer ${token}`)
        .send({
          addresses: [VALID_ADDR],
          hours: 14 * 24,
          points: 336,
          granularityMinutes: 30,
        });

      assert.equal(res.status, 200);
      assert.deepEqual(capturedAddresses, [VALID_ADDR]);
      assert.deepEqual(capturedOptions, { hours: 14 * 24, points: 336, granularityMinutes: 30 });
      assert.equal(res.body.hours, 14 * 24);
      assert.equal(res.body.points, 336);
      assert.equal(res.body.granularityMinutes, 30);
      assert.equal(res.body.count, 1);
      assert.equal(res.body.items[0].address, VALID_ADDR);
      assert.equal(res.body.items[0].coverageRatio, 0.92);
      assert.equal(res.body.items[0].effectiveHours, 72);
      assert.equal(res.body.items[0].granularityMinutes, 5);
      assert.deepEqual(res.body.items[0].series, [100, 105, 102]);
    } finally {
      tokenMarketBucket1m.listSparklineByAddresses = originalListSparklineByAddresses;
    }
  });

  it('rejects malformed lateralized query params', async () => {
    const res = await request(app)
      .get('/api/catalog/lateralized')
      .set('Authorization', `Bearer ${token}`)
      .query({ hours: 'abc' });

    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'hours must be an integer');
  });

  it('enriches lateralized candidates with catalog metadata', async () => {
    const originalGetLatest = tokenMarketLateralizationRun.getLatestCompletedRunWithResults;
    const originalListDashboardMetadataByAddresses = tokenCatalog.listDashboardMetadataByAddresses;

    tokenMarketLateralizationRun.getLatestCompletedRunWithResults = async () => ({
      id: 9,
      completedAt: '2026-04-15T17:55:00.000Z',
      requestedHours: 48,
      minMcap: 90000,
      minVol24h: 10000,
      candidateCount: 12,
      resultCount: 1,
      candidates: [
        { address: VALID_ADDR, score: 97.4, volume1h: 4200, volume24h: 182000 },
      ],
    });
    tokenCatalog.listDashboardMetadataByAddresses = async (addresses) => {
      assert.deepEqual(addresses, [VALID_ADDR]);
      return [{
        address: VALID_ADDR,
        symbol: 'WSOL',
        name: 'Wrapped SOL',
        last_pair_address: 'pair_test_123',
        last_pair_url: 'https://dexscreener.com/solana/testpair',
        last_image_url: 'https://example.com/token.png',
        last_twitter_url: 'https://x.com/wsol',
        monitor_priority: 'high',
      }];
    };

    try {
      const res = await request(app)
        .get('/api/catalog/lateralized')
        .set('Authorization', `Bearer ${token}`);

      assert.equal(res.status, 200);
      assert.equal(res.body.candidates.length, 1);
      assert.equal(res.body.candidates[0].symbol, 'WSOL');
      assert.equal(res.body.candidates[0].pairUrl, 'https://dexscreener.com/solana/testpair');
      assert.equal(res.body.candidates[0].imageUrl, 'https://example.com/token.png');
    } finally {
      tokenMarketLateralizationRun.getLatestCompletedRunWithResults = originalGetLatest;
      tokenCatalog.listDashboardMetadataByAddresses = originalListDashboardMetadataByAddresses;
    }
  });

  it('serves stored bid-zone snapshots for default monitor parameters', async () => {
    const originalGetLatest = tokenMarketBidZoneRun.getLatestCompletedRunWithResults;
    const originalGetStatus = bidZoneWorker.getStatus;
    const originalListBidZoneCandidates = tokenMarketBucket1m.listBidZoneCandidates;
    const originalListDashboardMetadataByAddresses = tokenCatalog.listDashboardMetadataByAddresses;

    tokenMarketBidZoneRun.getLatestCompletedRunWithResults = async () => ({
      id: 12,
      completedAt: '2026-04-15T18:00:00.000Z',
      requestedHours: 48,
      minMcap: 90000,
      minVol1h: 1000,
      minVol24h: 10000,
      candidateCount: 40,
      resultCount: 2,
      candidates: [
        { address: VALID_ADDR, symbol: 'WSOL', supportDistancePct: 3.1, supportTouchClusters: 4 },
        { address: 'So11111111111111111111111111111111111111113', symbol: 'BONK', supportDistancePct: 4.2, supportTouchClusters: 3 },
      ],
    });
    bidZoneWorker.getStatus = () => ({ refreshAvailableAt: '2026-04-15T18:05:00.000Z' });
    tokenMarketBucket1m.listBidZoneCandidates = async () => {
      throw new Error('should not compute live candidates for default bid-zone query');
    };
    tokenCatalog.listDashboardMetadataByAddresses = async (addresses) => {
      assert.deepEqual(addresses, [VALID_ADDR, 'So11111111111111111111111111111111111111113']);
      return [{
        address: VALID_ADDR,
        symbol: 'WSOL',
        name: 'Wrapped SOL',
        last_pair_address: 'pair_test_123',
        last_pair_url: 'https://dexscreener.com/solana/testpair',
        last_image_url: 'https://example.com/token.png',
        last_twitter_url: 'https://x.com/wsol',
        monitor_priority: 'high',
      }];
    };

    try {
      const res = await request(app)
        .get('/api/catalog/bid-zone')
        .set('Authorization', `Bearer ${token}`);

      assert.equal(res.status, 200);
      assert.equal(res.body.runId, 12);
      assert.equal(res.body.generatedAt, '2026-04-15T18:00:00.000Z');
      assert.equal(res.body.refreshAvailableAt, '2026-04-15T18:05:00.000Z');
      assert.equal(res.body.count, 2);
      assert.equal(res.body.candidateCount, 40);
      assert.equal(res.body.candidates[0].address, VALID_ADDR);
      assert.equal(res.body.candidates[0].pairUrl, 'https://dexscreener.com/solana/testpair');
      assert.equal(res.body.candidates[0].imageUrl, 'https://example.com/token.png');
    } finally {
      tokenMarketBidZoneRun.getLatestCompletedRunWithResults = originalGetLatest;
      bidZoneWorker.getStatus = originalGetStatus;
      tokenMarketBucket1m.listBidZoneCandidates = originalListBidZoneCandidates;
      tokenCatalog.listDashboardMetadataByAddresses = originalListDashboardMetadataByAddresses;
    }
  });

  it('forces a stored bid-zone refresh and returns the refreshed snapshot metadata', async () => {
    const originalRunManualRefresh = bidZoneWorker.runManualRefresh;
    const originalGetLatest = tokenMarketBidZoneRun.getLatestCompletedRunWithResults;

    bidZoneWorker.runManualRefresh = async () => ({
      accepted: true,
      refreshAvailableAt: '2026-04-15T18:10:00.000Z',
      retryAfterSeconds: 300,
    });
    tokenMarketBidZoneRun.getLatestCompletedRunWithResults = async () => ({
      id: 14,
      completedAt: '2026-04-15T18:05:00.000Z',
      requestedHours: 48,
      minMcap: 90000,
      minVol1h: 1000,
      minVol24h: 10000,
      candidateCount: 21,
      resultCount: 1,
      candidates: [
        { address: VALID_ADDR, symbol: 'WSOL', supportDistancePct: 2.4, supportTouchClusters: 5 },
      ],
    });

    try {
      const res = await request(app)
        .post('/api/catalog/bid-zone/refresh')
        .set('Authorization', `Bearer ${token}`)
        .set('Origin', 'http://localhost:5173');

      assert.equal(res.status, 200);
      assert.equal(res.body.refreshed, true);
      assert.equal(res.body.refreshAvailableAt, '2026-04-15T18:10:00.000Z');
      assert.equal(res.body.retryAfterSeconds, 300);
      assert.equal(res.body.runId, 14);
      assert.equal(res.body.candidates.length, 1);
    } finally {
      bidZoneWorker.runManualRefresh = originalRunManualRefresh;
      tokenMarketBidZoneRun.getLatestCompletedRunWithResults = originalGetLatest;
    }
  });
});
