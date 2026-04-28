const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

function request(method, path, { body, token } = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port: process.env.TEST_PORT || 3098,
      path,
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (token) options.headers.Authorization = `Bearer ${token}`;

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function getQueryToken(actionUrl) {
  assert.ok(actionUrl, 'Expected actionUrl in email debug payload');
  const parsed = new URL(actionUrl);
  const token = parsed.searchParams.get('token');
  assert.ok(token, 'Expected token query param in actionUrl');
  return token;
}

async function verifyEmailFromRegisterResponse(registerResponse) {
  assert.equal(registerResponse.status, 201);
  assert.equal(registerResponse.body.emailVerificationRequired, true);
  assert.ok(registerResponse.body.emailDebug?.actionUrl);

  const verificationToken = getQueryToken(registerResponse.body.emailDebug.actionUrl);
  const verifyResponse = await request('POST', '/api/auth/verify-email/confirm', {
    body: { token: verificationToken },
  });

  assert.equal(verifyResponse.status, 200);
  return verifyResponse;
}

async function completeLogin(email, password) {
  const loginResponse = await request('POST', '/api/auth/login', {
    body: { email, password },
  });

  assert.equal(loginResponse.status, 200);
  assert.equal(loginResponse.body.otpRequired, true);
  assert.ok(loginResponse.body.challengeToken);
  assert.ok(loginResponse.body.emailDebug?.otpCode);

  const verifyResponse = await request('POST', '/api/auth/login-otp/verify', {
    body: {
      challengeToken: loginResponse.body.challengeToken,
      code: loginResponse.body.emailDebug.otpCode,
    },
  });

  assert.equal(verifyResponse.status, 200);
  assert.ok(verifyResponse.body.token);
  return verifyResponse.body.token;
}

async function ensureAccessSchema(pool) {
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
    await pool.query(statement);
  }
}

