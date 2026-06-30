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
    if (/admin_token_review_alerts/i.test(sql) && !normalized.startsWith('CREATE')) {
      return handler(sql, params);
    }
    return { rows: [] };
  };
  return calls;
}

function buildRow(overrides = {}) {
  return {
    id: 7,
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
        token_address: params[0],
        priority: params[1],
        alert_kind: params[2],
        pipeline: params[3],
        label: params[4],
        reason_codes: JSON.parse(params[5]),
        assessment: JSON.parse(params[6]),
        social_snapshot: JSON.parse(params[7]),
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
    assert.equal(row.priority, 'high');
    assert.equal(row.alertKind, 'manual-review-socials-present');
    assert.deepEqual(row.reasonCodes, ['holder_concentration_extreme']);
    assert.equal(row.socialSnapshot.twitterUrl, 'https://x.com/example');
    assert.ok(calls.some((call) => /ON CONFLICT \(token_address, alert_kind\)/.test(call.sql)));
  });

  it('lists recent alerts by open status and optional address', async () => {
    const calls = installQueryStub((_sql, params) => {
      assert.equal(params[0], 'open');
      assert.equal(params[1], 'So11111111111111111111111111111111111111112');
      assert.equal(params[2], 25);
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
