const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const worker = require('../src/services/token-risk-review-sync-worker');

function buildLiquiditySamples(address, values) {
  return values.map((value, index) => ({
    token_address: address,
    bucket_ts: new Date(Date.now() - (index * 60 * 1000)).toISOString(),
    close_liquidity_usd: value,
  }));
}

function buildGmgnUnprotectedLiquiditySamples(address, count = 4, overrides = {}) {
  return Array.from({ length: count }, (_, index) => ({
    token_address: address,
    bucket_ts: new Date(Date.now() - (index * 60 * 1000)).toISOString(),
    gmgn_lock_percent: 0,
    gmgn_burn_ratio: 0,
    gmgn_burn_status: 'none',
    gmgn_creator_close: true,
    gmgn_creator_token_status: 'creator_close',
    ...overrides,
  }));
}

describe('token risk review sync worker', () => {
  it('uses 15k as the default auto-risk review market-cap floor', () => {
    assert.equal(worker.DEFAULT_MIN_MCAP, 15000);
    assert.equal(worker.__private.normalizeOptions({}).minMcap, 15000);
  });

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

  it('auto-blocks young GMGN tokens after 4 unprotected-liquidity bucket confirmations', async () => {
    const address = 'NkriyfsMn6duSttoac1QU58EyWpP1M81sCfq6eDxovF';
    const saved = [];
    const blocked = [];

    const result = await worker.__private.processRows([
      {
        address,
        source: 'gmgn',
        symbol: 'WOOD',
        last_mcap: 29266,
        last_liquidity_usd: 29280,
        last_vol_1h: 50000,
        last_vol_24h: 50000,
        last_token_created_at_ms: Date.now() - (60 * 60 * 1000),
        suppressed_reason: 'gmgn_unprotected_liquidity_pending',
        risk_review_source: null,
      },
    ], {
      tokenMeteoraStateModel: {
        listSummaryByAddresses: async () => [],
      },
      tokenMarketBucket1mModel: {
        listRecentLiquiditySamplesByAddresses: async () => [],
        listRecentGmgnLiquidityProtectionSamplesByAddresses: async () => (
          buildGmgnUnprotectedLiquiditySamples(address, 4)
        ),
      },
      tokenRiskReviewModel: {
        upsertAutoReview: async (payload) => {
          saved.push(payload);
          return { ...payload, source: 'auto' };
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
        applyEvaluationResult: async (tokenAddress, payload) => ({ tokenAddress, ...payload }),
      },
      tokenJunkEvidenceCaptureService: {
        captureJunkEvidence: async () => {},
      },
    });

    assert.equal(result.saved, 1);
    assert.equal(result.autoBlocked, 1);
    assert.equal(saved[0].label, 'junk_probable');
    assert.match(saved[0].notes, /gmgn_unprotected_liquidity/);
    assert.equal(blocked[0].address, address);
    assert.equal(blocked[0].label, 'auto-junk-probable:gmgn_unprotected_liquidity');
  });

  it('waits for 4 unprotected-liquidity buckets before auto-blocking GMGN tokens', async () => {
    const address = 'NkriyfsMn6duSttoac1QU58EyWpP1M81sCfq6eDxovF';
    const saved = [];

    const result = await worker.__private.processRows([
      {
        address,
        source: 'gmgn',
        last_mcap: 29266,
        last_liquidity_usd: 29280,
        last_token_created_at_ms: Date.now() - (60 * 60 * 1000),
        suppressed_reason: 'gmgn_unprotected_liquidity_pending',
        risk_review_source: null,
      },
    ], {
      tokenMeteoraStateModel: {
        listSummaryByAddresses: async () => [],
      },
      tokenMarketBucket1mModel: {
        listRecentLiquiditySamplesByAddresses: async () => [],
        listRecentGmgnLiquidityProtectionSamplesByAddresses: async () => (
          buildGmgnUnprotectedLiquiditySamples(address, 3)
        ),
      },
      tokenRiskReviewModel: {
        upsertAutoReview: async (payload) => {
          saved.push(payload);
          return { ...payload, source: 'auto' };
        },
      },
      adminBlockedTokenModel: {
        add: async () => {
          throw new Error('token must not be blocked before 4 confirmations');
        },
      },
      tokenJunkEvidenceCaptureService: {
        captureJunkEvidence: async () => {},
      },
    });

    assert.equal(result.saved, 1);
    assert.equal(result.autoBlocked, 0);
    assert.equal(saved[0].label, 'valid_but_weak');
    assert.match(saved[0].notes, /gmgn_unprotected_liquidity_pending_confirmation/);
  });

  it('does not apply the GMGN unprotected-liquidity gate after 6 hours of token age', () => {
    const address = 'NkriyfsMn6duSttoac1QU58EyWpP1M81sCfq6eDxovF';
    const assessment = worker.__private.buildGmgnUnprotectedLiquidityAssessment({
      address,
      source: 'gmgn',
      last_mcap: 29266,
      last_liquidity_usd: 29280,
      last_token_created_at_ms: Date.now() - (7 * 60 * 60 * 1000),
      risk_review_source: null,
    }, buildGmgnUnprotectedLiquiditySamples(address, 4));

    assert.equal(assessment, null);
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

  it('auto-blocks young GMGN low-cap high-churn tokens with truly microscopic liquidity', async () => {
    const saved = [];
    const blocked = [];
    const suppressed = [];
    const createdAtMs = Date.now() - (60 * 60 * 1000);
    const address = 'EAshzB35kVsN5hwupFsZxLA5swj1vgEDcScbiV3KK5ic';
    const result = await worker.__private.processRows([
      {
        address,
        source: 'gmgn',
        last_mcap: 60912,
        last_vol_1h: 153812.79,
        last_vol_6h: 153812.79,
        last_vol_24h: 153812.79,
        last_liquidity_usd: 6.81,
        last_txns_24h_buys: 3000,
        last_txns_24h_sells: 1498,
        last_price_change_24h: 666,
        last_token_created_at_ms: createdAtMs,
      },
    ], {
      tokenMeteoraStateModel: {
        listSummaryByAddresses: async () => [],
      },
      tokenMarketBucket1mModel: {
        listRecentLiquiditySamplesByAddresses: async () => buildLiquiditySamples(address, [6.81, 6.81, 6.81, 6.81, 6.81]),
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
    assert.equal(result.autoBlocked, 1);
    assert.equal(saved[0].label, 'junk_probable');
    assert.match(saved[0].notes, /gmgn_young_low_cap_high_churn_gate/);
    assert.match(blocked[0].label, /gmgn_young_low_cap_high_churn_thin_liquidity/);
    assert.equal(suppressed[0].payload.suppressedReason, 'admin_blocked');
  });

  it('auto-blocks any automatic token with liquidity below 1k', async () => {
    const saved = [];
    const blocked = [];
    const suppressed = [];
    const createdAtMs = Date.now() - (60 * 60 * 1000);
    const address = '379BCjzGPuFvqTHcpJPU8m9ZUjh8bXoCPV4hG8Ljpump';
    const result = await worker.__private.processRows([
      {
        address,
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
      tokenMarketBucket1mModel: {
        listRecentLiquiditySamplesByAddresses: async () => buildLiquiditySamples(address, [500, 600, 700, 800, 900]),
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
    assert.equal(result.autoBlocked, 1);
    assert.equal(saved[0].label, 'junk_probable');
    assert.match(saved[0].notes, /global_low_liquidity_gate/);
    assert.equal(blocked[0].label, 'auto-junk-probable:low_liquidity_under_1k');
    assert.equal(suppressed[0].payload.suppressedReason, 'admin_blocked');
  });

  it('auto-blocks automatic tokens with zero liquidity', async () => {
    const saved = [];
    const blocked = [];
    const suppressed = [];
    const createdAtMs = Date.now() - (60 * 60 * 1000);
    const address = '379BCjzGPuFvqTHcpJPU8m9ZUjh8bXoCPV4hG8Ljpump';
    const result = await worker.__private.processRows([
      {
        address,
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
      tokenMarketBucket1mModel: {
        listRecentLiquiditySamplesByAddresses: async () => buildLiquiditySamples(address, [0, 0, 0, 0, 0]),
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
    assert.equal(result.autoBlocked, 1);
    assert.equal(saved[0].label, 'junk_probable');
    assert.match(saved[0].notes, /global_low_liquidity_gate/);
    assert.equal(blocked[0].label, 'auto-junk-probable:low_liquidity_under_1k');
    assert.equal(suppressed[0].payload.suppressedReason, 'admin_blocked');
  });

  it('requires five confirmed low-liquidity buckets before the hard ban', () => {
    const address = 'So11111111111111111111111111111111111111112';
    const createdAtMs = Date.now() - (60 * 60 * 1000);

    assert.equal(
      worker.__private.buildGlobalLowLiquidityAssessment(
        { address, last_liquidity_usd: 500, last_token_created_at_ms: createdAtMs, risk_review_source: 'auto' },
        buildLiquiditySamples(address, [500, 500, 500, 500])
      ),
      null
    );

    assert.equal(
      worker.__private.buildGlobalLowLiquidityAssessment(
        { address, last_liquidity_usd: 500, last_token_created_at_ms: createdAtMs, risk_review_source: 'auto' },
        buildLiquiditySamples(address, [500, 500, 1200, 500, 500])
      ),
      null
    );
  });

  it('does not apply the global low-liquidity hard ban after six hours', () => {
    const address = 'So11111111111111111111111111111111111111112';
    const oldCreatedAtMs = Date.now() - (7 * 60 * 60 * 1000);

    assert.equal(
      worker.__private.buildGlobalLowLiquidityAssessment(
        { address, last_liquidity_usd: 500, last_token_created_at_ms: oldCreatedAtMs, risk_review_source: 'auto' },
        buildLiquiditySamples(address, [500, 500, 500, 500, 500])
      ),
      null
    );
  });

  it('does not let generic junk fallback auto-block low-liquidity tokens before five buckets', async () => {
    const saved = [];
    const blocked = [];
    const address = '726MVtUgSjsHZvyaaYQw4jg59UBBfJE9MZqj2qw8Rvbu';
    const result = await worker.__private.processRows([
      {
        address,
        source: 'gmgn',
        eligibility_state: 'dex-normal',
        last_mcap: 80000,
        last_vol_5m: 5000,
        last_vol_1h: 20000,
        last_vol_6h: 45000,
        last_vol_24h: 90000,
        last_liquidity_usd: 75,
        last_txns_24h_buys: 120,
        last_txns_24h_sells: 95,
        last_token_created_at_ms: Date.now() - (60 * 60 * 1000),
        risk_review_source: 'auto',
      },
    ], {
      tokenMeteoraStateModel: {
        listSummaryByAddresses: async () => [],
      },
      tokenMarketBucket1mModel: {
        listRecentLiquiditySamplesByAddresses: async () => buildLiquiditySamples(address, [75, 75, 75, 75]),
      },
      tokenRiskReviewModel: {
        upsertAutoReview: async (payload) => {
          saved.push(payload);
          return { tokenAddress: payload.tokenAddress, label: payload.label, source: 'auto' };
        },
      },
      adminBlockedTokenModel: {
        add: async (payload) => {
          blocked.push(payload);
          return payload;
        },
      },
      tokenJunkEvidenceCaptureService: {
        captureJunkEvidence: async () => {},
      },
    });

    assert.equal(result.saved, 1);
    assert.equal(result.autoBlocked, 0);
    assert.equal(saved[0].label, 'valid_but_weak');
    assert.match(saved[0].notes, /low_liquidity_pending_confirmation/);
    assert.equal(blocked.length, 0);
  });

  it('applies the low-liquidity ban outside GMGN sources', async () => {
    const saved = [];
    const blocked = [];
    const address = 'BafT6NoybUFdEMn8RUA9fyYUqeC5SgCCE9ccocAt5t6M';
    const result = await worker.__private.processRows([
      {
        address,
        source: 'dexscreener',
        last_mcap: 250000,
        last_vol_1h: 500,
        last_vol_6h: 1200,
        last_vol_24h: 3000,
        last_liquidity_usd: 999.99,
        last_token_created_at_ms: Date.now() - (60 * 60 * 1000),
        risk_review_source: 'auto',
      },
    ], {
      tokenMeteoraStateModel: {
        listSummaryByAddresses: async () => [],
      },
      tokenMarketBucket1mModel: {
        listRecentLiquiditySamplesByAddresses: async () => buildLiquiditySamples(address, [999.99, 800, 750, 700, 650]),
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
        applyEvaluationResult: async (tokenAddress, payload) => ({ tokenAddress, ...payload }),
      },
      tokenJunkEvidenceCaptureService: {
        captureJunkEvidence: async () => {},
      },
    });

    assert.equal(result.saved, 1);
    assert.equal(result.autoBlocked, 1);
    assert.equal(saved[0].label, 'junk_probable');
    assert.equal(blocked[0].address, address);
    assert.equal(blocked[0].label, 'auto-junk-probable:low_liquidity_under_1k');
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

  it('auto-blocks GMGN low-cap tokens with dead recent volume and microscopic liquidity support', async () => {
    const saved = [];
    const blocked = [];
    const suppressed = [];
    const address = '5wdq5LvJapSxLspVd5KCi6ZeLx9d9JjxDuth1PLqRNgM';
    const result = await worker.__private.processRows([
      {
        address,
        source: 'gmgn',
        eligibility_state: 'dex-unavailable',
        suppressed_reason: 'dex_unavailable',
        symbol: 'KARDS',
        name: 'Kards Kollektors',
        last_mcap: 103282,
        last_vol_5m: 0,
        last_vol_1h: 0,
        last_vol_6h: 0,
        last_vol_24h: 7029.36,
        last_liquidity_usd: 41.87,
        last_txns_24h_buys: 27,
        last_txns_24h_sells: 28,
        risk_holder_count: 201,
        risk_top_10_pct: 36.01,
        risk_top_20_pct: 46.07,
        risk_mint_authority_active: false,
        risk_freeze_authority_active: false,
      },
    ], {
      tokenMeteoraStateModel: {
        listSummaryByAddresses: async () => [{
          tokenAddress: address,
          hasPool: false,
          currentTvl: null,
          poolCount: 0,
        }],
      },
      tokenMarketBucket1mModel: {
        listRecentLiquiditySamplesByAddresses: async () => buildLiquiditySamples(address, [41.87, 41.87, 41.87, 41.87, 41.87]),
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
    assert.match(saved[0].notes, /gmgn_low_mcap_thin_support/);
    assert.equal(blocked[0].address, address);
    assert.equal(blocked[0].label, 'auto-junk-probable:gmgn_low_mcap_thin_support');
    assert.equal(suppressed.find(([name]) => name === 'applyEvaluationResult')[2].suppressedReason, 'admin_blocked');
  });

  it('auto-blocks GMGN thin-support junk down to 15k mcap', async () => {
    const saved = [];
    const blocked = [];
    const address = 'HXcf9kYh1NvvcZZgyxDCsgYevMwnhRr36JXzu1YmUzAh';
    const result = await worker.__private.processRows([
      {
        address,
        source: 'gmgn',
        eligibility_state: 'dex-unavailable',
        suppressed_reason: 'dex_unavailable',
        symbol: 'VIRUSCOIN',
        last_mcap: 18000,
        last_vol_5m: 0,
        last_vol_1h: 0,
        last_vol_6h: 0,
        last_vol_24h: 800,
        last_liquidity_usd: 90,
        risk_review_source: 'auto',
      },
    ], {
      tokenMeteoraStateModel: {
        listSummaryByAddresses: async () => [],
      },
      tokenMarketBucket1mModel: {
        listRecentLiquiditySamplesByAddresses: async () => buildLiquiditySamples(address, [90, 90, 90, 90, 90]),
      },
      tokenRiskReviewModel: {
        upsertAutoReview: async (payload) => {
          saved.push(payload);
          return { tokenAddress: payload.tokenAddress, label: payload.label, source: 'auto' };
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
        applyEvaluationResult: async (tokenAddress, payload) => ({ tokenAddress, ...payload }),
      },
      tokenJunkEvidenceCaptureService: {
        captureJunkEvidence: async () => {},
      },
    });

    assert.equal(result.saved, 1);
    assert.equal(result.autoBlocked, 1);
    assert.equal(saved[0].label, 'junk_probable');
    assert.equal(blocked[0].label, 'auto-junk-probable:gmgn_low_mcap_thin_support');
  });

  it('auto-blocks GMGN tokens on confirmed microscopic liquidity alone', async () => {
    const saved = [];
    const blocked = [];
    const suppressed = [];
    const address = '726MVtUgSjsHZvyaaYQw4jg59UBBfJE9MZqj2qw8Rvbu';
    const result = await worker.__private.processRows([
      {
        address,
        source: 'gmgn',
        eligibility_state: 'dex-normal',
        symbol: 'MICRO',
        last_mcap: 80000,
        last_vol_5m: 5000,
        last_vol_1h: 20000,
        last_vol_6h: 45000,
        last_vol_24h: 90000,
        last_liquidity_usd: 75,
        last_txns_24h_buys: 120,
        last_txns_24h_sells: 95,
        risk_review_source: 'auto',
      },
    ], {
      tokenMeteoraStateModel: {
        listSummaryByAddresses: async () => [],
      },
      tokenMarketBucket1mModel: {
        listRecentLiquiditySamplesByAddresses: async () => buildLiquiditySamples(address, [75, 75, 75, 75, 75]),
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
    assert.match(saved[0].notes, /gmgn_confirmed_micro_liquidity/);
    assert.equal(blocked[0].address, address);
    assert.equal(blocked[0].label, 'auto-junk-probable:gmgn_confirmed_micro_liquidity');
    assert.equal(blocked[0].evidence.pipeline, 'risk-review-sync');
    assert.equal(blocked[0].evidence.marketSnapshot.mcap, 80000);
    assert.equal(blocked[0].evidence.marketSnapshot.liquidityUsd, 75);
    assert.deepEqual(blocked[0].evidence.ruleMatches[0].reasonCodes, ['gmgn_confirmed_micro_liquidity']);
    assert.equal(suppressed.find(([name]) => name === 'applyEvaluationResult')[2].suppressedReason, 'admin_blocked');
  });

  it('auto-blocks GMGN low-cap 24h churn when liquidity support is microscopic', async () => {
    const saved = [];
    const blocked = [];
    const suppressed = [];
    const address = '428PxrkSRNHFFuSrN5YUTcQ4g5mKn1iCeek2s29xucL9';
    const result = await worker.__private.processRows([
      {
        address,
        source: 'gmgn',
        eligibility_state: 'dex-normal',
        symbol: 'CUCK',
        name: 'Cool Unbothered Confident King',
        last_mcap: 98905,
        last_vol_5m: 0,
        last_vol_1h: 0,
        last_vol_6h: 0,
        last_vol_24h: 4722184.72,
        last_liquidity_usd: 192.78,
        last_txns_24h_buys: 16370,
        last_txns_24h_sells: 15855,
        risk_holder_count: 1000,
        risk_top_10_pct: 51.70,
        risk_top_20_pct: 65.37,
        risk_mint_authority_active: false,
        risk_freeze_authority_active: false,
      },
    ], {
      tokenMeteoraStateModel: {
        listSummaryByAddresses: async () => [],
      },
      tokenMarketBucket1mModel: {
        listRecentLiquiditySamplesByAddresses: async () => buildLiquiditySamples(address, [192.78, 192.78, 192.78, 192.78, 192.78]),
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
    assert.match(saved[0].notes, /gmgn_low_mcap_extreme_24h_churn_thin_liquidity/);
    assert.equal(blocked[0].address, address);
    assert.equal(blocked[0].label, 'auto-junk-probable:gmgn_low_mcap_extreme_24h_churn_thin_liquidity');
    assert.equal(suppressed.find(([name]) => name === 'applyEvaluationResult')[2].suppressedReason, 'admin_blocked');
  });
});
