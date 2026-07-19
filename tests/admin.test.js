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

async function ensureWorkerLeaseSchema(pool) {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS worker_leases (
       lease_key VARCHAR(128) PRIMARY KEY,
       owner_id VARCHAR(128) NOT NULL,
       owner_pid INTEGER,
       owner_hostname VARCHAR(255),
       acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       lease_until TIMESTAMPTZ NOT NULL,
       metadata JSONB NOT NULL DEFAULT '{}'::jsonb
     )`
  );
}

describe('Admin panel auth and management', () => {
  let server;
  let adminToken;
  let adminUserId;
  let userToken;
  let userId;
  let tokenCatalog;
  let tokenRiskCandidateSelector;
  let tokenRiskEnrichment;
  let tokenRiskEnrichmentWorker;
  let tokenRiskReview;
  let tokenMeteoraState;
  let adminTokenReviewAlert;

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

    tokenCatalog = require('../src/models/token-catalog');
    tokenRiskCandidateSelector = require('../src/services/token-risk-candidate-selector');
    tokenRiskEnrichment = require('../src/models/token-risk-enrichment');
    tokenRiskEnrichmentWorker = require('../src/services/token-risk-enrichment-worker');
    tokenRiskReview = require('../src/models/token-risk-review');
    tokenMeteoraState = require('../src/models/token-meteora-state');
    adminTokenReviewAlert = require('../src/models/admin-token-review-alert');
    const { pool } = require('../src/models/db');
    const { assertUsingTestDatabase } = require('./helpers/test-db');

    await assertUsingTestDatabase(pool);
    await ensureAccessSchema(pool);
    await ensureWorkerLeaseSchema(pool);
    await adminTokenReviewAlert.ensureTable();
    await pool.query('DELETE FROM admin_token_review_alerts');
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

    it('GET /api/admin/token-review-alerts -> 403', async () => {
      const res = await request('GET', '/api/admin/token-review-alerts', { token: userToken });
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
      assert.deepEqual(res.body.runtime.workerGroupsRequested, ['all']);
      assert.deepEqual(res.body.runtime.workerGroupsActive, ['core', 'market', 'maintenance']);
      assert.deepEqual(res.body.runtime.workerGroupsSkipped, ['robinhood']);
      assert.ok(res.body.catalogWorker);
      assert.ok(res.body.robinhoodIngestionWorker);
      assert.ok(Object.hasOwn(res.body.robinhoodIngestionWorker, 'sharedLease'));
      assert.ok(res.body.robinhoodCatalogStagingWorker);
      assert.ok(Object.hasOwn(res.body.robinhoodCatalogStagingWorker, 'sharedLease'));
      assert.ok(res.body.robinhoodCatalogProjectionWorker);
      assert.ok(Object.hasOwn(res.body.robinhoodCatalogProjectionWorker, 'sharedLease'));
      assert.equal(typeof res.body.robinhoodLiveCatalogWorker.running, 'boolean');
      assert.equal(typeof res.body.robinhoodRealtimeAlertWorker.running, 'boolean');
      assert.equal(typeof res.body.robinhoodStandardAlertPublication.runs, 'number');
      assert.equal(res.body.robinhoodRollout.publishable, false);
      assert.equal(res.body.robinhoodRollout.axes.alerts.effective, false);
      assert.ok(Object.hasOwn(res.body.robinhoodRollout, 'telemetry'));
      assert.equal(res.body.robinhoodRollout.alertPublicationReady, true);
      assert.ok(res.body.robinhoodRollout.blockers.includes('alerts_disabled'));
      assert.ok(res.body.tokenRiskEnrichmentWorker);
      assert.equal(typeof res.body.tokenRiskEnrichmentWorker.running, 'boolean');
      assert.ok(Array.isArray(res.body.workerLeases));
      assert.ok(res.body.gmgnDiscoveryWorker);
      assert.equal(typeof res.body.gmgnDiscoveryWorker.lastGmgnSecurityChecks, 'number');
      assert.equal(typeof res.body.gmgnDiscoveryWorker.lastGmgnInfoChecks, 'number');
      assert.equal(typeof res.body.gmgnDiscoveryWorker.lastGmgnKlineChecks, 'number');
      assert.equal(typeof res.body.gmgnDiscoveryWorker.riskReviewQueue.queuedCount, 'number');
      assert.ok(res.body.gmgn);
      assert.equal(typeof res.body.gmgn.riskLookupCache.entries, 'number');
      assert.equal(typeof res.body.gmgn.riskLookupCache.hits, 'number');
    });

    it('exposes a shared Robinhood fatal lease in administrative status', async () => {
      const { pool } = require('../src/models/db');
      await pool.query(
        `INSERT INTO worker_leases (
           lease_key, owner_id, owner_pid, owner_hostname,
           acquired_at, heartbeat_at, lease_until, metadata
         ) VALUES ($1, $2, $3, $4, NOW(), NOW(), NOW(), $5::jsonb)
         ON CONFLICT (lease_key) DO UPDATE SET
           owner_id = EXCLUDED.owner_id,
           heartbeat_at = EXCLUDED.heartbeat_at,
           lease_until = EXCLUDED.lease_until,
           metadata = EXCLUDED.metadata`,
        [
          'robinhood-ingestion-worker',
          'admin-test-owner',
          process.pid,
          'admin-test-host',
          JSON.stringify({
            state: 'halted',
            haltCode: 'persistent_reorg',
            haltMessage: 'checkpoint changed',
            haltedAt: '2026-07-09T10:00:30.000Z',
          }),
        ]
      );

      try {
        const res = await request('GET', '/api/admin/ws-status', { token: adminToken });
        assert.equal(res.status, 200);
        assert.equal(res.body.robinhoodIngestionWorker.sharedLease.key, 'robinhood-ingestion-worker');
        assert.equal(res.body.robinhoodIngestionWorker.sharedLease.metadata.state, 'halted');
        assert.equal(
          res.body.robinhoodIngestionWorker.sharedLease.metadata.haltCode,
          'persistent_reorg'
        );
      } finally {
        await pool.query(
          'DELETE FROM worker_leases WHERE lease_key = $1 AND owner_id = $2',
          ['robinhood-ingestion-worker', 'admin-test-owner']
        );
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
          chain: 'solana',
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

  describe('Admin Token Review Alerts', () => {
    it('lists and resolves open token review alerts', async () => {
      const alert = await adminTokenReviewAlert.enqueue({
        tokenAddress: 'So11111111111111111111111111111111111111112',
        priority: 'high',
        alertKind: 'manual-review-socials-present',
        pipeline: 'risk-review-sync',
        label: 'auto-review:junk_probable',
        reasonCodes: ['holder_concentration_extreme'],
        assessment: { label: 'junk_probable', manualReviewRequired: true },
        socialSnapshot: { twitterUrl: 'https://x.com/wsol' },
      });

      const listResponse = await request('GET', '/api/admin/token-review-alerts?limit=10', { token: adminToken });
      assert.equal(listResponse.status, 200);
      assert.equal(listResponse.body.count >= 1, true);
      assert.ok(listResponse.body.alerts.some((item) => item.id === alert.id));

      const resolveResponse = await request('POST', `/api/admin/token-review-alerts/${alert.id}/resolve`, {
        token: adminToken,
        body: { resolution: 'dismiss', notes: 'reviewed in test' },
      });
      assert.equal(resolveResponse.status, 200);
      assert.equal(resolveResponse.body.alert.status, 'resolved');
      assert.equal(resolveResponse.body.alert.resolution, 'dismiss');

      const { pool } = require('../src/models/db');
      const robinhoodResult = await pool.query(
        `INSERT INTO admin_token_review_alerts (
           chain, token_address, alert_kind, pipeline
         ) VALUES ('robinhood', $1, 'stage9c4d-guard', 'test')
         RETURNING id`,
        ['0x1234567890abcdef1234567890abcdef12345678']
      );
      const robinhoodAlertId = robinhoodResult.rows[0].id;
      try {
        const blockedResponse = await request(
          'POST',
          `/api/admin/token-review-alerts/${robinhoodAlertId}/resolve`,
          { token: adminToken, body: { resolution: 'dismiss' } }
        );
        assert.equal(blockedResponse.status, 409);
        const persisted = await pool.query(
          'SELECT status FROM admin_token_review_alerts WHERE id = $1',
          [robinhoodAlertId]
        );
        assert.equal(persisted.rows[0].status, 'open');
      } finally {
        await pool.query('DELETE FROM admin_token_review_alerts WHERE id = $1', [robinhoodAlertId]);
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
