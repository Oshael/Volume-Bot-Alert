const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const selector = require('../src/services/token-risk-candidate-selector');

function buildRow(overrides = {}) {
  return {
    address: 'So11111111111111111111111111111111111111112',
    monitor_priority: 'high',
    last_mcap: 120000,
    last_vol_24h: 45000,
    last_liquidity_usd: null,
    last_txns_24h_buys: null,
    last_txns_24h_sells: null,
    last_price_change_6h: 12,
    last_price_change_24h: 18,
    last_token_created_at_ms: Date.UTC(2026, 3, 8, 18, 0, 0),
    last_enriched_at: null,
    last_attempted_at: null,
    last_error: null,
    suppressed_reason: null,
    ...overrides,
  };
}

describe('token risk candidate selector', () => {
  it('selects relevant tokens with no structural enrichment yet', () => {
    const candidates = selector.selectCandidates([
      buildRow(),
    ], {
      nowMs: Date.UTC(2026, 3, 8, 21, 0, 0),
    });

    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].address, 'So11111111111111111111111111111111111111112');
    assert.match(candidates[0].reasonCodes.join(','), /missing_structural_enrichment/);
  });

  it('skips manually legit tokens even when they look relevant', () => {
    const candidates = selector.selectCandidates([
      buildRow({
        risk_review_label: 'valid',
      }),
    ], {
      nowMs: Date.UTC(2026, 3, 8, 21, 0, 0),
    });

    assert.equal(candidates.length, 0);
  });

  it('skips recently enriched tokens with fresh cache', () => {
    const candidates = selector.selectCandidates([
      buildRow({
        last_enriched_at: '2026-04-08T20:30:00.000Z',
      }),
    ], {
      nowMs: Date.UTC(2026, 3, 8, 21, 0, 0),
      freshEnrichmentTtlMs: 2 * 60 * 60 * 1000,
    });

    assert.equal(candidates.length, 0);
  });

  it('retries errored enrichment after backoff', () => {
    const candidates = selector.selectCandidates([
      buildRow({
        last_enriched_at: null,
        last_attempted_at: '2026-04-08T17:00:00.000Z',
        last_error: 'HTTP 429',
      }),
    ], {
      nowMs: Date.UTC(2026, 3, 8, 21, 0, 0),
      errorBackoffMs: 60 * 60 * 1000,
    });

    assert.equal(candidates.length, 1);
    assert.match(candidates[0].reasonCodes.join(','), /retry_after_enrichment_error/);
  });

  it('skips low-relevance tokens without priority or market significance', () => {
    const candidates = selector.selectCandidates([
      buildRow({
        monitor_priority: 'dormant',
        last_mcap: 8000,
        last_vol_24h: 900,
        last_enriched_at: null,
      }),
    ], {
      nowMs: Date.UTC(2026, 3, 8, 21, 0, 0),
    });

    assert.equal(candidates.length, 0);
  });

  it('prefers suspicious tokens with stale enrichment over calmer ones', () => {
    const candidates = selector.selectCandidates([
      buildRow({
        address: 'So11111111111111111111111111111111111111112',
        last_enriched_at: '2026-03-01T12:00:00.000Z',
        last_price_change_24h: 95,
      }),
      buildRow({
        address: '34q2KmCvapecJgR6ZrtbCTrzZVtkt3a5mHEA3TuEsWYb',
        monitor_priority: 'normal',
        last_enriched_at: '2026-03-01T12:00:00.000Z',
        last_price_change_24h: 12,
      }),
    ], {
      nowMs: Date.UTC(2026, 3, 8, 21, 0, 0),
      staleEnrichmentMs: 3 * 24 * 60 * 60 * 1000,
      resultLimit: 5,
    });

    assert.equal(candidates.length, 2);
    assert.equal(candidates[0].address, 'So11111111111111111111111111111111111111112');
    assert.match(candidates[0].reasonCodes.join(','), /large_price_change_24h/);
    assert.match(candidates[0].reasonCodes.join(','), /stale_structural_enrichment/);
  });

  it('selects tokens with low liquidity and strong buy/sell imbalance for Helius enrichment', () => {
    const candidates = selector.selectCandidates([
      buildRow({
        last_mcap: 420000,
        last_vol_24h: 110000,
        last_liquidity_usd: 14000,
        last_txns_24h_buys: 126,
        last_txns_24h_sells: 30,
      }),
    ], {
      nowMs: Date.UTC(2026, 3, 8, 21, 0, 0),
    });

    assert.equal(candidates.length, 1);
    assert.match(candidates[0].reasonCodes.join(','), /low_liquidity_to_mcap/);
    assert.match(candidates[0].reasonCodes.join(','), /buy_sell_imbalance_high/);
  });
});
