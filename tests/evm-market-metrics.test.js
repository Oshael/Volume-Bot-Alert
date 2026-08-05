const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  ROBINHOOD_USDG,
  ROBINHOOD_WETH,
  buildMarketObservation,
  formatDecimal,
  parseDecimal,
  rational,
} = require('../src/services/evm-market-metrics');

const TOKEN = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const ELIGIBLE = Object.freeze({ eligible: true });

function metadata(address, decimals, totalSupplyRaw) {
  return {
    address,
    name: 'Token',
    symbol: 'TKN',
    decimals,
    totalSupplyRaw: String(totalSupplyRaw),
    usable: true,
  };
}

function swap(overrides = {}) {
  return {
    accepted: true,
    chain: 'robinhood',
    protocol: 'uniswap-v3',
    blockNumber: '100',
    transactionHash: `0x${'aa'.repeat(32)}`,
    logIndex: '2',
    marketKey: 'robinhood:uniswap-v3:pool',
    poolAddress: '0x3333333333333333333333333333333333333333',
    tokenAddress: TOKEN,
    quoteAddress: ROBINHOOD_USDG,
    side: 'buy',
    tokenAmountRaw: (2n * 10n ** 18n).toString(),
    quoteAmountRaw: (5n * 10n ** 6n).toString(),
    ...overrides,
  };
}

