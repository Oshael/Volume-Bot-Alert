const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const onchainEvent = require('../src/services/quicknode-onchain-event');
const priceObservation = require('../src/services/quicknode-onchain-price-observation');

const TOKEN_MINT = 'PriceToken1111111111111111111111111111111111';

function candidate(overrides = {}) {
  return {
    accepted: true,
    program: 'pumpswap',
    signature: 'price-signature',
    slot: 430662183,
    blockTime: 1783137600,
    tokenMint: TOKEN_MINT,
    tokenDelta: 20_000,
    wsolDelta: -0.4,
    stableMint: null,
    stableDelta: null,
    uniqueNonQuoteMintCount: 1,
    ...overrides,
  };
}

describe('quicknode onchain price observation', () => {
  it('calculates SOL execution prices for every monitored DEX program', () => {
    const programs = [
      'pumpswap',
      'meteora-dlmm',
      'raydium-cpmm',
      'raydium-clmm',
      'raydium-amm-v4',
    ];

    for (const program of programs) {
      const observation = priceObservation.buildPriceObservation(candidate({ program }));

      assert.equal(observation.accepted, true, program);
      assert.equal(observation.price, 0.00002, program);
      assert.equal(observation.quoteMint, onchainEvent.WSOL_MINT, program);
      assert.equal(observation.quoteUnit, 'SOL', program);
      assert.equal(observation.observedAtMs, 1783137600000, program);
    }
  });

  it('calculates USD execution price from USDC and USDT swaps', () => {
    for (const stableMint of [onchainEvent.USDC_MINT, onchainEvent.USDT_MINT]) {
      const observation = priceObservation.buildPriceObservation(candidate({
        wsolDelta: null,
        stableMint,
        stableDelta: -250,
        tokenDelta: 10_000,
      }));

      assert.equal(observation.accepted, true);
      assert.equal(observation.price, 0.025);
      assert.equal(observation.quoteMint, stableMint);
      assert.equal(observation.quoteUnit, 'USD');
    }
  });

  it('prefers the final stablecoin amount over an intermediate WSOL residual', () => {
    const observation = priceObservation.buildPriceObservation(candidate({
      tokenDelta: -1,
      wsolDelta: -0.000662175,
      stableMint: onchainEvent.USDC_MINT,
      stableDelta: 2841.357397,
    }));

    assert.equal(observation.price, 2841.357397);
    assert.equal(observation.quoteUnit, 'USD');
    assert.equal(observation.quoteMint, onchainEvent.USDC_MINT);
  });

  it('rejects routed transactions with multiple non-quote mints', () => {
    const observation = priceObservation.buildPriceObservation(candidate({
      uniqueNonQuoteMintCount: 2,
    }));

    assert.equal(observation.accepted, false);
    assert.equal(observation.skipReason, 'ambiguous_non_quote_mints');
  });

  it('uses receipt time when the RPC notification has no blockTime', () => {
    const observation = priceObservation.buildPriceObservation(candidate({
      blockTime: null,
      observedAtMs: 1783137600123,
    }));

    assert.equal(observation.observedAtMs, 1783137600123);
  });

  it('rejects swaps without token or quote amounts', () => {
    assert.equal(priceObservation.buildPriceObservation(candidate({ tokenDelta: null })).skipReason, 'missing_token_amount');
    assert.equal(priceObservation.buildPriceObservation(candidate({ wsolDelta: null })).skipReason, 'missing_quote_amount');
  });

  it('does not translate rejected swaps or unsupported programs', () => {
    assert.equal(priceObservation.buildPriceObservation(candidate({ accepted: false })).skipReason, 'swap_not_accepted');
    assert.equal(priceObservation.buildPriceObservation(candidate({ program: 'orca' })).skipReason, 'unsupported_program');
  });
});