describe('Admin panel auth and management', () => {
  let server;
  let adminToken;
  let adminUserId;
  let userToken;
  let userId;
  let tokenMarketBucket1m;
  let tokenCatalog;
  let tokenRiskCandidateSelector;
  let tokenRiskEnrichment;
  let tokenRiskEnrichmentWorker;
  let tokenRiskReview;
  let tokenMeteoraState;
  let pumpfunFast5xDryRun;

  before(async () => {
    process.env.NODE_ENV = 'test';
    process.env.PORT = '3098';
    process.env.TEST_PORT = '3098';
    process.env.AUTH_RATE_LIMIT_MAX_REQUESTS = '100';
    process.env.EMAIL_ENABLED = 'true';
    process.env.EMAIL_PROVIDER = 'local';
    process.env.EMAIL_FROM = 'tests@trendscope.local';
    process.env.APP_BASE_URL = 'http://localhost:5173';
    process.env.EMAIL_DEV_EXPOSE_DEBUG = 'true';

    tokenMarketBucket1m = require('../src/models/token-market-bucket-1m');
    tokenCatalog = require('../src/models/token-catalog');
    tokenRiskCandidateSelector = require('../src/services/token-risk-candidate-selector');
    tokenRiskEnrichment = require('../src/models/token-risk-enrichment');
    tokenRiskEnrichmentWorker = require('../src/services/token-risk-enrichment-worker');
    tokenRiskReview = require('../src/models/token-risk-review');
    tokenMeteoraState = require('../src/models/token-meteora-state');
    pumpfunFast5xDryRun = require('../src/services/pumpfun-fast-5x-dry-run');
    const { pool } = require('../src/models/db');

    await ensureAccessSchema(pool);
    await pool.query('DELETE FROM sessions');
    await pool.query('DELETE FROM login_attempts');
    await pool.query('DELETE FROM users');
    await pool.query('DELETE FROM invites');
    await pool.query('ALTER TABLE invites ALTER COLUMN created_by DROP NOT NULL').catch(() => {});

    await pool.query(
      `INSERT INTO invites (code, created_by, max_uses, grant_access_days, grant_access_source, expires_at)
       VALUES ('ADMINTEST0001', NULL, 10, 30, 'invite', NOW() + INTERVAL '24 hours')`
    );

    const { startServer } = require('../src/server');
    server = startServer(3098);
    await new Promise((resolve) => setTimeout(resolve, 500));

    const adminReg = await request('POST', '/api/auth/register', {
      body: { username: 'testadmin', email: 'admin@test.com', password: 'adminpass123', inviteCode: 'ADMINTEST0001' },
    });
    await verifyEmailFromRegisterResponse(adminReg);
    adminUserId = adminReg.body.user.id;
    await pool.query("UPDATE users SET role = 'admin' WHERE username = 'testadmin'");
    adminToken = await completeLogin('admin@test.com', 'adminpass123');

    const userReg = await request('POST', '/api/auth/register', {
      body: { username: 'testuser', email: 'user@test.com', password: 'userpass123', inviteCode: 'ADMINTEST0001' },
    });
    await verifyEmailFromRegisterResponse(userReg);
    userId = userReg.body.user.id;
    userToken = await completeLogin('user@test.com', 'userpass123');
  });

  after(async () => {
    const socketHub = require('../src/services/socket-hub');
    socketHub.stop();
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    const { pool } = require('../src/models/db');
    await pool.end();
  });

  describe('Security — regular user cannot access admin', () => {
    it('GET /api/admin/stats -> 403', async () => {
      const res = await request('GET', '/api/admin/stats', { token: userToken });
      assert.equal(res.status, 403);
    });

    it('GET /api/admin/users -> 403', async () => {
      const res = await request('GET', '/api/admin/users', { token: userToken });
      assert.equal(res.status, 403);
    });

    it('GET /api/admin/users/online -> 403', async () => {
      const res = await request('GET', '/api/admin/users/online', { token: userToken });
      assert.equal(res.status, 403);
    });

    it('PATCH /api/admin/users/:id -> 403', async () => {
      const res = await request('PATCH', `/api/admin/users/${userId}`, {
        token: userToken,
        body: { is_active: false },
      });
      assert.equal(res.status, 403);
    });

    it('GET /api/admin/logs -> 403', async () => {
      const res = await request('GET', '/api/admin/logs', { token: userToken });
      assert.equal(res.status, 403);
    });

    it('GET /api/admin/invites -> 403', async () => {
      const res = await request('GET', '/api/admin/invites', { token: userToken });
      assert.equal(res.status, 403);
    });

    it('GET /api/admin/high-cap-dump-candidates -> 403', async () => {
      const res = await request(
        'GET',
        '/api/admin/high-cap-dump-candidates?addresses=So11111111111111111111111111111111111111112',
        { token: userToken }
      );
      assert.equal(res.status, 403);
    });

    it('POST /api/admin/token-risk-enrichment/runs -> 403', async () => {
      const res = await request('POST', '/api/admin/token-risk-enrichment/runs', {
        token: userToken,
        body: { scanLimit: 10, batchLimit: 2 },
      });
      assert.equal(res.status, 403);
    });

    it('GET /api/admin/token-risk-enrichment -> 403', async () => {
      const res = await request(
        'GET',
        '/api/admin/token-risk-enrichment?addresses=So11111111111111111111111111111111111111112',
        { token: userToken }
      );
      assert.equal(res.status, 403);
    });

    it('GET /api/admin/token-risk-candidates -> 403', async () => {
      const res = await request(
        'GET',
        '/api/admin/token-risk-candidates?scanLimit=10&resultLimit=3',
        { token: userToken }
      );
      assert.equal(res.status, 403);
    });

    it('GET /api/admin/token-junk-assessments -> 403', async () => {
      const res = await request(
        'GET',
        '/api/admin/token-junk-assessments?addresses=So11111111111111111111111111111111111111112',
        { token: userToken }
      );
      assert.equal(res.status, 403);
    });

    it('POST /api/admin/token-risk-enrichment/addresses -> 403', async () => {
      const res = await request('POST', '/api/admin/token-risk-enrichment/addresses', {
        token: userToken,
        body: { addresses: ['So11111111111111111111111111111111111111112'] },
      });
      assert.equal(res.status, 403);
    });

    it('POST /api/admin/token-risk-labels -> 403', async () => {
      const res = await request('POST', '/api/admin/token-risk-labels', {
        token: userToken,
        body: {
          address: 'So11111111111111111111111111111111111111112',
          label: 'valid',
        },
      });
      assert.equal(res.status, 403);
    });

    it('no token -> 401', async () => {
      const res = await request('GET', '/api/admin/stats');
      assert.equal(res.status, 401);
    });
  });

  describe('Admin Stats', () => {
    it('returns dashboard stats', async () => {
      const res = await request('GET', '/api/admin/stats', { token: adminToken });
      assert.equal(res.status, 200);
      assert.ok(res.body.users);
      assert.ok(res.body.sessions);
      assert.ok(res.body.invites);
      assert.ok(res.body.loginAttempts24h);
      assert.ok(res.body.users.total >= 2);
      assert.ok(res.body.sessions.active >= 1);
    });

    it('returns worker status including token risk enrichment worker', async () => {
      const res = await request('GET', '/api/admin/ws-status', { token: adminToken });
      assert.equal(res.status, 200);
      assert.ok(res.body.runtime);
      assert.ok(res.body.catalogWorker);
      assert.ok(res.body.tokenRiskEnrichmentWorker);
      assert.ok(res.body.pumpfunFast5xDryRun);
      assert.equal(typeof res.body.tokenRiskEnrichmentWorker.running, 'boolean');
    });
  });

  describe('Admin PumpFun Fast 5x Dry Run', () => {
    it('returns compact dry-run candidates for admin users', async () => {
      const originalGetStatus = pumpfunFast5xDryRun.getStatus;
      pumpfunFast5xDryRun.getStatus = () => ({
        running: true,
        enabled: true,
        dryRun: true,
        intervalMs: 60000,
        candidateLimit: 250,
        lastRunAt: '2026-04-27T10:15:00.000Z',
        lastCandidateCount: 12,
        lastPassedCount: 1,
        lastFailedCount: 11,
        totalRuns: 3,
        totalCandidates: 24,
        totalPassed: 2,
        totalErrors: 0,
        lastError: null,
        trackedDetectionCount: 1,
        trackedDetections: [{
          address: 'So11111111111111111111111111111111111111112',
          symbol: 'FAST',
          name: 'Fast Token',
          score: 88.5,
          alertTriggeredAt: '2026-04-27T10:06:00.000Z',
          alertMcap: 62000,
          latestMcapSinceAlert: 93000,
          maxMcapSinceAlert: 124000,
          maxXSinceAlert: 2,
          evidenceAtAlert: {
            firstMcap: 24000,
            currentMcap: 62000,
            currentMultiple: 2.58,
            p95Vol5mRecent: 85000,
            timeTo2xMs: 240000,
          },
        }],
      });

      try {
        const res = await request('GET', '/api/admin/pumpfun-fast-5x/dry-run', { token: adminToken });
        assert.equal(res.status, 200);
        assert.equal(res.body.status.running, true);
        assert.equal(res.body.count, 1);
        assert.equal(res.body.candidates[0].address, 'So11111111111111111111111111111111111111112');
        assert.equal(res.body.candidates[0].alertMcap, 62000);
        assert.equal(res.body.candidates[0].maxXSinceAlert, 2);
      } finally {
        pumpfunFast5xDryRun.getStatus = originalGetStatus;
      }
    });

    it('can force a dry-run refresh from the admin route', async () => {
      const originalRunOnce = pumpfunFast5xDryRun.runOnce;
      const originalGetStatus = pumpfunFast5xDryRun.getStatus;
      let capturedOptions = null;

      pumpfunFast5xDryRun.runOnce = async (options) => {
        capturedOptions = options;
        return {
          candidates: [{ address: 'a' }, { address: 'b' }],
          passed: [{ address: 'a' }],
          failedCount: 1,
          detections: [{ address: 'a' }],
        };
      };
      pumpfunFast5xDryRun.getStatus = () => ({
        running: false,
        enabled: false,
        dryRun: true,
        lastPassedCandidates: [],
      });

      try {
        const res = await request('GET', '/api/admin/pumpfun-fast-5x/dry-run?refresh=true', { token: adminToken });
        assert.equal(res.status, 200);
        assert.deepEqual(capturedOptions, { force: true });
        assert.equal(res.body.refreshed, true);
        assert.deepEqual(res.body.refreshSummary, { candidates: 2, passed: 1, failed: 1, detections: 1 });
      } finally {
        pumpfunFast5xDryRun.runOnce = originalRunOnce;
        pumpfunFast5xDryRun.getStatus = originalGetStatus;
      }
    });

    it('renders a simple browser-readable HTML view', async () => {
      const originalGetStatus = pumpfunFast5xDryRun.getStatus;
      pumpfunFast5xDryRun.getStatus = () => ({
        running: true,
        enabled: true,
        dryRun: true,
        lastCandidateCount: 1,
        lastPassedCount: 1,
        trackedDetectionCount: 1,
        trackedDetections: [{
          address: 'So11111111111111111111111111111111111111112',
          symbol: 'FAST',
          score: 90,
          alertTriggeredAt: '2026-04-27T10:06:00.000Z',
          alertMcap: 62000,
          latestMcapSinceAlert: 93000,
          maxMcapSinceAlert: 124000,
          maxXSinceAlert: 2,
          evidenceAtAlert: {
            firstMcap: 24000,
            currentMcap: 62000,
            currentMultiple: 2.58,
            p95Vol5mRecent: 85000,
            timeTo2xMs: 240000,
          },
        }],
      });

      try {
        const res = await request('GET', '/api/admin/pumpfun-fast-5x/dry-run.html', { token: adminToken });
        assert.equal(res.status, 200);
        assert.match(res.body, /PumpFun Fast 5x Dry Run/);
        assert.match(res.body, /FAST/);
        assert.match(res.body, /Max X Since Alert/);
        assert.match(res.body, /const POLL_MS = 10000/);
        assert.ok(res.body.includes("const jsonUrl = '/api/admin/pumpfun-fast-5x/dry-run?refresh=true';"));
      } finally {
        pumpfunFast5xDryRun.getStatus = originalGetStatus;
      }
    });
  });

  describe('Admin High Cap Dump Inspection', () => {
    it('validates that addresses are required', async () => {
      const res = await request('GET', '/api/admin/high-cap-dump-candidates', { token: adminToken });
      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'addresses query parameter is required');
    });

    it('returns admin inspection results from the dump detector', async () => {
      const originalDetector = tokenMarketBucket1m.listHighCapDumpDetectionsByAddresses;
      let capturedAddresses = null;
      let capturedOptions = null;

      tokenMarketBucket1m.listHighCapDumpDetectionsByAddresses = async (addresses, options) => {
        capturedAddresses = addresses;
        capturedOptions = options;
        return [
          {
            tokenAddress: 'So11111111111111111111111111111111111111112',
            baselineTs: '2026-04-05T12:00:00.000Z',
            baselinePairAddress: '2AvJj5CpkvT4Qn6tQ3LRek2L4mM4A6h8K5mJ7u8h9iX1',
            baselineMcap: 8000000,
            currentTs: '2026-04-05T12:05:00.000Z',
            currentPairAddress: '4Yx3iT9W3YfAqQKpH5uVh6hNnZx4oLrR8j9t4Qw2fN3m',
            currentCloseMcap: 4200000,
            windowLowBucketTs: '2026-04-05T12:03:00.000Z',
            windowLowPairAddress: '4Yx3iT9W3YfAqQKpH5uVh6hNnZx4oLrR8j9t4Qw2fN3m',
            windowLowMcap: 3200000,
            bucketCount: 5,
            windowPairCount: 2,
            pairChangedInWindow: true,
            latestBucketAgeMs: 20000,
            dumpPct: -60,
            passesHighCapGate: true,
            passesCoverageGate: true,
            passesFreshnessGate: true,
            passesThreshold: true,
            passesPairConsistencyGate: false,
          },
          {
            tokenAddress: '7vfCXTUXx5Wc4YbM33v7Jmd7M6m8Qjz6mkTHx5f8GzE6',
            baselineTs: '2026-04-05T12:00:00.000Z',
            baselineMcap: 3500000,
            currentTs: '2026-04-05T12:05:00.000Z',
            currentCloseMcap: 2200000,
            windowLowMcap: 1500000,
            bucketCount: 5,
            latestBucketAgeMs: 10000,
            dumpPct: -57.14,
            passesHighCapGate: false,
            passesCoverageGate: true,
            passesFreshnessGate: true,
            passesThreshold: true,
            passesPairConsistencyGate: true,
          },
        ];
      };

      try {
        const res = await request(
          'GET',
          '/api/admin/high-cap-dump-candidates?addresses=So11111111111111111111111111111111111111112,7vfCXTUXx5Wc4YbM33v7Jmd7M6m8Qjz6mkTHx5f8GzE6&thresholdPct=55&minBucketCount=5&maxLatestBucketAgeMs=120000',
          { token: adminToken }
        );

        assert.equal(res.status, 200);
        assert.deepEqual(capturedAddresses, [
          'So11111111111111111111111111111111111111112',
          '7vfCXTUXx5Wc4YbM33v7Jmd7M6m8Qjz6mkTHx5f8GzE6',
        ]);
        assert.deepEqual(capturedOptions, {
          windowMinutes: undefined,
          thresholdPct: 55,
          minBaselineMcap: undefined,
          maxLatestBucketAgeMs: 120000,
          minBucketCount: 5,
        });
        assert.equal(res.body.count, 2);
        assert.equal(res.body.qualifyingCount, 0);
        assert.equal(res.body.options.thresholdPct, 55);
        assert.equal(res.body.options.minBaselineMcap, 2000000);
        assert.equal(res.body.options.minBucketCount, 5);
        assert.equal(res.body.detections[0].passesAllGates, false);
        assert.equal(res.body.detections[0].pairChangedInWindow, true);
        assert.equal(res.body.detections[0].passesPairConsistencyGate, false);
        assert.equal(res.body.detections[0].windowPairCount, 2);
        assert.equal(res.body.detections[0].currentPairAddress, '4Yx3iT9W3YfAqQKpH5uVh6hNnZx4oLrR8j9t4Qw2fN3m');
        assert.equal(res.body.detections[1].passesAllGates, false);
      } finally {
        tokenMarketBucket1m.listHighCapDumpDetectionsByAddresses = originalDetector;
      }
    });
  });

  describe('Admin Token Risk Enrichment Worker', () => {
    it('runs a token risk enrichment batch on demand', async () => {
      const originalRunOnce = tokenRiskEnrichmentWorker.runOnce;
      let capturedOptions = null;
      let capturedMeta = null;

      tokenRiskEnrichmentWorker.runOnce = async (options, meta) => {
        capturedOptions = options;
        capturedMeta = meta;
        return {
          startedAt: '2026-04-09T02:00:00.000Z',
          completedAt: '2026-04-09T02:00:01.000Z',
          candidateCount: 2,
          processed: 2,
          succeeded: 1,
          failed: 1,
          results: [],
        };
      };

      try {
        const res = await request('POST', '/api/admin/token-risk-enrichment/runs', {
          token: adminToken,
          body: {
            scanLimit: 25,
            batchLimit: 4,
          },
        });

        assert.equal(res.status, 201);
        assert.deepEqual(capturedOptions, {
          scanLimit: 25,
          batchLimit: 4,
        });
        assert.deepEqual(capturedMeta, {
          triggeredBy: 'admin',
        });
        assert.equal(res.body.candidateCount, 2);
        assert.equal(res.body.failed, 1);
      } finally {
        tokenRiskEnrichmentWorker.runOnce = originalRunOnce;
      }
    });

    it('returns 409 when the enrichment worker is already running', async () => {
      const originalRunOnce = tokenRiskEnrichmentWorker.runOnce;

      tokenRiskEnrichmentWorker.runOnce = async () => {
        throw new Error('Token risk enrichment worker already has an active run');
      };

      try {
        const res = await request('POST', '/api/admin/token-risk-enrichment/runs', {
          token: adminToken,
          body: {
            scanLimit: 25,
            batchLimit: 4,
          },
        });

        assert.equal(res.status, 409);
        assert.equal(res.body.error, 'Token risk enrichment worker already has an active run');
      } finally {
        tokenRiskEnrichmentWorker.runOnce = originalRunOnce;
      }
    });

    it('lists current token risk candidates from the selector', async () => {
      const originalListCandidates = tokenRiskCandidateSelector.listCandidates;
      let capturedOptions = null;

      tokenRiskCandidateSelector.listCandidates = async (options) => {
        capturedOptions = options;
        return [{
          address: 'So11111111111111111111111111111111111111112',
          score: 73,
          reasonCodes: ['missing_structural_enrichment', 'new_token'],
          priority: 'high',
          ageHours: 12,
          volToMcapRatio: 1.8,
          lastEnrichedAt: null,
          lastAttemptedAt: null,
          marketCap: 110000,
          volume24h: 198000,
          manualLabel: null,
        }];
      };

      try {
        const res = await request(
          'GET',
          '/api/admin/token-risk-candidates?scanLimit=90&resultLimit=5',
          { token: adminToken }
        );

        assert.equal(res.status, 200);
        assert.deepEqual(capturedOptions, {
          scanLimit: 90,
          resultLimit: 5,
        });
        assert.equal(res.body.count, 1);
        assert.equal(res.body.candidates[0].address, 'So11111111111111111111111111111111111111112');
        assert.deepEqual(res.body.candidates[0].reasonCodes, ['missing_structural_enrichment', 'new_token']);
      } finally {
        tokenRiskCandidateSelector.listCandidates = originalListCandidates;
      }
    });

    it('lists token risk enrichment by addresses', async () => {
      const originalListByAddresses = tokenRiskEnrichment.listByAddresses;
      let capturedAddresses = null;

      tokenRiskEnrichment.listByAddresses = async (addresses) => {
        capturedAddresses = addresses;
        return [{
          tokenAddress: 'So11111111111111111111111111111111111111112',
          holderCount: 123,
        }];
      };

      try {
        const res = await request(
          'GET',
          '/api/admin/token-risk-enrichment?addresses=So11111111111111111111111111111111111111112',
          { token: adminToken }
        );

        assert.equal(res.status, 200);
        assert.deepEqual(capturedAddresses, ['So11111111111111111111111111111111111111112']);
        assert.equal(res.body.count, 1);
        assert.equal(res.body.enrichments[0].holderCount, 123);
      } finally {
        tokenRiskEnrichment.listByAddresses = originalListByAddresses;
      }
    });

    it('builds token junk assessments by addresses', async () => {
      const originalListDashboardMetadataByAddresses = tokenCatalog.listDashboardMetadataByAddresses;
      const originalListSummaryByAddresses = tokenMeteoraState.listSummaryByAddresses;
      let capturedAddresses = null;

      tokenCatalog.listDashboardMetadataByAddresses = async (addresses) => {
        capturedAddresses = addresses;
        return [{
          address: 'So11111111111111111111111111111111111111112',
          symbol: 'WSOL',
          name: 'Wrapped SOL',
          last_mcap: '800000',
          last_vol_1h: '80',
          last_vol_6h: '900',
          last_vol_24h: '20000',
          last_price_change_6h: '10',
          last_price_change_24h: '18',
          monitor_priority: 'high',
          risk_review_label: null,
          risk_holder_count: 52,
          risk_mint_authority_active: true,
          risk_freeze_authority_active: false,
          risk_top_10_pct: '76',
          risk_top_20_pct: '89',
        }];
      };
      tokenMeteoraState.listSummaryByAddresses = async () => [{
        tokenAddress: 'So11111111111111111111111111111111111111112',
        hasPool: false,
        currentTvl: null,
        poolCount: 0,
      }];

      try {
        const res = await request(
          'GET',
          '/api/admin/token-junk-assessments?addresses=So11111111111111111111111111111111111111112',
          { token: adminToken }
        );

        assert.equal(res.status, 200);
        assert.deepEqual(capturedAddresses, ['So11111111111111111111111111111111111111112']);
        assert.equal(res.body.count, 1);
        assert.equal(res.body.assessments[0].assessment.label, 'junk_probable');
        assert.equal(res.body.assessments[0].assessment.autoBlock, false);
      } finally {
        tokenCatalog.listDashboardMetadataByAddresses = originalListDashboardMetadataByAddresses;
        tokenMeteoraState.listSummaryByAddresses = originalListSummaryByAddresses;
      }
    });

    it('runs token risk enrichment for explicit addresses', async () => {
      const originalRunAddressesOnce = tokenRiskEnrichmentWorker.runAddressesOnce;
      let capturedAddresses = null;
      let capturedMeta = null;

      tokenRiskEnrichmentWorker.runAddressesOnce = async (addresses, meta) => {
        capturedAddresses = addresses;
        capturedMeta = meta;
        return {
          startedAt: '2026-04-09T02:00:00.000Z',
          completedAt: '2026-04-09T02:00:01.000Z',
          candidateCount: 1,
          processed: 1,
          succeeded: 1,
          failed: 0,
          results: [],
        };
      };

      try {
        const res = await request('POST', '/api/admin/token-risk-enrichment/addresses', {
          token: adminToken,
          body: {
            addresses: ['So11111111111111111111111111111111111111112'],
          },
        });

        assert.equal(res.status, 201);
        assert.deepEqual(capturedAddresses, ['So11111111111111111111111111111111111111112']);
        assert.deepEqual(capturedMeta, {
          triggeredBy: 'admin',
        });
        assert.equal(res.body.succeeded, 1);
      } finally {
        tokenRiskEnrichmentWorker.runAddressesOnce = originalRunAddressesOnce;
      }
    });
  });

  describe('Admin Token Risk Labels', () => {
    it('saves a token risk label', async () => {
      const originalUpsertReview = tokenRiskReview.upsertReview;
      let capturedPayload = null;

      tokenRiskReview.upsertReview = async (payload) => {
        capturedPayload = payload;
        return {
          tokenAddress: payload.tokenAddress,
          label: payload.label,
          notes: payload.notes,
          createdBy: payload.createdBy,
          updatedBy: payload.updatedBy,
        };
      };

      try {
        const res = await request('POST', '/api/admin/token-risk-labels', {
          token: adminToken,
          body: {
            address: 'So11111111111111111111111111111111111111112',
            label: 'valid_but_weak',
            notes: 'manual review',
          },
        });

        assert.equal(res.status, 201);
        assert.deepEqual(capturedPayload, {
          tokenAddress: 'So11111111111111111111111111111111111111112',
          label: 'valid_but_weak',
          notes: 'manual review',
          createdBy: adminUserId,
          updatedBy: adminUserId,
        });
        assert.equal(res.body.review.label, 'valid_but_weak');
      } finally {
        tokenRiskReview.upsertReview = originalUpsertReview;
      }
    });

    it('lists token risk labels by addresses', async () => {
      const originalListByAddresses = tokenRiskReview.listByAddresses;
      let capturedAddresses = null;

      tokenRiskReview.listByAddresses = async (addresses) => {
        capturedAddresses = addresses;
        return [{
          tokenAddress: 'So11111111111111111111111111111111111111112',
          label: 'junk_probable',
          notes: 'manual review',
        }];
      };

      try {
        const res = await request(
          'GET',
          '/api/admin/token-risk-labels?addresses=So11111111111111111111111111111111111111112',
          { token: adminToken }
        );

        assert.equal(res.status, 200);
        assert.deepEqual(capturedAddresses, ['So11111111111111111111111111111111111111112']);
        assert.equal(res.body.count, 1);
        assert.equal(res.body.reviews[0].label, 'junk_probable');
      } finally {
        tokenRiskReview.listByAddresses = originalListByAddresses;
      }
    });

    it('removes a token risk label', async () => {
      const originalRemove = tokenRiskReview.remove;
      let capturedAddress = null;

      tokenRiskReview.remove = async (address) => {
        capturedAddress = address;
        return true;
      };

      try {
        const res = await request(
          'DELETE',
          '/api/admin/token-risk-labels/So11111111111111111111111111111111111111112',
          { token: adminToken }
        );

        assert.equal(res.status, 200);
        assert.equal(capturedAddress, 'So11111111111111111111111111111111111111112');
      } finally {
        tokenRiskReview.remove = originalRemove;
      }
    });
  });

  describe('Admin Users', () => {
    it('lists all users with invite info', async () => {
      const res = await request('GET', '/api/admin/users', { token: adminToken });
      assert.equal(res.status, 200);
      assert.ok(res.body.users.length >= 2);
      assert.ok(res.body.total >= 2);
      const user = res.body.users.find((entry) => entry.username === 'testuser');
      assert.ok(user);
      assert.ok(user.email);
      assert.ok(user.created_at);
    });

    it('lists online users', async () => {
      const res = await request('GET', '/api/admin/users/online', { token: adminToken });
      assert.equal(res.status, 200);
      assert.ok(res.body.online.length >= 1);
      assert.ok(res.body.count >= 1);
    });
  });

  describe('Admin User Modification', () => {
    it('deactivates a user and revokes sessions', async () => {
      const res = await request('PATCH', `/api/admin/users/${userId}`, {
        token: adminToken,
        body: { is_active: false },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.user.is_active, false);
      assert.ok(res.body.message.includes('deactivated'));

      const me = await request('GET', '/api/auth/me', { token: userToken });
      assert.equal(me.status, 401);
    });

    it('deactivated user cannot login', async () => {
      const res = await request('POST', '/api/auth/login', {
        body: { email: 'user@test.com', password: 'userpass123' },
      });
      assert.equal(res.status, 403);
    });

    it('reactivates a user', async () => {
      const res = await request('PATCH', `/api/admin/users/${userId}`, {
        token: adminToken,
        body: { is_active: true },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.user.is_active, true);
    });

    it('reactivated user can login again', async () => {
      userToken = await completeLogin('user@test.com', 'userpass123');
      const me = await request('GET', '/api/auth/me', { token: userToken });
      assert.equal(me.status, 200);
    });

    it('cannot modify self', async () => {
      const me = await request('GET', '/api/auth/me', { token: adminToken });
      const res = await request('PATCH', `/api/admin/users/${me.body.user.id}`, {
        token: adminToken,
        body: { is_active: false },
      });
      assert.equal(res.status, 400);
      assert.ok(res.body.error.includes('own account'));
    });

    it('rejects invalid user ID', async () => {
      const res = await request('PATCH', '/api/admin/users/abc', {
        token: adminToken,
        body: { is_active: false },
      });
      assert.equal(res.status, 400);
    });

    it('rejects non-existent user', async () => {
      const res = await request('PATCH', '/api/admin/users/99999', {
        token: adminToken,
        body: { is_active: false },
      });
      assert.equal(res.status, 404);
    });

    it('rejects empty update', async () => {
      const res = await request('PATCH', `/api/admin/users/${userId}`, {
        token: adminToken,
        body: {},
      });
      assert.equal(res.status, 400);
    });

    it('can promote user to admin', async () => {
      const res = await request('PATCH', `/api/admin/users/${userId}`, {
        token: adminToken,
        body: { role: 'admin' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.user.role, 'admin');
    });

    it('cannot modify another admin', async () => {
      const res = await request('PATCH', `/api/admin/users/${userId}`, {
        token: adminToken,
        body: { is_active: false },
      });
      assert.equal(res.status, 403);
      assert.ok(res.body.error.includes('another admin'));
    });

    it('reverts user back to regular role via SQL for further tests', async () => {
      const { query: dbQuery } = require('../src/models/db');
      await dbQuery("UPDATE users SET role = 'user' WHERE id = $1", [userId]);
    });
  });

  describe('Admin Force Logout', () => {
    it('force-logouts a user', async () => {
      const res = await request('DELETE', `/api/admin/users/${userId}/sessions`, {
        token: adminToken,
      });
      assert.equal(res.status, 200);
      assert.ok(res.body.message.includes('Revoked'));
    });

    it('user token no longer works after force logout', async () => {
      const res = await request('GET', '/api/auth/me', { token: userToken });
      assert.equal(res.status, 401);
    });

    it('user can login again after force logout', async () => {
      userToken = await completeLogin('user@test.com', 'userpass123');
      const res = await request('GET', '/api/auth/me', { token: userToken });
      assert.equal(res.status, 200);
    });
  });

  describe('Admin Access Management', () => {
    it('returns access snapshot for the authenticated user', async () => {
      const res = await request('GET', '/api/account/access', { token: userToken });
      assert.equal(res.status, 200);
      assert.equal(res.body.accessStatus, 'active');
      assert.equal(res.body.hasProductAccess, true);
    });

    it('grants timed access to a user', async () => {
      const res = await request('POST', `/api/admin/users/${userId}/access/grant`, {
        token: adminToken,
        body: { days: 7, source: 'admin' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.access.accessStatus, 'active');
      assert.equal(res.body.access.daysRemaining, 7);
      assert.equal(res.body.access.accessSource, 'admin');
    });

    it('extends from the current future expiry', async () => {
      const before = await request('GET', '/api/account/access', { token: userToken });
      assert.equal(before.status, 200);

      const res = await request('POST', `/api/admin/users/${userId}/access/extend`, {
        token: adminToken,
        body: { days: 5, source: 'promo' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.access.accessStatus, 'active');
      assert.equal(res.body.access.accessSource, 'promo');
      assert.ok(res.body.access.daysRemaining >= (before.body.daysRemaining + 5) - 1);
    });

    it('revokes access and active sessions', async () => {
      const res = await request('POST', `/api/admin/users/${userId}/access/revoke`, {
        token: adminToken,
        body: { source: 'admin' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.access.accessStatus, 'revoked');

      const me = await request('GET', '/api/auth/me', { token: userToken });
      assert.equal(me.status, 401);
    });

    it('revoked access blocks login', async () => {
      const res = await request('POST', '/api/auth/login', {
        body: { email: 'user@test.com', password: 'userpass123' },
      });
      assert.equal(res.status, 403);
      assert.equal(res.body.error, 'Access revoked');
    });

    it('grants access again and restores login', async () => {
      const res = await request('POST', `/api/admin/users/${userId}/access/grant`, {
        token: adminToken,
        body: { days: 14, source: 'admin' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.access.accessStatus, 'active');

      userToken = await completeLogin('user@test.com', 'userpass123');
      const me = await request('GET', '/api/auth/me', { token: userToken });
      assert.equal(me.status, 200);
    });
  });

  describe('Admin Invites', () => {
    let inviteId;

    it('creates invite with custom params', async () => {
      const res = await request('POST', '/api/admin/invites', {
        token: adminToken,
        body: { maxUses: 5, expiryHours: 48 },
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.invite.max_uses, 5);
      inviteId = res.body.invite.id;
    });

    it('lists all invites', async () => {
      const res = await request('GET', '/api/admin/invites', { token: adminToken });
      assert.equal(res.status, 200);
      assert.ok(res.body.invites.length >= 1);
    });

    it('revokes an invite', async () => {
      const res = await request('DELETE', `/api/admin/invites/${inviteId}`, { token: adminToken });
      assert.equal(res.status, 200);
      assert.equal(res.body.invite.is_revoked, true);
    });

    it('returns 404 for non-existent invite', async () => {
      const res = await request('DELETE', '/api/admin/invites/99999', { token: adminToken });
      assert.equal(res.status, 404);
    });

    it('rejects invalid custom invite params', async () => {
      const res = await request('POST', '/api/admin/invites', {
        token: adminToken,
        body: { maxUses: 'abc' },
      });
      assert.equal(res.status, 400);
    });
  });

  describe('Admin Logs', () => {
    it('returns login attempts', async () => {
      const res = await request('GET', '/api/admin/logs', { token: adminToken });
      assert.equal(res.status, 200);
      assert.ok(res.body.logs.length >= 1);
      assert.ok(res.body.logs[0].email);
      assert.ok(res.body.logs[0].created_at);
    });

    it('filters by success=false', async () => {
      const res = await request('GET', '/api/admin/logs?success=false', { token: adminToken });
      assert.equal(res.status, 200);
      for (const log of res.body.logs) {
        assert.equal(log.success, false);
      }
    });

    it('respects limit parameter', async () => {
      const res = await request('GET', '/api/admin/logs?limit=2', { token: adminToken });
      assert.equal(res.status, 200);
      assert.ok(res.body.logs.length <= 2);
    });

    it('rejects malformed success filter', async () => {
      const res = await request('GET', '/api/admin/logs?success=maybe', { token: adminToken });
      assert.equal(res.status, 400);
    });

    it('rejects malformed limit filter', async () => {
      const res = await request('GET', '/api/admin/logs?limit=abc', { token: adminToken });
      assert.equal(res.status, 400);
    });
  });
});
