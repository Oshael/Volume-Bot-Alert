const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const worker = require('../src/services/token-risk-review-sync-worker');

describe('token risk review sync worker', () => {
  it('persists auto labels from the current junk assessment', async () => {
    const saved = [];
    const evidence = [];
    const blocked = [];
    const suppressed = [];
    const removedAutoReviews = [];
    const result = await worker.__private.processRows([
      {
        address: 'BafT6NoybUFdEMn8RUA9fyYUqeC5SgCCE9ccocAt5t6M',
        symbol: 'RTPBET',
        last_mcap: 113660296,
        last_vol_1h: 10,
        last_vol_6h: 100,
        last_vol_24h: 900,
        last_liquidity_usd: 877620.15,
        last_txns_24h_buys: 9,
        last_txns_24h_sells: 26,
        risk_holder_count: 158,
        risk_top_10_pct: 84.63,
        risk_top_20_pct: 97.49,
        risk_mint_authority_active: false,
        risk_freeze_authority_active: false,
        risk_review_source: null,
      },
    ], {
      tokenMeteoraStateModel: {
        listSummaryByAddresses: async () => [{
          tokenAddress: 'BafT6NoybUFdEMn8RUA9fyYUqeC5SgCCE9ccocAt5t6M',
          hasPool: false,
          currentTvl: null,
          poolCount: 0,
        }],
      },
      tokenRiskReviewModel: {
        upsertAutoReview: async (payload) => {
          saved.push(payload);
          return {
            tokenAddress: payload.tokenAddress,
            label: payload.label,
            source: 'auto',
          };
        },
        removeAutoReview: async (address) => {
          removedAutoReviews.push(address);
          return true;
        },
      },
      adminBlockedTokenModel: {
        add: async (payload) => {
          blocked.push(payload);
          return payload;
        },
      },
      tokenCatalogModel: {
        applyEvaluationResult: async (address, payload) => {
          suppressed.push({ address, payload });
          return { address, ...payload };
        },
      },
      tokenJunkEvidenceCaptureService: {
        captureJunkEvidence: async (row, assessment, meteoraSummary) => {
          evidence.push({ row, assessment, meteoraSummary });
        },
      },
    });

    assert.equal(result.saved, 1);
    assert.equal(result.autoBlocked, 1);
    assert.equal(result.manualProtected, 0);
    assert.equal(saved[0].label, 'junk_probable');
    assert.equal(blocked[0].address, 'BafT6NoybUFdEMn8RUA9fyYUqeC5SgCCE9ccocAt5t6M');
    assert.match(blocked[0].label, /^auto-junk-probable:/);
    assert.equal(suppressed[0].payload.suppressedReason, 'admin_blocked');
    assert.deepEqual(removedAutoReviews, ['BafT6NoybUFdEMn8RUA9fyYUqeC5SgCCE9ccocAt5t6M']);
    assert.match(saved[0].notes, /^auto\/v1_manual_review:/);
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0].assessment.label, 'junk_probable');
  });

  it('counts manual rows as protected when auto sync hits an existing manual review', async () => {
    const result = await worker.__private.processRows([
      {
        address: 'So11111111111111111111111111111111111111112',
        last_mcap: 700000,
        last_vol_1h: 20000,
        last_vol_6h: 250000,
        last_vol_24h: 1200000,
        last_liquidity_usd: 250000,
        last_txns_24h_buys: 120,
        last_txns_24h_sells: 118,
        risk_holder_count: 800,
        risk_top_10_pct: 22,
        risk_top_20_pct: 31,
        risk_mint_authority_active: false,
        risk_freeze_authority_active: false,
        risk_review_source: 'manual',
      },
    ], {
      tokenMeteoraStateModel: {
        listSummaryByAddresses: async () => [{
          tokenAddress: 'So11111111111111111111111111111111111111112',
          hasPool: true,
          currentTvl: 85000,
          poolCount: 2,
        }],
      },
      tokenRiskReviewModel: {
        upsertAutoReview: async () => ({
          tokenAddress: 'So11111111111111111111111111111111111111112',
          label: 'valid_but_weak',
          source: 'manual',
        }),
      },
      adminBlockedTokenModel: {
        add: async () => {
          throw new Error('manual rows must not be auto-blocked');
        },
      },
    });

    assert.equal(result.saved, 0);
    assert.equal(result.autoBlocked, 0);
    assert.equal(result.manualProtected, 1);
  });

  it('keeps auto-valid tokens as valid_but_weak until structural coverage exists', async () => {
    const saved = [];
    const result = await worker.__private.processRows([
      {
        address: 'So11111111111111111111111111111111111111112',
        last_mcap: 1800000,
        last_vol_1h: 120000,
        last_vol_6h: 600000,
        last_vol_24h: 1900000,
        last_liquidity_usd: 240000,
        last_txns_24h_buys: 480,
        last_txns_24h_sells: 430,
        risk_holder_count: null,
        risk_top_10_pct: null,
        risk_top_20_pct: null,
        risk_mint_authority_active: null,
        risk_freeze_authority_active: null,
      },
    ], {
      tokenMeteoraStateModel: {
        listSummaryByAddresses: async () => [{
          tokenAddress: 'So11111111111111111111111111111111111111112',
          hasPool: true,
          currentTvl: 85000,
          poolCount: 2,
        }],
      },
      tokenRiskReviewModel: {
        upsertAutoReview: async (payload) => {
          saved.push(payload);
          return {
            tokenAddress: payload.tokenAddress,
            label: payload.label,
            source: 'auto',
          };
        },
        removeAutoReview: async () => {
          throw new Error('valid_but_weak rows must not be auto-blocked');
        },
      },
      adminBlockedTokenModel: {
        add: async () => {
          throw new Error('valid_but_weak rows must not be auto-blocked');
        },
      },
    });

    assert.equal(result.saved, 1);
    assert.equal(result.autoBlocked, 0);
    assert.equal(saved[0].label, 'valid_but_weak');
  });

  it('does not fail the sync when junk evidence capture throws', async () => {
    const saved = [];
    const blocked = [];
    const result = await worker.__private.processRows([
      {
        address: 'BafT6NoybUFdEMn8RUA9fyYUqeC5SgCCE9ccocAt5t6M',
        symbol: 'RTPBET',
        last_mcap: 113660296,
        last_vol_1h: 10,
        last_vol_6h: 100,
        last_vol_24h: 900,
        last_liquidity_usd: 877620.15,
        last_txns_24h_buys: 9,
        last_txns_24h_sells: 26,
        risk_holder_count: 158,
        risk_top_10_pct: 84.63,
        risk_top_20_pct: 97.49,
        risk_mint_authority_active: false,
        risk_freeze_authority_active: false,
      },
    ], {
      tokenMeteoraStateModel: {
        listSummaryByAddresses: async () => [{
          tokenAddress: 'BafT6NoybUFdEMn8RUA9fyYUqeC5SgCCE9ccocAt5t6M',
          hasPool: false,
          currentTvl: null,
          poolCount: 0,
        }],
      },
      tokenRiskReviewModel: {
        upsertAutoReview: async (payload) => {
          saved.push(payload);
          return {
            tokenAddress: payload.tokenAddress,
            label: payload.label,
            source: 'auto',
          };
        },
        removeAutoReview: async () => true,
      },
      adminBlockedTokenModel: {
        add: async (payload) => {
          blocked.push(payload);
          return payload;
        },
      },
      tokenCatalogModel: {
        applyEvaluationResult: async () => ({}),
      },
      tokenJunkEvidenceCaptureService: {
        captureJunkEvidence: async () => {
          throw new Error('boom');
        },
      },
    });

    assert.equal(result.saved, 1);
    assert.equal(result.autoBlocked, 1);
    assert.equal(blocked.length, 1);
    assert.equal(saved[0].label, 'junk_probable');
  });
});
