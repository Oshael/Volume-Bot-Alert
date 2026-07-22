process.env.NODE_ENV = 'test';
process.env.EMAIL_ENABLED = 'true';
process.env.EMAIL_PROVIDER = 'local';
process.env.EMAIL_FROM = 'tests@trendscope.local';
process.env.APP_BASE_URL = 'http://localhost:5173';
process.env.EMAIL_DEV_EXPOSE_DEBUG = 'true';
process.env.ROBINHOOD_USER_VISIBILITY_ENABLED = 'true';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const dexscreener = require('../src/services/dexscreener');
const catalogWorker = require('../src/services/catalog-worker');
const tokenCatalog = require('../src/models/token-catalog');
const adminBlockedToken = require('../src/models/admin-blocked-token');
const tokenMeteoraSnapshot = require('../src/models/token-meteora-snapshot');
const tokenMeteoraState = require('../src/models/token-meteora-state');
const tokenMarketBidZoneRun = require('../src/models/token-market-bid-zone-run');
const bidZoneWorker = require('../src/services/bid-zone-worker');
const tokenMarketBucket1m = require('../src/models/token-market-bucket-1m');
const catalogMarketHistory = require('../src/services/catalog-market-history');
const { app, server } = require('../src/server');
const db = require('../src/models/db');
const Invite = require('../src/models/invite');

const TEST_USER = {
  username: `catalogtest_${Date.now()}`,
  email: `catalogtest_${Date.now()}@test.com`,
  password: 'TestPass123!',
};

