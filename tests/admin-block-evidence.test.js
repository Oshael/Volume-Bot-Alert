const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const adminBlockEvidence = require('../src/models/admin-block-evidence');
const db = require('../src/models/db');

describe('admin block evidence model helpers', () => {
  it('normalizes JSON snapshots without accepting arrays as objects', () => {
    assert.deepEqual(adminBlockEvidence.__private.normalizeJsonObject({ mcap: 123 }), { mcap: 123 });
    assert.deepEqual(adminBlockEvidence.__private.normalizeJsonObject(null), {});
    assert.deepEqual(adminBlockEvidence.__private.normalizeJsonObject(['bad']), {});
    assert.deepEqual(adminBlockEvidence.__private.normalizeJsonArray([{ label: 'x' }]), [{ label: 'x' }]);
    assert.deepEqual(adminBlockEvidence.__private.normalizeJsonArray({ label: 'x' }), []);
  });

  it('maps stored rows to API shape', () => {
    assert.deepEqual(adminBlockEvidence.__private.mapRow({
      id: '7',
      chain: 'solana',
      token_address: 'So11111111111111111111111111111111111111112',
      ban_label: 'auto-junk-probable:test',
      created_by: null,
      pipeline: 'risk-review-sync',
      source: 'gmgn',
      catalog_snapshot: { symbol: 'T' },
      market_snapshot: { mcap: 1 },
      risk_snapshot: { holders: 2 },
      meteora_snapshot: { hasPool: false },
      gmgn_snapshot: { raw: true },
      assessment: { label: 'junk_probable' },
      rule_matches: [{ label: 'auto-junk-probable:test' }],
      created_at: '2026-05-17T00:00:00.000Z',
    }), {
      id: 7,
      chain: 'solana',
      tokenAddress: 'So11111111111111111111111111111111111111112',
      banLabel: 'auto-junk-probable:test',
      createdBy: null,
      pipeline: 'risk-review-sync',
      source: 'gmgn',
      catalogSnapshot: { symbol: 'T' },
      marketSnapshot: { mcap: 1 },
      riskSnapshot: { holders: 2 },
      meteoraSnapshot: { hasPool: false },
      gmgnSnapshot: { raw: true },
      assessment: { label: 'junk_probable' },
      ruleMatches: [{ label: 'auto-junk-probable:test' }],
      createdAt: '2026-05-17T00:00:00.000Z',
    });
  });

  it('persists normalized Robinhood identity with the evidence payload', async () => {
    const originalQuery = db.query;
    let captured;
    db.query = async () => ({ rows: [], rowCount: 0 });
    const runner = {
      async query(sql, params) {
        captured = { sql: String(sql), params };
        return {
          rows: [{
            id: 1,
            chain: params[0],
            token_address: params[1],
            pipeline: params[4],
          }],
        };
      },
    };

    try {
      const row = await adminBlockEvidence.createEvidence({
        chain: 'robinhood',
        tokenAddress: '0xAbCdEf0123456789aBCdef0123456789aBCDEf01',
        pipeline: 'robinhood-risk',
      }, runner);

      assert.equal(row.chain, 'robinhood');
      assert.equal(row.tokenAddress, '0xabcdef0123456789abcdef0123456789abcdef01');
      assert.match(captured.sql, /INSERT INTO admin_block_evidence \(\s+chain,/);
      assert.deepEqual(captured.params.slice(0, 2), [
        'robinhood',
        '0xabcdef0123456789abcdef0123456789abcdef01',
      ]);
    } finally {
      db.query = originalQuery;
    }
  });
});
