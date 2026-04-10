const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const worker = require('../src/services/token-risk-enrichment-worker');

describe('token risk enrichment worker', () => {
  it('enriches selected candidates and persists structural signals', async () => {
    const savedPayloads = [];
    const recordedErrors = [];
    let capturedSelectorOptions = null;

    const result = await worker.runOnce({
      scanLimit: 20,
      batchLimit: 2,
      freshEnrichmentTtlMs: 60 * 60 * 1000,
    }, {}, {
      candidateSelector: {
        listCandidates: async (options) => {
          capturedSelectorOptions = options;
          return ([
          { address: 'So11111111111111111111111111111111111111112' },
          ]);
        },
      },
      heliusApi: {
        getAsset: async () => ({
          token_info: {
            mint_authority: 'MintAuth111',
            freeze_authority: null,
            token_program: 'Tokenkeg111',
          },
        }),
        getTokenAccounts: async () => ({ total: 123 }),
        getTokenSupply: async () => ({
          value: {
            amount: '1000000',
            decimals: 2,
            uiAmount: 10000,
          },
        }),
        getTokenLargestAccounts: async () => ({
          value: [
            { address: 'holder-1', amount: '200000', decimals: 2, uiAmount: 2000 },
            { address: 'holder-2', amount: '150000', decimals: 2, uiAmount: 1500 },
          ],
        }),
      },
      tokenRiskEnrichmentModel: {
        upsertEnrichment: async (payload) => {
          savedPayloads.push(payload);
          return payload;
        },
        recordError: async (...args) => {
          recordedErrors.push(args);
          return null;
        },
      },
    });

    assert.equal(result.candidateCount, 1);
    assert.equal(result.succeeded, 1);
    assert.equal(result.failed, 0);
    assert.equal(savedPayloads.length, 1);
    assert.equal(capturedSelectorOptions.freshEnrichmentTtlMs, 60 * 60 * 1000);
    assert.equal(savedPayloads[0].tokenAddress, 'So11111111111111111111111111111111111111112');
    assert.equal(savedPayloads[0].holderCount, 123);
    assert.equal(savedPayloads[0].mintAuthorityActive, true);
    assert.equal(recordedErrors.length, 0);
  });

  it('records enrichment errors and keeps the run alive', async () => {
    const savedPayloads = [];
    const recordedErrors = [];

    const result = await worker.runOnce({
      scanLimit: 20,
      batchLimit: 2,
    }, {}, {
      candidateSelector: {
        listCandidates: async () => ([
          { address: 'So11111111111111111111111111111111111111112' },
          { address: '34q2KmCvapecJgR6ZrtbCTrzZVtkt3a5mHEA3TuEsWYb' },
        ]),
      },
      heliusApi: {
        getAsset: async (address) => {
          if (address === '34q2KmCvapecJgR6ZrtbCTrzZVtkt3a5mHEA3TuEsWYb') {
            throw new Error('HTTP 429');
          }
          return {
            token_info: {
              mint_authority: null,
              freeze_authority: null,
              token_program: 'Tokenkeg111',
            },
          };
        },
        getTokenAccounts: async () => ({ total: 50 }),
        getTokenSupply: async () => ({
          value: {
            amount: '1000000',
            decimals: 2,
            uiAmount: 10000,
          },
        }),
        getTokenLargestAccounts: async () => ({
          value: [
            { address: 'holder-1', amount: '100000', decimals: 2, uiAmount: 1000 },
          ],
        }),
      },
      tokenRiskEnrichmentModel: {
        upsertEnrichment: async (payload) => {
          savedPayloads.push(payload);
          return payload;
        },
        recordError: async (...args) => {
          recordedErrors.push(args);
          return null;
        },
      },
    });

    assert.equal(result.processed, 2);
    assert.equal(result.succeeded, 1);
    assert.equal(result.failed, 1);
    assert.equal(savedPayloads.length, 1);
    assert.equal(recordedErrors.length, 1);
    assert.equal(recordedErrors[0][0], '34q2KmCvapecJgR6ZrtbCTrzZVtkt3a5mHEA3TuEsWYb');
    assert.equal(recordedErrors[0][1], 'HTTP 429');
  });

  it('returns an empty run cleanly when no candidates are selected', async () => {
    const result = await worker.runOnce({
      scanLimit: 20,
      batchLimit: 2,
    }, {}, {
      candidateSelector: {
        listCandidates: async () => [],
      },
      tokenRiskEnrichmentModel: {
        upsertEnrichment: async () => {
          throw new Error('should not be called');
        },
        recordError: async () => {
          throw new Error('should not be called');
        },
      },
    });

    assert.equal(result.candidateCount, 0);
    assert.equal(result.processed, 0);
    assert.equal(result.succeeded, 0);
    assert.equal(result.failed, 0);
  });

  it('enriches explicit addresses without going through the selector', async () => {
    const savedPayloads = [];

    const result = await worker.runAddressesOnce([
      'So11111111111111111111111111111111111111112',
      '34q2KmCvapecJgR6ZrtbCTrzZVtkt3a5mHEA3TuEsWYb',
    ], {}, {
      candidateSelector: {
        listCandidates: async () => {
          throw new Error('should not call selector');
        },
      },
      heliusApi: {
        getAsset: async () => ({ token_info: { token_program: 'Tokenkeg111' } }),
        getTokenAccounts: async () => ({ total: 2 }),
        getTokenSupply: async () => ({
          value: {
            amount: '1000',
            decimals: 2,
            uiAmount: 10,
          },
        }),
        getTokenLargestAccounts: async () => ({ value: [] }),
      },
      tokenRiskEnrichmentModel: {
        upsertEnrichment: async (payload) => {
          savedPayloads.push(payload);
          return payload;
        },
        recordError: async () => null,
      },
    });

    assert.equal(result.candidateCount, 2);
    assert.equal(result.succeeded, 2);
    assert.equal(savedPayloads.length, 2);
    assert.equal(savedPayloads[0].tokenAddress, 'So11111111111111111111111111111111111111112');
    assert.equal(savedPayloads[1].tokenAddress, '34q2KmCvapecJgR6ZrtbCTrzZVtkt3a5mHEA3TuEsWYb');
  });
});
