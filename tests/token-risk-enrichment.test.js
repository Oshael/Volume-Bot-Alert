const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/models/db');
const tokenRiskEnrichment = require('../src/models/token-risk-enrichment');

describe('token risk enrichment model', () => {
  it('upserts structural enrichment payloads with normalized fields', async () => {
    const originalQuery = db.query;
    let capturedParams = null;

    db.query = async (_sql, params) => {
      capturedParams = params;
      return {
        rows: [{
          token_address: 'So11111111111111111111111111111111111111112',
          source: 'helius',
          last_attempted_at: '2026-04-08T21:00:00.000Z',
          last_enriched_at: '2026-04-08T21:00:00.000Z',
          last_error: null,
          holder_count: 137,
          supply_amount: '1000000000',
          supply_decimals: 6,
          supply_ui_amount: '1000',
          token_program: 'Tokenkeg111',
          mint_authority: 'MintAuth111',
          freeze_authority: null,
          mint_authority_active: true,
          freeze_authority_active: false,
          top_1_pct: '12.5',
          top_5_pct: '37.5',
          top_10_pct: '61.25',
          top_20_pct: '82.15',
          top_holders: [{ address: 'holder-1', uiAmount: 125, pctOfSupply: 12.5 }],
          reason_codes: ['mint_authority_active'],
          updated_at: '2026-04-08T21:00:00.000Z',
        }],
      };
    };

    try {
      const state = await tokenRiskEnrichment.upsertEnrichment({
        tokenAddress: 'So11111111111111111111111111111111111111112',
        source: 'Helius',
        holderCount: 137,
        supply: {
          amount: '1000000000',
          decimals: 6,
          uiAmount: 1000,
          tokenProgram: 'Tokenkeg111',
        },
        mintAuthority: 'MintAuth111',
        freezeAuthority: null,
        mintAuthorityActive: true,
        freezeAuthorityActive: false,
        top1Pct: 12.5,
        top5Pct: 37.5,
        top10Pct: 61.25,
        top20Pct: 82.15,
        topHolders: [{ address: 'holder-1', uiAmount: 125, pctOfSupply: 12.5 }],
        reasonCodes: ['mint_authority_active', 'mint_authority_active'],
        lastAttemptedAt: '2026-04-08T21:00:00.000Z',
        lastEnrichedAt: '2026-04-08T21:00:00.000Z',
      });

      assert.equal(capturedParams[0], 'So11111111111111111111111111111111111111112');
      assert.equal(capturedParams[1], 'helius');
      assert.equal(capturedParams[5], 137);
      assert.equal(capturedParams[10], 'MintAuth111');
      assert.equal(capturedParams[12], true);
      assert.equal(capturedParams[13], false);
      assert.equal(capturedParams[18], JSON.stringify([{ address: 'holder-1', uiAmount: 125, pctOfSupply: 12.5 }]));
      assert.equal(capturedParams[19], JSON.stringify(['mint_authority_active']));
      assert.equal(state.holderCount, 137);
      assert.equal(state.mintAuthorityActive, true);
      assert.equal(state.freezeAuthorityActive, false);
      assert.equal(state.top20Pct, 82.15);
    } finally {
      db.query = originalQuery;
    }
  });

  it('records enrichment errors without requiring a successful payload', async () => {
    const originalQuery = db.query;
    let capturedParams = null;

    db.query = async (_sql, params) => {
      capturedParams = params;
      return {
        rows: [{
          token_address: '34q2KmCvapecJgR6ZrtbCTrzZVtkt3a5mHEA3TuEsWYb',
          source: 'helius',
          last_attempted_at: '2026-04-08T21:10:00.000Z',
          last_enriched_at: null,
          last_error: 'HTTP 429',
          holder_count: null,
          supply_amount: null,
          supply_decimals: null,
          supply_ui_amount: null,
          token_program: null,
          mint_authority: null,
          freeze_authority: null,
          mint_authority_active: false,
          freeze_authority_active: false,
          top_1_pct: null,
          top_5_pct: null,
          top_10_pct: null,
          top_20_pct: null,
          top_holders: [],
          reason_codes: [],
          updated_at: '2026-04-08T21:10:00.000Z',
        }],
      };
    };

    try {
      const state = await tokenRiskEnrichment.recordError(
        '34q2KmCvapecJgR6ZrtbCTrzZVtkt3a5mHEA3TuEsWYb',
        'HTTP 429',
        {
          source: 'helius',
          lastAttemptedAt: '2026-04-08T21:10:00.000Z',
        }
      );

      assert.deepEqual(capturedParams, [
        '34q2KmCvapecJgR6ZrtbCTrzZVtkt3a5mHEA3TuEsWYb',
        'helius',
        new Date('2026-04-08T21:10:00.000Z'),
        'HTTP 429',
      ]);
      assert.equal(state.lastEnrichedAt, null);
      assert.equal(state.lastError, 'HTTP 429');
      assert.deepEqual(state.reasonCodes, []);
    } finally {
      db.query = originalQuery;
    }
  });

  it('lists persisted enrichment rows by address', async () => {
    const originalQuery = db.query;
    let capturedParams = null;

    db.query = async (_sql, params) => {
      capturedParams = params;
      return {
        rows: [{
          token_address: 'So11111111111111111111111111111111111111112',
          source: 'helius',
          last_attempted_at: '2026-04-08T21:00:00.000Z',
          last_enriched_at: '2026-04-08T21:00:00.000Z',
          last_error: null,
          holder_count: 137,
          supply_amount: '1000000000',
          supply_decimals: 6,
          supply_ui_amount: '1000',
          token_program: 'Tokenkeg111',
          mint_authority: null,
          freeze_authority: null,
          mint_authority_active: false,
          freeze_authority_active: false,
          top_1_pct: '12.5',
          top_5_pct: '37.5',
          top_10_pct: '61.25',
          top_20_pct: '82.15',
          top_holders: [],
          reason_codes: [],
          updated_at: '2026-04-08T21:00:00.000Z',
        }],
      };
    };

    try {
      const rows = await tokenRiskEnrichment.listByAddresses([
        'So11111111111111111111111111111111111111112',
      ]);

      assert.deepEqual(capturedParams, [['So11111111111111111111111111111111111111112']]);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].holderCount, 137);
    } finally {
      db.query = originalQuery;
    }
  });
});