describe('EVM market metrics', () => {
  it('builds exact USDG execution price, volume and FDV without Number conversion', () => {
    const observation = buildMarketObservation({
      swap: swap(),
      tokenMetadata: metadata(TOKEN, 18, 1_000_000_000n * 10n ** 18n),
      quoteMetadata: metadata(ROBINHOOD_USDG, 6, 1n),
      eligibility: ELIGIBLE,
    });

    assert.equal(observation.accepted, true);
    assert.equal(observation.tokenAmount, '2');
    assert.equal(observation.tokenDecimals, 18);
    assert.equal(observation.quoteDecimals, 6);
    assert.equal(observation.tokenTotalSupplyRaw, (1_000_000_000n * 10n ** 18n).toString());
    assert.equal(observation.quoteAmount, '5');
    assert.equal(observation.priceQuote, '2.5');
    assert.equal(observation.priceUsd, '2.5');
    assert.equal(observation.volumeUsd, '5');
    assert.equal(observation.fdvUsd, '2500000000');
    assert.equal(observation.marketCapUsd, null);
    assert.equal(observation.valuationType, 'fdv');
    assert.equal(observation.quoteUsdStatus, 'assumed');
    assert.equal(observation.quoteUsdSource, 'usdg-peg-assumption');
    assert.deepEqual(observation.exact.priceUsd, { numerator: '5', denominator: '2' });
  });

  it('uses the post-swap spot price for V3/V4 valuation while preserving executed volume', () => {
    for (const protocol of ['uniswap-v3', 'uniswap-v4']) {
      const observation = buildMarketObservation({
        swap: swap({
          protocol,
          priceQuotePerTokenRaw: {
            numerator: '3',
            denominator: (10n ** 12n).toString(),
          },
        }),
        tokenMetadata: metadata(TOKEN, 18, 1_000_000_000n * 10n ** 18n),
        quoteMetadata: metadata(ROBINHOOD_USDG, 6, 1n),
        eligibility: ELIGIBLE,
      });

      assert.equal(observation.priceQuote, '3');
      assert.equal(observation.priceUsd, '3');
      assert.equal(observation.fdvUsd, '3000000000');
      assert.equal(observation.volumeUsd, '5');
      assert.deepEqual(observation.exact.priceQuote, { numerator: '3', denominator: '1' });
    }
  });

  it('converts WETH quotes through an observed canonical WETH/USD snapshot', () => {
    const observation = buildMarketObservation({
      swap: swap({
        quoteAddress: ROBINHOOD_WETH,
        tokenAmountRaw: (1000n * 10n ** 18n).toString(),
        quoteAmountRaw: (1n * 10n ** 18n).toString(),
      }),
      tokenMetadata: metadata(TOKEN, 18, 1_000_000n * 10n ** 18n),
      quoteMetadata: metadata(ROBINHOOD_WETH, 18, 1n),
      wethUsdPrice: '2000.25',
      wethUsdSource: 'canonical-v3-weth-usdg',
      eligibility: ELIGIBLE,
    });

    assert.equal(observation.priceQuote, '0.001');
    assert.equal(observation.priceUsd, '2.00025');
    assert.equal(observation.volumeUsd, '2000.25');
    assert.equal(observation.fdvUsd, '2000250');
    assert.equal(observation.quoteUsdPrice, '2000.25');
    assert.equal(observation.quoteUsdStatus, 'observed');
    assert.equal(observation.quoteUsdSource, 'canonical-v3-weth-usdg');
  });

  it('keeps integers above Number.MAX_SAFE_INTEGER exact', () => {
    // The huge value rides on volume (unguarded) rather than FDV, whose supply
    // is now bounded by the human ceiling: this still proves the rational
    // pipeline never truncates a >2^53 integer through Number.
    const bigQuote = (2n ** 200n) + 123n;
    const observation = buildMarketObservation({
      swap: swap({ tokenAmountRaw: '3', quoteAmountRaw: bigQuote.toString() }),
      tokenMetadata: metadata(TOKEN, 0, 1_000n),
      quoteMetadata: metadata(ROBINHOOD_USDG, 0, 1n),
      eligibility: ELIGIBLE,
    });

    assert.equal(observation.exact.priceUsd.numerator, bigQuote.toString());
    assert.equal(observation.exact.priceUsd.denominator, '3');
    assert.equal(observation.exact.volumeUsd.numerator, bigQuote.toString());
    assert.equal(observation.exact.volumeUsd.denominator, '1');
  });

  it('suppresses FDV for an uncapped (uint256-max) totalSupply, keeping price and volume', () => {
    const observation = buildMarketObservation({
      swap: swap(),
      tokenMetadata: metadata(TOKEN, 18, (2n ** 256n) - 1n),
      quoteMetadata: metadata(ROBINHOOD_USDG, 6, 1n),
      eligibility: ELIGIBLE,
    });

    assert.equal(observation.accepted, true);
    assert.equal(observation.priceUsd, '2.5');
    assert.equal(observation.volumeUsd, '5');
    assert.equal(observation.fdvUsd, null);
    assert.equal(observation.exact.fdvUsd, null);
  });

  it('applies the 1e15 whole-token supply ceiling to FDV (keep <=, suppress >)', () => {
    const scale = 10n ** 18n;
    const cases = [
      { humanSupply: 10n ** 15n, fdvNull: false },       // SHIB-scale boundary: kept
      { humanSupply: 10n ** 15n + 1n, fdvNull: true },   // one whole token over: suppressed
    ];
    for (const { humanSupply, fdvNull } of cases) {
      const observation = buildMarketObservation({
        swap: swap(),
        tokenMetadata: metadata(TOKEN, 18, humanSupply * scale),
        quoteMetadata: metadata(ROBINHOOD_USDG, 6, 1n),
        eligibility: ELIGIBLE,
      });
      assert.equal(observation.accepted, true);
      assert.equal(observation.priceUsd, '2.5');
      assert.equal(observation.volumeUsd, '5');
      assert.equal(observation.fdvUsd === null, fdvNull);
    }
  });

  it('preserves sub-1e-30 prices instead of rounding them to a fatal zero', () => {
    const observation = buildMarketObservation({
      swap: swap({
        tokenAmountRaw: (10n ** 43n).toString(),
        quoteAmountRaw: '1',
      }),
      tokenMetadata: metadata(TOKEN, 18, 10n ** 50n),
      quoteMetadata: metadata(ROBINHOOD_USDG, 6, 1n),
      eligibility: ELIGIBLE,
    });

    assert.equal(observation.accepted, true);
    assert.equal(observation.priceQuote, `0.${'0'.repeat(30)}1`);
    assert.equal(observation.priceUsd, `0.${'0'.repeat(30)}1`);
  });

  it('rejects a positive price when an explicit persistence precision would round it to zero', () => {
    const observation = buildMarketObservation({
      swap: swap({
        tokenAmountRaw: (10n ** 43n).toString(),
        quoteAmountRaw: '1',
      }),
      tokenMetadata: metadata(TOKEN, 18, 10n ** 50n),
      quoteMetadata: metadata(ROBINHOOD_USDG, 6, 1n),
      eligibility: ELIGIBLE,
      priceDecimalPlaces: 30,
    });

    assert.equal(observation.accepted, false);
    assert.equal(observation.reason, 'price_below_persisted_precision');
  });

  it('rejects WETH swaps without a canonical USD quote', () => {
    const observation = buildMarketObservation({
      swap: swap({ quoteAddress: ROBINHOOD_WETH }),
      tokenMetadata: metadata(TOKEN, 18, 1n),
      quoteMetadata: metadata(ROBINHOOD_WETH, 18, 1n),
      eligibility: ELIGIBLE,
    });

    assert.equal(observation.accepted, false);
    assert.equal(observation.reason, 'quote_usd_unavailable');
  });

  it('rejects unusable or mismatched metadata before doing arithmetic', () => {
    const base = {
      swap: swap(),
      tokenMetadata: metadata(TOKEN, 18, 1n),
      quoteMetadata: metadata(ROBINHOOD_USDG, 6, 1n),
      eligibility: ELIGIBLE,
    };

    assert.equal(buildMarketObservation({ ...base, tokenMetadata: { usable: false } }).reason,
      'token_metadata_unusable');
    assert.equal(buildMarketObservation({ ...base, quoteMetadata: { usable: false } }).reason,
      'quote_metadata_unusable');
    assert.equal(buildMarketObservation({ ...base, tokenMetadata: metadata(OTHER, 18, 1n) }).reason,
      'token_metadata_mismatch');
    assert.equal(buildMarketObservation({ ...base, quoteMetadata: metadata(OTHER, 6, 1n) }).reason,
      'quote_metadata_mismatch');
  });

  it('rejects rejected swaps and zero raw amounts', () => {
    const base = {
      tokenMetadata: metadata(TOKEN, 18, 1n),
      quoteMetadata: metadata(ROBINHOOD_USDG, 6, 1n),
      eligibility: ELIGIBLE,
    };

    assert.equal(buildMarketObservation({ ...base, swap: swap({ accepted: false }) }).reason,
      'swap_not_accepted');
    assert.equal(buildMarketObservation({ ...base, swap: swap({ tokenAmountRaw: '0' }) }).reason,
      'non_positive_swap_amount');
    assert.equal(buildMarketObservation({ ...base, swap: swap({ quoteAmountRaw: '0' }) }).reason,
      'non_positive_swap_amount');
  });

  it('rejects V2 execution prices after the token reserve is depleted below one token', () => {
    const observation = buildMarketObservation({
      swap: swap({
        protocol: 'uniswap-v2',
        tokenReserveRaw: '1',
        quoteReserveRaw: (10n ** 12n).toString(),
      }),
      tokenMetadata: metadata(TOKEN, 18, 1_000_000n * 10n ** 18n),
      quoteMetadata: metadata(ROBINHOOD_USDG, 6, 1n),
      eligibility: ELIGIBLE,
    });

    assert.equal(observation.accepted, false);
    assert.equal(observation.reason, 'v2_token_reserve_depleted');
  });

  it('requires an explicit eligibility gate and rejects denied tokens', () => {
    const base = {
      swap: swap(),
      tokenMetadata: metadata(TOKEN, 18, 1n),
      quoteMetadata: metadata(ROBINHOOD_USDG, 6, 1n),
    };

    assert.equal(buildMarketObservation(base).reason, 'eligibility_not_checked');
    assert.equal(buildMarketObservation({ ...base, eligibility: { eligible: false } }).reason,
      'token_ineligible');
  });

  it('parses and formats decimal rationals with deterministic rounding', () => {
    assert.deepEqual(parseDecimal('12.3400'), { numerator: 617n, denominator: 50n });
    assert.equal(formatDecimal(rational(1n, 3n), 6), '0.333333');
    assert.equal(formatDecimal(rational(2n, 3n), 6), '0.666667');
    assert.equal(formatDecimal(rational(-5n, 2n), 3), '-2.5');
    assert.throws(() => parseDecimal('1e6'), /base-10 decimal/);
    assert.throws(() => rational(1n, 0n), /cannot be zero/);
  });
});
