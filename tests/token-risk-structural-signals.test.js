const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const structuralSignals = require('../src/services/token-risk-structural-signals');

describe('token risk structural signals', () => {
  it('computes concentration percentages and authority flags', () => {
    const result = structuralSignals.buildStructuralSignals({
      asset: {
        token_info: {
          mint_authority: 'MintAuth111',
          freeze_authority: 'FreezeAuth111',
          token_program: 'Tokenkeg...',
        },
      },
      tokenSupply: {
        value: {
          amount: '1000000',
          decimals: 2,
          uiAmount: 10000,
        },
      },
      largestAccounts: {
        value: [
          { address: 'holder-1', amount: '200000', decimals: 2, uiAmount: 2000 },
          { address: 'holder-2', amount: '150000', decimals: 2, uiAmount: 1500 },
          { address: 'holder-3', amount: '100000', decimals: 2, uiAmount: 1000 },
          { address: 'holder-4', amount: '50000', decimals: 2, uiAmount: 500 },
          { address: 'holder-5', amount: '25000', decimals: 2, uiAmount: 250 },
        ],
      },
    });

    assert.equal(result.supply.uiAmount, 10000);
    assert.equal(result.mintAuthorityActive, true);
    assert.equal(result.freezeAuthorityActive, true);
    assert.equal(result.top1Pct, 20);
    assert.equal(result.top5Pct, 52.5);
    assert.equal(result.top10Pct, 52.5);
    assert.equal(result.top20Pct, 52.5);
    assert.deepEqual(result.reasonCodes, [
      'mint_authority_active',
      'freeze_authority_active',
    ]);
    assert.equal(result.topHolders.length, 5);
    assert.equal(result.topHolders[0].pctOfSupply, 20);
  });

  it('uses thresholded concentration reason codes', () => {
    const result = structuralSignals.buildStructuralSignals({
      asset: {
        token_info: {},
      },
      tokenSupply: {
        value: {
          amount: '1000',
          decimals: 0,
          uiAmount: 1000,
        },
      },
      largestAccounts: {
        value: [
          { address: 'holder-1', amount: '400', decimals: 0, uiAmount: 400 },
          { address: 'holder-2', amount: '200', decimals: 0, uiAmount: 200 },
          { address: 'holder-3', amount: '150', decimals: 0, uiAmount: 150 },
          { address: 'holder-4', amount: '150', decimals: 0, uiAmount: 150 },
        ],
      },
    }, {
      top10HighPct: 70,
      top20HighPct: 85,
    });

    assert.equal(result.top10Pct, 90);
    assert.equal(result.top20Pct, 90);
    assert.deepEqual(result.reasonCodes, [
      'top_10_concentration_high',
      'top_20_concentration_high',
    ]);
  });

  it('returns nulls cleanly when supply data is missing', () => {
    const result = structuralSignals.buildStructuralSignals({
      asset: {
        token_info: {
          holders: 42,
        },
      },
      largestAccounts: {
        value: [
          { address: 'holder-1', amount: '100', decimals: 0, uiAmount: 100 },
        ],
      },
    });

    assert.equal(result.holderCount, 42);
    assert.equal(result.supply.uiAmount, null);
    assert.equal(result.top1Pct, null);
    assert.equal(result.top10Pct, null);
    assert.deepEqual(result.reasonCodes, []);
  });

  it('prefers the total holder count returned by token accounts', () => {
    const result = structuralSignals.buildStructuralSignals({
      asset: {
        token_info: {
          holders: 42,
        },
      },
      tokenAccounts: {
        total: 137,
      },
    });

    assert.equal(result.holderCount, 137);
  });
});
