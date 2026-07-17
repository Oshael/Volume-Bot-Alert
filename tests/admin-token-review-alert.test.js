const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/models/db');
const adminTokenReviewAlert = require('../src/models/admin-token-review-alert');

const originalQuery = db.query;

afterEach(() => {
  db.query = originalQuery;
});

function installQueryStub(handler) {
  const calls = [];
  db.query = async (sql, params = []) => {
    calls.push({ sql, params });
    const normalized = String(sql || '').trim().toUpperCase();
    if (/admin_token_review_alerts/i.test(sql) && /^(?:INSERT|SELECT|UPDATE|DELETE)/.test(normalized)) {
      return handler(sql, params);
    }
    return { rows: [] };
  };
  return calls;
}

function buildRow(overrides = {}) {
  return {
    id: 7,
    chain: 'solana',
    token_address: 'So11111111111111111111111111111111111111112',
    status: 'open',
    priority: 'high',
    alert_kind: 'manual-review-socials-present',
    pipeline: 'risk-review-sync',
    label: 'auto-review:junk_probable',
    reason_codes: ['holder_concentration_extreme'],
    assessment: { label: 'junk_probable' },
    social_snapshot: { twitterUrl: 'https://x.com/example' },
    market_snapshot: { mcap: 500000 },
    risk_snapshot: { top10Pct: 92 },
    meteora_snapshot: { hasPool: false },
    created_at: new Date('2026-06-01T00:00:00.000Z'),
    updated_at: new Date('2026-06-01T00:00:00.000Z'),
    resolved_at: null,
    resolved_by: null,
    resolution: null,
    notes: null,
    ...overrides,
  };
}

describe('admin token review alert model', () => {
  it('enqueues open review alerts with normalized JSON payloads', async () => {
    const calls = installQueryStub((_sql, params) => ({
      rows: [buildRow({
        chain: params[0],
        token_address: params[1],
        priority: params[2],
        alert_kind: params[3],
        pipeline: params[4],
        label: params[5],
        reason_codes: JSON.parse(params[6]),
        assessment: JSON.parse(params[7]),
        social_snapshot: JSON.parse(params[8]),
      })],
    }));

    const row = await adminTokenReviewAlert.enqueue({
      tokenAddress: 'So11111111111111111111111111111111111111112',
      priority: 'high',
      alertKind: 'manual-review-socials-present',
      pipeline: 'risk-review-sync',
      label: 'auto-review:junk_probable',
      reasonCodes: ['holder_concentration_extreme'],
      assessment: { label: 'junk_probable' },
      socialSnapshot: { twitterUrl: 'https://x.com/example' },
    });

    assert.equal(row.tokenAddress, 'So11111111111111111111111111111111111111112');
    assert.equal(row.chain, 'solana');
    assert.equal(row.priority, 'high');
    assert.equal(row.alertKind, 'manual-review-socials-present');
    assert.deepEqual(row.reasonCodes, ['holder_concentration_extreme']);
    assert.equal(row.socialSnapshot.twitterUrl, 'https://x.com/example');
    assert.ok(calls.some((call) => /ON CONFLICT \(chain, token_address, alert_kind\)/.test(call.sql)));
  });

  it('lists recent alerts by open status and optional address', async () => {
    const calls = installQueryStub((_sql, params) => {
      assert.equal(params[0], 'solana');
      assert.equal(params[1], 'open');
      assert.equal(params[2], 'So11111111111111111111111111111111111111112');
      assert.equal(params[3], 25);
      return { rows: [buildRow()] };
    });

    const rows = await adminTokenReviewAlert.listRecent({
      status: 'open',
      address: 'So11111111111111111111111111111111111111112',
      limit: 25,
    });

    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'open');
    assert.ok(calls.some((call) => /ORDER BY\s+CASE priority/.test(call.sql)));
  });

  it('keeps automatic Robinhood review alerts disabled', async () => {
    await assert.rejects(
      () => adminTokenReviewAlert.enqueue({
        chain: 'robinhood',
        tokenAddress: '0x1234567890abcdef1234567890abcdef12345678',
      }),
      (error) => error.code === 'NON_SOLANA_ADMIN_REVIEW_ALERT_DISABLED'
    );
  });

  it('resolves an open alert with the chosen resolution', async () => {
    installQueryStub((_sql, params) => {
      assert.equal(params[0], 7);
      assert.equal(params[1], 'dismiss');
      assert.equal(params[2], 42);
      assert.equal(params[3], 'reviewed');
      return {
        rows: [buildRow({
          status: 'resolved',
          resolution: 'dismiss',
          resolved_by: 42,
          notes: 'reviewed',
        })],
      };
    });

    const row = await adminTokenReviewAlert.resolve(7, {
      resolution: 'dismiss',
      resolvedBy: 42,
      notes: 'reviewed',
    });

    assert.equal(row.status, 'resolved');
    assert.equal(row.resolution, 'dismiss');
    assert.equal(row.resolvedBy, 42);
  });
});
