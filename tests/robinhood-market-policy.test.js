const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  CANONICAL_CONTRACTS,
  ROBINHOOD_TOKENIZED_ASSETS,
  buildLiquidityAssessment,
  classifyTokenEligibility,
} = require('../src/services/robinhood-market-policy');

const MEME = '0x1111111111111111111111111111111111111111';

describe('Robinhood market policy', () => {
  it('excludes every configured canonical protocol contract by address', () => {
    for (const [label, address] of Object.entries(CANONICAL_CONTRACTS)) {
      const result = classifyTokenEligibility(address.toUpperCase());
      assert.equal(result.eligible, false, label);
      assert.equal(result.reason, 'canonical_contract', label);
      assert.equal(result.label, label);
    }
  });

  it('excludes all official Robinhood stocks and ETFs by address', () => {
    assert.equal(Object.keys(ROBINHOOD_TOKENIZED_ASSETS).length, 25);
    for (const [ticker, address] of Object.entries(ROBINHOOD_TOKENIZED_ASSETS)) {
      const result = classifyTokenEligibility(address);
      assert.equal(result.eligible, false, ticker);
      assert.equal(result.reason, 'robinhood_tokenized_asset', ticker);
      assert.equal(result.label, ticker);
    }
  });

  it('does not block a token merely because it could copy a stock ticker', () => {
    const result = classifyTokenEligibility(MEME);

    assert.equal(result.eligible, true);
    assert.equal(result.reason, null);
    assert.equal(result.label, null);
  });

  it('supports an explicit supplemental address denylist', () => {
    const result = classifyTokenEligibility(MEME, { extraDenied: { MANUAL: MEME } });

    assert.equal(result.eligible, false);
    assert.equal(result.reason, 'configured_denylist');
    assert.equal(result.label, 'MANUAL');
  });

  it('estimates v2 spot liquidity from twice the quote reserve', () => {
    const assessment = buildLiquidityAssessment({
      protocol: 'uniswap-v2',
      quoteReserveRaw: 25_000n * 10n ** 6n,
      quoteDecimals: 6,
      quoteUsdPrice: '1',
    });

    assert.equal(assessment.liquidityUsd, '50000');
    assert.deepEqual(assessment.exact, { numerator: '50000', denominator: '1' });
    assert.equal(assessment.status, 'spot_estimate_from_double_quote_reserve');
    assert.equal(assessment.confidence, 'medium');
    assert.equal(assessment.warning, 'spot_price_and_reserves_are_manipulable');
  });

  it('converts a WETH v2 reserve through its observed USD quote', () => {
    const assessment = buildLiquidityAssessment({
      protocol: 'uniswap-v2',
      quoteReserveRaw: 3n * 10n ** 18n,
      quoteDecimals: 18,
      quoteUsdPrice: '1800.50',
    });

    assert.equal(assessment.liquidityUsd, '10803');
    assert.equal(assessment.confidence, 'medium');
  });

  it('values v3 TVL from pool balances without treating scalar liquidity as USD', () => {
    const assessment = buildLiquidityAssessment({
      protocol: 'uniswap-v3', liquidityRaw: '999999999999999999',
      tokenBalanceRaw: 10n * 10n ** 18n, quoteBalanceRaw: 30_000n * 10n ** 6n,
      tokenDecimals: 18, quoteDecimals: 6, tokenUsdPrice: '2', quoteUsdPrice: '1',
    });

    assert.equal(assessment.liquidityUsd, '30020');
    assert.equal(assessment.status, 'spot_tvl_from_pool_balances');
    assert.equal(assessment.confidence, 'medium');
    assert.equal(assessment.liquidityRaw, '999999999999999999');
  });

  it('keeps concentrated liquidity unknown when pool balances are absent', () => {
    for (const protocol of ['uniswap-v3', 'uniswap-v4']) {
      const assessment = buildLiquidityAssessment({ protocol, liquidityRaw: '999999999999999999' });
      assert.equal(assessment.liquidityUsd, null, protocol);
      assert.equal(assessment.liquidityRaw, '999999999999999999', protocol);
      assert.equal(assessment.status, 'requires_tick_liquidity_distribution', protocol);
      assert.equal(assessment.confidence, 'none', protocol);
    }
  });

  it('reports unavailable inputs and unsupported protocols explicitly', () => {
    assert.equal(buildLiquidityAssessment({ protocol: 'uniswap-v2' }).status,
      'missing_v2_reserve_or_quote');
    assert.equal(buildLiquidityAssessment({ protocol: 'other' }).status, 'unsupported_protocol');
    assert.throws(() => buildLiquidityAssessment({
      protocol: 'uniswap-v2', quoteReserveRaw: '-1', quoteDecimals: 6, quoteUsdPrice: '1',
    }), /Invalid v2/);
  });
});