const VALID_ADDR = 'So11111111111111111111111111111111111111112';
const ROBINHOOD_ADDR = '0xabcdef0123456789abcdef0123456789abcdef01';

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
    dexId: 'raydium',
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
      websites: [{ label: 'CC', url: 'https://coincommunities.org/communities/wsol' }],
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
    `ALTER TABLE token_catalog ADD COLUMN IF NOT EXISTS last_community_url TEXT`,
    `ALTER TABLE token_risk_reviews ADD COLUMN IF NOT EXISTS chain VARCHAR(16) NOT NULL DEFAULT 'solana'`,
    `ALTER TABLE token_risk_enrichment ADD COLUMN IF NOT EXISTS chain VARCHAR(16) NOT NULL DEFAULT 'solana'`,
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
      'SELECT address, source, symbol, name, last_mcap, last_pair_url, last_dex_id, last_image_url, last_twitter_url, last_community_url FROM token_catalog WHERE address = $1',
      [VALID_ADDR]
    );

    assert.equal(rows.length, 1);
    assert.equal(rows[0].address, VALID_ADDR);
    assert.equal(rows[0].source, 'monitored-token');
    assert.equal(rows[0].symbol, 'WSOL');
    assert.equal(rows[0].name, 'Wrapped SOL');
    assert.equal(Number(rows[0].last_mcap), 123456);
    assert.equal(rows[0].last_pair_url, 'https://dexscreener.com/solana/testpair');
    assert.equal(rows[0].last_dex_id, 'raydium');
    assert.equal(rows[0].last_image_url, 'https://example.com/token.png');
    assert.equal(rows[0].last_twitter_url, 'https://x.com/wsol');
    assert.equal(rows[0].last_community_url, 'https://coincommunities.org/communities/wsol');
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

  it('reactivates catalog evaluation after an admin-blocked token is unblocked', async () => {
    await db.query('DELETE FROM admin_blocked_tokens WHERE address = $1', [VALID_ADDR]);
    await db.query('DELETE FROM user_tokens WHERE address = $1', [VALID_ADDR]);
    await db.query('DELETE FROM token_catalog WHERE address = $1', [VALID_ADDR]);

    try {
      await db.query(
        `INSERT INTO user_tokens (user_id, address, label)
         SELECT id, $1, 'TRWUMP'
         FROM users
         WHERE email = $2
         ON CONFLICT DO NOTHING`,
        [VALID_ADDR, TEST_USER.email]
      );
      await tokenCatalog.upsertToken({
        address: VALID_ADDR,
        chain: 'solana',
        source: 'user-manual',
        symbol: 'TRWUMP',
        mcap: 87260,
        isActiveMonitorCandidate: true,
      });
      await adminBlockedToken.add({ address: VALID_ADDR, label: 'TRWUMP' });
      await tokenCatalog.applyEvaluationResult(VALID_ADDR, {
        eligibilityState: 'admin-blocked',
        eligibleForMonitoring: false,
        suppressedReason: 'admin_blocked',
        monitorPriority: 'dormant',
        nextEvaluationAt: new Date(Date.now() + (10 * 365 * 24 * 60 * 60 * 1000)),
      });

      await db.query('DELETE FROM admin_blocked_tokens WHERE address = $1', [VALID_ADDR]);
      const reactivated = await tokenCatalog.reactivateAdminBlockedToken(VALID_ADDR);

      assert.equal(reactivated.source, 'user-manual');
      assert.equal(reactivated.is_active_monitor_candidate, true);
      assert.equal(reactivated.eligible_for_monitoring, false);
      assert.equal(reactivated.eligibility_state, 'pending');
      assert.equal(reactivated.suppressed_reason, null);
      assert.ok(new Date(reactivated.next_evaluation_at).getTime() <= Date.now());
    } finally {
      await db.query('DELETE FROM admin_blocked_tokens WHERE address = $1', [VALID_ADDR]).catch(() => {});
      await db.query('DELETE FROM user_tokens WHERE address = $1', [VALID_ADDR]).catch(() => {});
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
        evaluationSource: 'dexscreener',
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
        evaluationSource: 'gmgn',
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
        baselineTvl4h: 16800,
        baselineTvl6h: 14000,
        baselineTvl24h: 7000,
        volume1h: 1500,
        volume4h: 3600,
        volume24h: 9000,
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
      assert.equal(res.body.items[0].change4h, 150);
      assert.equal(res.body.items[0].volume1h, 1500);
      assert.equal(res.body.items[0].volume4h, 3600);
      assert.equal(res.body.items[0].volume24h, 9000);
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
      baselineTvl4h: null,
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
          allowOneMinuteFallback: true,
        });

      assert.equal(res.status, 200);
      assert.deepEqual(capturedAddresses, [VALID_ADDR]);
      assert.deepEqual(capturedOptions, {
        hours: 14 * 24,
        points: 336,
        granularityMinutes: 30,
        allowOneMinuteFallback: true,
      });
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

  it('normalizes all-available sparkline batches to 500 hourly points', async () => {
    const originalListSparklineByAddresses = tokenMarketBucket1m.listSparklineByAddresses;
    let capturedOptions = null;
    tokenMarketBucket1m.listSparklineByAddresses = async (_addresses, options) => {
      capturedOptions = options;
      return [];
    };

    try {
      const res = await request(app)
        .post('/api/catalog/sparklines')
        .set('Authorization', `Bearer ${token}`)
        .send({ addresses: [VALID_ADDR], allAvailable: true });

      assert.equal(res.status, 200);
      assert.deepEqual(capturedOptions, {
        hours: null,
        points: 500,
        granularityMinutes: 60,
        allAvailable: true,
        allowOneMinuteFallback: false,
      });
      assert.equal(res.body.allAvailable, true);
      assert.equal(res.body.hours, null);
      assert.equal(res.body.points, 500);
      assert.equal(res.body.granularityMinutes, 60);
    } finally {
      tokenMarketBucket1m.listSparklineByAddresses = originalListSparklineByAddresses;
    }
  });

  it('rejects non-hourly granularity for all-available sparklines', async () => {
    const res = await request(app)
      .post('/api/catalog/sparklines')
      .set('Authorization', `Bearer ${token}`)
      .send({ addresses: [VALID_ADDR], allAvailable: true, granularityMinutes: 30 });

    assert.equal(res.status, 400);
    assert.match(res.body.error, /60-minute granularity/);
  });

  it('routes canonical mixed-chain identities through the batch history service', async () => {
    const originalGetSparklineBatch = catalogMarketHistory.getSparklineBatch;
    let captured = null;
    catalogMarketHistory.getSparklineBatch = async (input) => {
      captured = input;
      return {
        generatedAt: '2026-07-15T12:00:00.000Z',
        chains: input.identities.map((identity) => identity.chain),
        hours: input.hours,
        points: input.points,
        granularityMinutes: input.granularityMinutes,
        count: 2,
        items: input.identities.map((identity) => ({ ...identity, series: [] })),
      };
    };

    try {
      const res = await request(app)
        .post('/api/catalog/sparklines')
        .set('Authorization', `Bearer ${token}`)
        .send({
          identities: [
            { chain: 'robinhood', address: ROBINHOOD_ADDR.toUpperCase() },
            { chain: 'solana', address: VALID_ADDR },
          ],
          hours: 24,
          points: 48,
          granularityMinutes: 30,
        });

      assert.equal(res.status, 200);
      assert.deepEqual(captured.identities, [
        { chain: 'robinhood', address: ROBINHOOD_ADDR, key: `robinhood:${ROBINHOOD_ADDR}` },
        { chain: 'solana', address: VALID_ADDR, key: `solana:${VALID_ADDR}` },
      ]);
      assert.deepEqual(res.body.items.map((item) => item.chain), ['robinhood', 'solana']);
    } finally {
      catalogMarketHistory.getSparklineBatch = originalGetSparklineBatch;
    }
  });

  it('rejects unsupported chains in sparkline batches before dispatch', async () => {
    const res = await request(app)
      .post('/api/catalog/sparklines')
      .set('Authorization', `Bearer ${token}`)
      .send({ identities: [{ chain: 'base', address: ROBINHOOD_ADDR }] });

    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Market history is unavailable for base');
  });

  it('accepts expanded aggregate granularities for sparkline batches', async () => {
    const originalListSparklineByAddresses = tokenMarketBucket1m.listSparklineByAddresses;
    let capturedOptions = null;

    tokenMarketBucket1m.listSparklineByAddresses = async (_addresses, options) => {
      capturedOptions = options;
      return [];
    };

    try {
      const res = await request(app)
        .post('/api/catalog/sparklines')
        .set('Authorization', `Bearer ${token}`)
        .send({
          addresses: [VALID_ADDR],
          granularityMinutes: 1440,
        });

      assert.equal(res.status, 200);
      assert.equal(capturedOptions.granularityMinutes, 1440);
      assert.equal(res.body.granularityMinutes, 1440);
    } finally {
      tokenMarketBucket1m.listSparklineByAddresses = originalListSparklineByAddresses;
    }
  });

  it('rejects unsupported sparkline batch granularities', async () => {
    const res = await request(app)
      .post('/api/catalog/sparklines')
      .set('Authorization', `Bearer ${token}`)
      .send({
        addresses: [VALID_ADDR],
        granularityMinutes: 10,
      });

    assert.equal(res.status, 400);
    assert.match(res.body.error, /granularityMinutes must be one of/);
  });

  it('returns expanded sparkline for one requested address', async () => {
    const originalListExpandedSparklineByAddress = tokenMarketBucket1m.listExpandedSparklineByAddress;
    let capturedAddress = null;
    let capturedOptions = null;

    tokenMarketBucket1m.listExpandedSparklineByAddress = async (address, options) => {
      capturedAddress = address;
      capturedOptions = options;
      return {
        address: VALID_ADDR,
        pairAddress: 'pair_test_123',
        bucketCount: 1000,
        coverageRatio: 0.98,
        effectiveHours: 456,
        granularityMinutes: 240,
        firstBucketAt: '2026-04-01T00:00:00.000Z',
        latestBucketAt: '2026-04-20T00:00:00.000Z',
        candles: [{
          bucketTs: '2026-04-20T00:00:00.000Z',
          granularityMinutes: 240,
          openMcap: 100,
          highMcap: 150,
          lowMcap: 90,
          closeMcap: 120,
          openPrice: null,
          highPrice: null,
          lowPrice: null,
          closePrice: null,
          sampleCount: 4,
        }],
        series: [100, 140, 120],
      };
    };

    try {
      const res = await request(app)
        .post('/api/catalog/sparklines/expanded')
        .set('Authorization', `Bearer ${token}`)
        .send({
          address: VALID_ADDR,
          points: 720,
          granularityMinutes: 240,
          allowOneMinuteFallback: true,
        });

      assert.equal(res.status, 200);
      assert.equal(capturedAddress, VALID_ADDR);
      assert.deepEqual(capturedOptions, {
        points: 720,
        granularityMinutes: 240,
        allowOneMinuteFallback: true,
      });
      assert.equal(res.body.points, 720);
      assert.equal(res.body.granularityMinutes, 240);
      assert.equal(res.body.count, 1);
      assert.equal(res.body.item.address, VALID_ADDR);
      assert.equal(res.body.item.firstBucketAt, '2026-04-01T00:00:00.000Z');
      assert.equal(res.body.item.granularityMinutes, 240);
      assert.deepEqual(res.body.item.candles, [{
        bucketTs: '2026-04-20T00:00:00.000Z',
        granularityMinutes: 240,
        openMcap: 100,
        highMcap: 150,
        lowMcap: 90,
        closeMcap: 120,
        openPrice: null,
        highPrice: null,
        lowPrice: null,
        closePrice: null,
        sampleCount: 4,
      }]);
      assert.deepEqual(res.body.item.series, [100, 140, 120]);
    } finally {
      tokenMarketBucket1m.listExpandedSparklineByAddress = originalListExpandedSparklineByAddress;
    }
  });

  it('routes canonical Robinhood expanded history without using Solana', async () => {
    const originalGetExpandedSparkline = catalogMarketHistory.getExpandedSparkline;
    let captured = null;
    catalogMarketHistory.getExpandedSparkline = async (input) => {
      captured = input;
      return {
        chain: 'robinhood', valuationType: 'fdv', resolution: 'minute',
        points: input.points, granularityMinutes: input.granularityMinutes,
        count: 1, item: { chain: 'robinhood', address: input.address, candles: [] },
      };
    };

    try {
      const res = await request(app)
        .post('/api/catalog/sparklines/expanded')
        .set('Authorization', `Bearer ${token}`)
        .send({
          chain: 'robinhood', address: ROBINHOOD_ADDR.toUpperCase(),
          points: 120, granularityMinutes: 5,
        });

      assert.equal(res.status, 200);
      assert.equal(captured.chain, 'robinhood');
      assert.equal(captured.address, ROBINHOOD_ADDR);
      assert.equal(res.body.valuationType, 'fdv');
      assert.equal(res.body.item.address, ROBINHOOD_ADDR);
    } finally {
      catalogMarketHistory.getExpandedSparkline = originalGetExpandedSparkline;
    }
  });

  it('rejects unsupported chart chains before dispatch', async () => {
    const res = await request(app)
      .post('/api/catalog/sparklines/expanded')
      .set('Authorization', `Bearer ${token}`)
      .send({ chain: 'base', address: ROBINHOOD_ADDR, points: 120 });

    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Expanded market history is unavailable for base');
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
