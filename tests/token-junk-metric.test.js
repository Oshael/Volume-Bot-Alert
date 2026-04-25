const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { classifyTokenJunk } = require('../src/services/token-junk-metric');

describe('token junk metric', () => {
  it('marks a token as junk_permanent candidate when 3 strong structural signals are present', () => {
    const assessment = classifyTokenJunk({
      mcap: 900000,
      volume1h: 2000,
      volume6h: 12000,
      volume24h: 90000,
      holderCount: 24,
      mintAuthorityActive: true,
      freezeAuthorityActive: true,
      top10Pct: 91,
      top20Pct: 97,
      meteora: { noPool: true, poolCount: 0, tvl: null },
    });

    assert.equal(assessment.label, 'junk_permanent');
    assert.equal(assessment.autoBlock, false);
    assert.equal(assessment.manualReviewRequired, true);
    assert.ok(assessment.reasonCodes.includes('mint_authority_active'));
    assert.ok(assessment.reasonCodes.includes('freeze_authority_active'));
    assert.ok(assessment.reasonCodes.includes('holder_count_extremely_low_for_mcap'));
  });

  it('marks a token as junk_probable when structural and behavioral signals combine', () => {
    const assessment = classifyTokenJunk({
      mcap: 650000,
      volume1h: 40,
      volume6h: 500,
      volume24h: 18000,
      holderCount: 58,
      mintAuthorityActive: false,
      freezeAuthorityActive: false,
      top10Pct: 74,
      top20Pct: 88,
      meteora: { noPool: true, poolCount: 0, tvl: null },
    });

    assert.equal(assessment.label, 'junk_probable');
    assert.ok(assessment.reasonCodes.includes('holder_count_extremely_low_for_mcap'));
    assert.ok(assessment.reasonCodes.includes('holder_concentration_high'));
    assert.ok(assessment.reasonCodes.includes('meteora_absent_above_400k_mcap'));
  });

  it('uses richer Dex signals to lift suspicious tokens into junk_probable without structural hard evidence', () => {
    const assessment = classifyTokenJunk({
      mcap: 520000,
      volume1h: 1800,
      volume6h: 14000,
      volume24h: 90000,
      liquidityUsd: 18000,
      txns24hBuys: 144,
      txns24hSells: 32,
      holderCount: 88,
      meteora: { noPool: true, poolCount: 0, tvl: null },
    });

    assert.equal(assessment.label, 'junk_probable');
    assert.ok(assessment.reasonCodes.includes('holder_count_low_for_mcap'));
    assert.ok(assessment.reasonCodes.includes('liquidity_to_mcap_too_low'));
    assert.ok(assessment.reasonCodes.includes('buy_sell_imbalance_high'));
    assert.equal(assessment.txns24hTotal, 176);
    assert.equal(assessment.buySellImbalanceRatio24h, 4.5);
  });

  it('caps behavior-only false positives at non-junk when the token looks structurally healthy', () => {
    const assessment = classifyTokenJunk({
      mcap: 876609,
      volume1h: 90,
      volume6h: 1200,
      volume24h: 1718.86,
      liquidityUsd: 154389.92,
      txns24hBuys: 22,
      txns24hSells: 21,
      holderCount: 1000,
      top10Pct: 29.5,
      top20Pct: 41.81,
      meteora: { noPool: false, poolCount: 33, tvl: 7466.94 },
    });

    assert.equal(assessment.label, 'valid');
    assert.ok(assessment.reasonCodes.includes('volume_to_mcap_too_low'));
    assert.ok(!assessment.reasonCodes.includes('recent_volume_dead'));
    assert.ok(assessment.positiveSignals.includes('holder_distribution_healthy'));
  });

  it('keeps no-pool but structurally healthy low-activity tokens out of junk_probable when only weak behavioral evidence exists', () => {
    const assessment = classifyTokenJunk({
      mcap: 544630,
      volume1h: 80,
      volume6h: 1200,
      volume24h: 5574.43,
      liquidityUsd: 59114.8,
      txns24hBuys: 52,
      txns24hSells: 36,
      holderCount: 796,
      top10Pct: 28.36,
      top20Pct: 41.47,
      meteora: { noPool: true, poolCount: 1, tvl: null },
    });

    assert.equal(assessment.label, 'valid');
    assert.ok(assessment.reasonCodes.includes('meteora_absent_above_400k_mcap'));
    assert.ok(assessment.reasonCodes.includes('volume_to_mcap_too_low'));
    assert.ok(!assessment.reasonCodes.includes('recent_volume_dead'));
  });

  it('still marks extreme buy-sell imbalance tokens as junk_probable even without structural red flags', () => {
    const assessment = classifyTokenJunk({
      mcap: 200093,
      volume1h: 200,
      volume6h: 2400,
      volume24h: 1246.99,
      liquidityUsd: 34028.78,
      txns24hBuys: 129,
      txns24hSells: 3,
      holderCount: 388,
      top10Pct: 51.47,
      top20Pct: 59.81,
      meteora: { noPool: true, poolCount: 0, tvl: null },
    });

    assert.equal(assessment.label, 'junk_probable');
    assert.ok(assessment.reasonCodes.includes('buy_sell_imbalance_extreme'));
    assert.ok(assessment.reasonCodes.includes('volume24h_too_low'));
  });

  it('promotes dead microcap shells into junk_probable even without structural enrichment', () => {
    const assessment = classifyTokenJunk({
      mcap: 81902.29,
      volume1h: 0,
      volume6h: 0,
      volume24h: 10.64,
      liquidityUsd: 0,
      txns24hBuys: 1,
      txns24hSells: 0,
      priceChange24h: 0,
      meteora: { noPool: false, poolCount: 0, tvl: null },
    });

    assert.equal(assessment.label, 'junk_probable');
    assert.equal(assessment.txns24hTotal, 1);
    assert.ok(assessment.reasonCodes.includes('volume_to_mcap_too_low') || assessment.reasonCodes.length === 0);
  });

  it('promotes collapsed ultra-low-cap tokens into junk_probable when activity is tiny', () => {
    const assessment = classifyTokenJunk({
      mcap: 7498,
      volume1h: 296.92,
      volume6h: 3928.83,
      volume24h: 7596.16,
      liquidityUsd: 6782.23,
      txns24hBuys: 26,
      txns24hSells: 18,
      priceChange24h: -55.76,
      meteora: { noPool: false, poolCount: 0, tvl: null },
    });

    assert.equal(assessment.label, 'junk_probable');
  });

  it('promotes low-cap dislocation bundles into junk_probable when liquidity support is tiny', () => {
    const assessment = classifyTokenJunk({
      mcap: 14723,
      volume1h: 331.31,
      volume6h: 364.09,
      volume24h: 563.24,
      liquidityUsd: 67.78,
      txns24hBuys: 90,
      txns24hSells: 47,
      priceChange6h: 0,
      priceChange24h: 1604,
      meteora: { noPool: false, poolCount: 0, tvl: null },
    });

    assert.equal(assessment.label, 'junk_probable');
    assert.ok(assessment.reasonCodes.includes('price_dislocation_extreme'));
  });

  it('promotes low-cap extreme imbalance bundles into junk_probable when recent volume is dead', () => {
    const assessment = classifyTokenJunk({
      mcap: 2072,
      volume1h: 4.8,
      volume6h: 12.06,
      volume24h: 1074.26,
      liquidityUsd: 3604.41,
      txns24hBuys: 84,
      txns24hSells: 10,
      priceChange24h: -24.22,
      meteora: { noPool: false, poolCount: 0, tvl: null },
    });

    assert.equal(assessment.label, 'junk_probable');
    assert.ok(assessment.reasonCodes.includes('buy_sell_imbalance_extreme'));
  });

  it('promotes no-pool high-imbalance thin-market bundles back to junk_probable in v2.1', () => {
    const assessment = classifyTokenJunk({
      mcap: 558022,
      volume1h: 0.17,
      volume6h: 2308.12,
      volume24h: 10905.14,
      liquidityUsd: 73534.58,
      txns24hBuys: 24,
      txns24hSells: 88,
      holderCount: 409,
      top10Pct: 40.16,
      top20Pct: 57.38,
      meteora: { noPool: true, poolCount: 0, tvl: null },
    });

    assert.equal(assessment.label, 'junk_probable');
    assert.ok(assessment.reasonCodes.includes('buy_sell_imbalance_high'));
    assert.ok(assessment.reasonCodes.includes('volume_to_mcap_too_low'));
    assert.ok(assessment.reasonCodes.includes('meteora_absent_above_400k_mcap'));
  });

  it('promotes no-pool low-efficiency bundles when corroborated by concentration or sustained trading', () => {
    const assessment = classifyTokenJunk({
      mcap: 4504639,
      volume1h: 918.69,
      volume6h: 7322.48,
      volume24h: 19818.26,
      liquidityUsd: 175632.98,
      txns24hBuys: 46,
      txns24hSells: 34,
      holderCount: 1000,
      top10Pct: 80.46,
      top20Pct: 85.26,
      meteora: { noPool: true, poolCount: 0, tvl: null },
    });

    assert.equal(assessment.label, 'junk_probable');
    assert.ok(assessment.reasonCodes.includes('holder_concentration_high'));
    assert.ok(assessment.reasonCodes.includes('volume_to_mcap_too_low'));
    assert.ok(assessment.reasonCodes.includes('liquidity_to_mcap_too_low'));
  });

  it('promotes no-pool dead micro-activity bundles only when holder profile is weak enough', () => {
    const assessment = classifyTokenJunk({
      mcap: 396997,
      volume1h: 0,
      volume6h: 1240.23,
      volume24h: 3638.15,
      liquidityUsd: 49258.58,
      txns24hBuys: 17,
      txns24hSells: 9,
      holderCount: 211,
      top10Pct: 56.68,
      top20Pct: 73.40,
      meteora: { noPool: true, poolCount: 0, tvl: null },
    });

    assert.equal(assessment.label, 'junk_probable');
    assert.ok(assessment.reasonCodes.includes('recent_volume_dead'));
    assert.ok(assessment.reasonCodes.includes('volume24h_too_low'));
  });

  it('does not reopen weak-but-legit no-pool low-activity tokens when concentration is the only structural blemish', () => {
    const assessment = classifyTokenJunk({
      mcap: 168600,
      volume1h: 42,
      volume6h: 1130,
      volume24h: 2025.42,
      liquidityUsd: 31782.57,
      txns24hBuys: 11,
      txns24hSells: 8,
      holderCount: 195,
      top10Pct: 72.30,
      top20Pct: 89.49,
      meteora: { noPool: true, poolCount: 0, tvl: null },
    });

    assert.equal(assessment.label, 'valid_but_weak');
    assert.ok(assessment.reasonCodes.includes('holder_concentration_high'));
    assert.ok(assessment.reasonCodes.includes('recent_volume_dead'));
  });

  it('keeps suspicious but weaker tokens as valid_but_weak', () => {
    const assessment = classifyTokenJunk({
      mcap: 150000,
      volume1h: 600,
      volume6h: 4000,
      volume24h: 21000,
      holderCount: 48,
      top10Pct: 0,
      top20Pct: 0,
      meteora: { noPool: true, poolCount: 0, tvl: null },
    });

    assert.equal(assessment.label, 'valid_but_weak');
    assert.equal(assessment.autoBlock, false);
  });

  it('does not punish strong healthy volume only because price moved hard', () => {
    const assessment = classifyTokenJunk({
      mcap: 700000,
      volume1h: 20000,
      volume6h: 250000,
      volume24h: 1200000,
      priceChange6h: -6,
      priceChange24h: 420,
      meteora: { noPool: false, poolCount: 3, tvl: 25000 },
    });

    assert.equal(assessment.label, 'valid');
  });

  it('upgrades high-liquidity active high caps back to valid when only ratio mismatches remain', () => {
    const assessment = classifyTokenJunk({
      mcap: 19843127,
      volume1h: 9976.96,
      volume6h: 110868.04,
      volume24h: 471272.23,
      liquidityUsd: 375087.27,
      txns24hBuys: 4351,
      txns24hSells: 4418,
      meteora: { noPool: false, poolCount: 0, tvl: null },
    });

    assert.equal(assessment.label, 'valid');
    assert.ok(assessment.reasonCodes.includes('volume_to_mcap_too_low'));
    assert.ok(assessment.reasonCodes.includes('liquidity_to_mcap_too_low'));
  });

  it('upgrades strong-flow mid caps back to valid when only volume-to-mcap looks weak', () => {
    const assessment = classifyTokenJunk({
      mcap: 869561,
      volume1h: 589.61,
      volume6h: 7284.34,
      volume24h: 37039.72,
      liquidityUsd: 190254.25,
      txns24hBuys: 339,
      txns24hSells: 167,
      priceChange24h: -27.97,
      meteora: { noPool: false, poolCount: 0, tvl: null },
    });

    assert.equal(assessment.label, 'valid');
    assert.ok(assessment.reasonCodes.includes('volume_to_mcap_too_low'));
  });

  it('upgrades high-activity dislocation tokens back to valid when market support is strong', () => {
    const assessment = classifyTokenJunk({
      mcap: 335365,
      volume1h: 1012.16,
      volume6h: 19442.54,
      volume24h: 305310.76,
      liquidityUsd: 19923.37,
      txns24hBuys: 2218,
      txns24hSells: 1700,
      priceChange24h: 1842,
      meteora: { noPool: false, poolCount: 0, tvl: null },
    });

    assert.equal(assessment.label, 'valid');
    assert.ok(assessment.reasonCodes.includes('price_dislocation_extreme'));
  });

  it('flags tokens with missing market data and no Meteora support for manual review', () => {
    const assessment = classifyTokenJunk({
      mcap: null,
      volume1h: null,
      volume6h: null,
      volume24h: null,
      meteora: { noPool: true, poolCount: 0, tvl: null },
    });

    assert.equal(assessment.label, 'valid_but_weak');
    assert.ok(assessment.reasonCodes.includes('market_data_unavailable'));
    assert.equal(assessment.manualReviewRequired, true);
  });

  it('marks healthy tokens as valid when no negative signals exist', () => {
    const assessment = classifyTokenJunk({
      mcap: 1800000,
      volume1h: 120000,
      volume6h: 600000,
      volume24h: 1900000,
      liquidityUsd: 240000,
      txns24hBuys: 480,
      txns24hSells: 430,
      holderCount: 900,
      top10Pct: 22,
      top20Pct: 31,
      meteora: { noPool: false, poolCount: 2, tvl: 85000 },
    });

    assert.equal(assessment.label, 'valid');
    assert.equal(assessment.manualReviewRequired, false);
    assert.ok(assessment.liquidityToMcapRatio > 0.13);
    assert.ok(assessment.liquidityToMcapRatio < 0.14);
  });

  it('returns null when there is not enough signal context', () => {
    assert.equal(classifyTokenJunk({ address: 'So11111111111111111111111111111111111111112' }), null);
  });
});
