const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const worker = require('../src/services/token-risk-review-sync-worker');

describe('token risk review sync worker', () => {
  it('uses 15k as the default auto-risk review market-cap floor', () => {
    assert.equal(worker.DEFAULT_MIN_MCAP, 15000);
    assert.equal(worker.__private.normalizeOptions({}).minMcap, 15000);
  });

  it('persists manual-review junk assessments without auto-blocking', async () => {
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
    assert.equal(result.autoBlocked, 0);
    assert.equal(result.manualProtected, 0);
    assert.equal(saved[0].label, 'junk_probable');
    assert.equal(blocked.length, 0);
    assert.equal(suppressed.length, 0);
    assert.deepEqual(removedAutoReviews, []);
    assert.match(saved[0].notes, /^auto\/v1_manual_review:/);
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0].assessment.label, 'junk_probable');
    assert.equal(evidence[0].assessment.autoBlock, false);
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

  it('does not demote a persisted valid review to junk_probable', async () => {
    const result = await worker.__private.processRows([
      {
        address: 'So11111111111111111111111111111111111111112',
        last_mcap: 1200000,
        last_vol_1h: 100,
        last_vol_6h: 500,
        last_vol_24h: 800,
        last_liquidity_usd: 1000,
        last_txns_24h_buys: 2,
        last_txns_24h_sells: 30,
        risk_holder_count: 20,
        risk_top_10_pct: 92,
        risk_top_20_pct: 98,
        risk_mint_authority_active: true,
        risk_freeze_authority_active: false,
        risk_review_label: 'valid',
        risk_review_source: 'auto',
      },
    ], {
      tokenMeteoraStateModel: {
        listSummaryByAddresses: async () => [],
      },
      tokenRiskReviewModel: {
        upsertAutoReview: async () => {
          throw new Error('valid reviews must not be recalculated');
        },
      },
      adminBlockedTokenModel: {
        add: async () => {
          throw new Error('valid reviews must not be auto-blocked');
        },
      },
      tokenJunkEvidenceCaptureService: {
        captureJunkEvidence: async () => {
          throw new Error('valid reviews must not capture junk evidence');
        },
      },
    });

    assert.equal(result.saved, 0);
    assert.equal(result.autoBlocked, 0);
    assert.equal(result.manualProtected, 0);
    assert.equal(result.validProtected, 1);
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

  it('does not auto-block young GMGN high-churn tokens on liquidity ratio alone', async () => {
    const saved = [];
    const blocked = [];
    const suppressed = [];
    const createdAtMs = Date.now() - (60 * 60 * 1000);
    const result = await worker.__private.processRows([
      {
        address: '379BCjzGPuFvqTHcpJPU8m9ZUjh8bXoCPV4hG8Ljpump',
        source: 'gmgn',
        last_mcap: 50000,
        last_vol_1h: 130000,
        last_vol_6h: 130000,
        last_vol_24h: 130000,
        last_liquidity_usd: 500,
        last_txns_24h_buys: 1600,
        last_txns_24h_sells: 900,
        last_price_change_24h: 400,
        last_token_created_at_ms: createdAtMs,
      },
    ], {
      tokenMeteoraStateModel: {
        listSummaryByAddresses: async () => [],
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
        applyEvaluationResult: async (address, payload) => {
          suppressed.push({ address, payload });
          return { address, ...payload };
        },
      },
      tokenJunkEvidenceCaptureService: {
        captureJunkEvidence: async () => {},
      },
    });

    assert.equal(result.saved, 1);
    assert.equal(result.autoBlocked, 0);
    assert.equal(saved[0].label, 'valid_but_weak');
    assert.equal(blocked.length, 0);
    assert.equal(suppressed.length, 0);
  });

  it('does not treat zero GMGN liquidity as confirmed thin liquidity for young high-churn tokens', async () => {
    const saved = [];
    const blocked = [];
    const suppressed = [];
    const createdAtMs = Date.now() - (60 * 60 * 1000);
    const result = await worker.__private.processRows([
      {
        address: '379BCjzGPuFvqTHcpJPU8m9ZUjh8bXoCPV4hG8Ljpump',
        source: 'gmgn',
        last_mcap: 30403.12,
        last_vol_1h: 73540.69,
        last_vol_6h: 73540.69,
        last_vol_24h: 73540.69,
        last_liquidity_usd: 0,
        last_txns_24h_buys: 1100,
        last_txns_24h_sells: 540,
        last_price_change_24h: 250,
        last_token_created_at_ms: createdAtMs,
      },
    ], {
      tokenMeteoraStateModel: {
        listSummaryByAddresses: async () => [],
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
        applyEvaluationResult: async (address, payload) => {
          suppressed.push({ address, payload });
          return { address, ...payload };
        },
      },
      tokenJunkEvidenceCaptureService: {
        captureJunkEvidence: async () => {},
      },
    });

    assert.equal(result.saved, 1);
    assert.equal(result.autoBlocked, 0);
    assert.equal(saved[0].label, 'valid_but_weak');
    assert.equal(blocked.length, 0);
    assert.equal(suppressed.length, 0);
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
    assert.equal(result.autoBlocked, 0);
    assert.equal(blocked.length, 0);
    assert.equal(saved[0].label, 'junk_probable');
  });

  it('auto-blocks enriched GMGN quarantine tokens with concentrated holder structure', async () => {
    const saved = [];
    const blocked = [];
    const suppressed = [];
    const result = await worker.__private.processRows([
      {
        address: 'BafT6NoybUFdEMn8RUA9fyYUqeC5SgCCE9ccocAt5t6M',
        source: 'gmgn',
        suppressed_reason: 'gmgn_needs_risk_enrichment',
        symbol: 'BILL',
        name: 'Billions',
        last_mcap: 108620,
        last_vol_1h: 7538620,
        last_vol_24h: 9301710,
        last_liquidity_usd: 175668,
        risk_holder_count: 1000,
        risk_top_10_pct: 94.79,
        risk_top_20_pct: 97.91,
        risk_mint_authority_active: false,
        risk_freeze_authority_active: false,
        risk_enrichment_last_enriched_at: new Date('2026-05-03T07:00:00.000Z'),
      },
    ], {
      tokenMeteoraStateModel: {
        listSummaryByAddresses: async () => [],
      },
      tokenRiskReviewModel: {
        upsertAutoReview: async (payload) => {
          saved.push(payload);
          return { tokenAddress: payload.tokenAddress, label: payload.label, source: 'auto' };
        },
        removeAutoReview: async (address) => {
          suppressed.push(['removeAutoReview', address]);
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
          suppressed.push(['applyEvaluationResult', address, payload]);
          return { address, ...payload };
        },
      },
      tokenJunkEvidenceCaptureService: {
        captureJunkEvidence: async () => {},
      },
    });

    assert.equal(result.saved, 1);
    assert.equal(result.autoBlocked, 1);
    assert.equal(result.released, 0);
    assert.equal(saved[0].label, 'junk_probable');
    assert.match(saved[0].notes, /gmgn_young_extreme_churn/);
    assert.equal(blocked[0].address, 'BafT6NoybUFdEMn8RUA9fyYUqeC5SgCCE9ccocAt5t6M');
    assert.match(blocked[0].label, /^auto-junk-probable:gmgn_young_extreme_churn/);
    assert.equal(suppressed.find(([name]) => name === 'applyEvaluationResult')[2].suppressedReason, 'admin_blocked');
  });

  it('releases enriched GMGN quarantine tokens when holder structure passes', async () => {
    const saved = [];
    const released = [];
    const result = await worker.__private.processRows([
      {
        address: 'So11111111111111111111111111111111111111112',
        source: 'gmgn',
        suppressed_reason: 'gmgn_needs_risk_enrichment',
        symbol: 'SPIRIT2.0',
        name: 'Spirit Airlines 2.0',
        last_mcap: 125339,
        last_price: 0.000125,
        last_vol_5m: 54019,
        last_vol_1h: 1287710,
        last_vol_6h: 1287710,
        last_vol_24h: 0,
        last_liquidity_usd: 29055,
        last_token_created_at_ms: Date.parse('2026-05-03T06:00:00.000Z'),
        risk_holder_count: 691,
        risk_top_10_pct: 47.42,
        risk_top_20_pct: 55.39,
        risk_mint_authority_active: false,
        risk_freeze_authority_active: false,
        risk_enrichment_last_enriched_at: new Date('2026-05-03T07:00:00.000Z'),
      },
    ], {
      tokenMeteoraStateModel: {
        listSummaryByAddresses: async () => [],
      },
      tokenRiskReviewModel: {
        upsertAutoReview: async (payload) => {
          saved.push(payload);
          return { tokenAddress: payload.tokenAddress, label: payload.label, source: 'auto' };
        },
        removeAutoReview: async () => {
          throw new Error('valid GMGN quarantine tokens must not be auto-blocked');
        },
      },
      adminBlockedTokenModel: {
        add: async () => {
          throw new Error('valid GMGN quarantine tokens must not be blocklisted');
        },
      },
      tokenCatalogModel: {
        applyEvaluationResult: async (address, payload) => {
          released.push({ address, payload });
          return { address, ...payload };
        },
      },
      tokenJunkEvidenceCaptureService: {
        captureJunkEvidence: async () => {},
      },
    });

    assert.equal(result.saved, 1);
    assert.equal(result.autoBlocked, 0);
    assert.equal(result.released, 1);
    assert.equal(saved[0].label, 'valid');
    assert.equal(released[0].payload.eligibilityState, 'gmgn-high');
    assert.equal(released[0].payload.eligibleForMonitoring, true);
    assert.equal(released[0].payload.suppressedReason, null);
  });

  it('auto-blocks young Dex tokens when GMGN info shows impossible holder count for mcap', async () => {
    const saved = [];
    const blocked = [];
    const suppressed = [];
    let gmgnInfoChecks = 0;
    const address = '3XwDQHMKcner1GhXRqLKojrWWwNdMaruQs7g7riDpump';
    const result = await worker.__private.processRows([
      {
        address,
        source: 'dexscreener-discovery',
        symbol: 'Trollpface',
        name: 'Trollpface',
        last_mcap: 393849,
        last_vol_1h: 557372.86,
        last_vol_6h: 2598193.28,
        last_vol_24h: 5649945.77,
        last_liquidity_usd: 58809.31,
        last_txns_24h_buys: 70288,
        last_txns_24h_sells: 18876,
        last_price_change_24h: 287,
        last_token_created_at_ms: Date.now() - (14 * 60 * 60 * 1000),
        risk_holder_count: 1000,
        risk_top_10_pct: 5.07,
        risk_top_20_pct: 6.48,
        risk_mint_authority_active: false,
        risk_freeze_authority_active: false,
      },
    ], {
      gmgnClient: {
        async fetchTokenInfo(request) {
          gmgnInfoChecks += 1;
          assert.equal(request.address, address);
          assert.equal(request.chain, 'sol');
          return {
            address,
            holderCount: 18574,
            marketCap: 409434.05,
          };
        },
      },
      tokenMeteoraStateModel: {
        listSummaryByAddresses: async () => [],
      },
      tokenRiskReviewModel: {
        upsertAutoReview: async (payload) => {
          saved.push(payload);
          return { tokenAddress: payload.tokenAddress, label: payload.label, source: 'auto' };
        },
        removeAutoReview: async (tokenAddress) => {
          suppressed.push(['removeAutoReview', tokenAddress]);
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
        applyEvaluationResult: async (tokenAddress, payload) => {
          suppressed.push(['applyEvaluationResult', tokenAddress, payload]);
          return { tokenAddress, ...payload };
        },
      },
      tokenJunkEvidenceCaptureService: {
        captureJunkEvidence: async () => {},
      },
    });

    assert.equal(gmgnInfoChecks, 1);
    assert.equal(result.saved, 1);
    assert.equal(result.autoBlocked, 1);
    assert.equal(saved[0].label, 'junk_probable');
    assert.match(saved[0].notes, /gmgn_holder_count_mcap_anomaly/);
    assert.equal(blocked[0].address, address);
    assert.equal(blocked[0].label, 'auto-junk-probable:gmgn_holder_count_mcap_anomaly');
    assert.equal(suppressed.find(([name]) => name === 'applyEvaluationResult')[2].suppressedReason, 'admin_blocked');
  });

  it('auto-blocks young low-mcap tokens that sustain extreme 5m volume', async () => {
    const saved = [];
    const blocked = [];
    const suppressed = [];
    const address = 'ErrBkqwZMKUqzBcokm4F56Gmwd7R9QY4y7iRPdm258dn';
    const result = await worker.__private.processRows([
      {
        address,
        source: 'dexscreener-discovery',
        symbol: '1SHOT',
        name: '1 SHOT',
        last_mcap: 73184,
        last_vol_5m: 764289.53,
        last_vol_1h: 5869396.99,
        last_vol_6h: 5869396.99,
        last_vol_24h: 5869396.99,
        last_liquidity_usd: 84000,
        last_txns_24h_buys: 5022,
        last_txns_24h_sells: 3545,
        last_price_change_24h: 186,
        last_token_created_at_ms: Date.now() - (5 * 60 * 60 * 1000),
        risk_holder_count: null,
        risk_top_10_pct: null,
        risk_top_20_pct: null,
        risk_mint_authority_active: false,
        risk_freeze_authority_active: false,
      },
    ], {
      gmgnClient: {
        async fetchTokenInfo() {
          throw new Error('low-mcap volume gate must not depend on GMGN info');
        },
      },
      tokenMeteoraStateModel: {
        listSummaryByAddresses: async () => [],
      },
      tokenRiskReviewModel: {
        upsertAutoReview: async (payload) => {
          saved.push(payload);
          return { tokenAddress: payload.tokenAddress, label: payload.label, source: 'auto' };
        },
        removeAutoReview: async (tokenAddress) => {
          suppressed.push(['removeAutoReview', tokenAddress]);
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
        applyEvaluationResult: async (tokenAddress, payload) => {
          suppressed.push(['applyEvaluationResult', tokenAddress, payload]);
          return { tokenAddress, ...payload };
        },
      },
      tokenJunkEvidenceCaptureService: {
        captureJunkEvidence: async () => {},
      },
    });

    assert.equal(result.saved, 1);
    assert.equal(result.autoBlocked, 1);
    assert.equal(saved[0].label, 'junk_probable');
    assert.match(saved[0].notes, /new_low_mcap_extreme_vol5m_churn/);
    assert.equal(blocked[0].address, address);
    assert.equal(blocked[0].label, 'auto-junk-probable:new_low_mcap_extreme_vol5m_churn');
    assert.equal(suppressed.find(([name]) => name === 'applyEvaluationResult')[2].suppressedReason, 'admin_blocked');
  });

});
