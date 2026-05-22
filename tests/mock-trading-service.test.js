const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const mockTradingService = require('../src/services/mock-trading-service');

const {
  buildBuyState,
  buildSellState,
  mapTrade,
  normalizeAddCashUsdInput,
  mapCatalogPrice,
  normalizeMockSolUsdcRate,
  normalizeNotionalUsdInput,
  normalizeTakeProfitInput,
  resolveMockSolUsdQuote,
  normalizeSellQuantity,
} = mockTradingService.__private;

function account(overrides = {}) {
  return {
    userId: 1,
    startingCashUsd: mockTradingService.DEFAULT_STARTING_CASH_USD,
    cashUsd: mockTradingService.DEFAULT_STARTING_CASH_USD,
    realizedPnlUsd: 0,
    ...overrides,
  };
}

describe('mock trading service calculations', () => {
  it('builds a first buy position from priceUsd and market cap snapshot', () => {
    const result = buildBuyState({
      account: account(),
      priceUsd: 0.001,
      marketCapUsd: 100000,
      notionalUsd: 100,
    });

    assert.equal(result.account.cashUsd, 900);
    assert.equal(result.position.quantity, 100000);
    assert.equal(result.position.avgEntryPriceUsd, 0.001);
    assert.equal(result.position.avgEntryMcapUsd, 100000);
    assert.equal(result.position.costBasisUsd, 100);
    assert.equal(result.trade.realizedPnlUsd, 0);
    assert.equal(result.trade.priceReturnPct, null);
  });

  it('updates weighted average entry price and market cap on repeated buys', () => {
    const result = buildBuyState({
      account: account({ cashUsd: 900 }),
      position: {
        quantity: 100000,
        avgEntryPriceUsd: 0.001,
        avgEntryMcapUsd: 100000,
        costBasisUsd: 100,
        realizedPnlUsd: 0,
      },
      priceUsd: 0.002,
      marketCapUsd: 200000,
      notionalUsd: 100,
    });

    assert.equal(result.account.cashUsd, 800);
    assert.equal(result.position.quantity, 150000);
    assert(Math.abs(result.position.avgEntryPriceUsd - 0.0013333333333333333) < 1e-15);
    assert.equal(result.position.avgEntryMcapUsd, 150000);
    assert.equal(result.position.costBasisUsd, 200);
    assert.equal(result.trade.priceMultiple, 2);
    assert.equal(result.trade.priceReturnPct, 100);
    assert.equal(result.trade.mcapMultiple, 2);
  });

  it('calculates partial sell PnL, return percentage, and remaining position', () => {
    const result = buildSellState({
      account: account({ cashUsd: 900 }),
      position: {
        quantity: 1000000,
        avgEntryPriceUsd: 0.0001,
        avgEntryMcapUsd: 100000,
        costBasisUsd: 100,
        realizedPnlUsd: 0,
      },
      priceUsd: 0.0002,
      marketCapUsd: 200000,
      quantity: 500000,
    });

    assert.equal(result.account.cashUsd, 1000);
    assert.equal(result.account.realizedPnlUsd, 50);
    assert.equal(result.position.quantity, 500000);
    assert.equal(result.position.costBasisUsd, 50);
    assert.equal(result.position.avgEntryPriceUsd, 0.0001);
    assert.equal(result.trade.notionalUsd, 100);
    assert.equal(result.trade.realizedPnlUsd, 50);
    assert.equal(result.trade.realizedPnlPct, 100);
    assert.equal(result.trade.priceReturnPct, 100);
    assert.equal(result.trade.priceMultiple, 2);
    assert.equal(result.trade.mcapMultiple, 2);
  });

  it('closes the position on full sell', () => {
    const result = buildSellState({
      account: account({ cashUsd: 0 }),
      position: {
        quantity: 1000,
        avgEntryPriceUsd: 1,
        avgEntryMcapUsd: 100000,
        costBasisUsd: 1000,
        realizedPnlUsd: 0,
      },
      priceUsd: 0.75,
      marketCapUsd: 75000,
      quantity: 1000,
    });

    assert.equal(result.position, null);
    assert.equal(result.account.cashUsd, 750);
    assert.equal(result.account.realizedPnlUsd, -250);
    assert.equal(result.trade.realizedPnlPct, -25);
    assert.equal(result.trade.priceReturnPct, -25);
  });

  it('rejects stale catalog prices', () => {
    assert.throws(
      () => mapCatalogPrice(
        {
          last_price: '0.001',
          last_mcap: '100000',
          last_seen_at: '2026-04-30T12:00:00.000Z',
          last_evaluated_at: '2026-04-30T12:00:00.000Z',
        },
        new Date('2026-04-30T12:06:00.000Z'),
        5 * 60 * 1000
      ),
      /Token price is stale/
    );
  });

  it('allows stale catalog prices when explicitly requested for manual trades', () => {
    const catalog = mapCatalogPrice(
      {
        last_price: '0.001',
        last_mcap: '250000',
        last_seen_at: '2026-04-30T12:00:00.000Z',
        last_evaluated_at: '2026-04-30T12:00:00.000Z',
      },
      new Date('2026-04-30T12:06:00.000Z'),
      5 * 60 * 1000,
      { allowStalePrice: true }
    );

    assert.equal(catalog.priceUsd, 0.001);
    assert.equal(catalog.marketCapUsd, 250000);
    assert.equal(catalog.priceStale, true);
    assert.equal(catalog.stalePriceAllowed, true);
  });

  it('normalizes percent-based sell quantity and rejects missing positions', () => {
    assert.equal(
      normalizeSellQuantity({ quantity: 2000 }, { percent: 25 }),
      500
    );

    assert.throws(
      () => normalizeSellQuantity(null, { percent: 25 }),
      /No open mock trading position/
    );
  });

  it('normalizes take profit input above current market cap', () => {
    assert.deepEqual(
      normalizeTakeProfitInput(
        { takeProfitMcapUsd: 200000, takeProfitSellPercent: 50 },
        { marketCapUsd: 100000 }
      ),
      { targetMcapUsd: 200000, sellPercent: 50 }
    );

    assert.equal(
      normalizeTakeProfitInput({}, { marketCapUsd: 100000 }),
      null
    );

    assert.throws(
      () => normalizeTakeProfitInput({ takeProfitMcapUsd: 90000 }, { marketCapUsd: 100000 }),
      /takeProfitMcapUsd must be above the current market cap/
    );
  });

  it('maps mock SOL rate snapshots from trade metadata', () => {
    const mapped = mapTrade({
      id: 1,
      user_id: 2,
      token_address: 'So11111111111111111111111111111111111111112',
      side: 'buy',
      quantity: '1',
      price_usd: '2',
      market_cap_usd: '100000',
      notional_usd: '123.45',
      realized_pnl_usd: '0',
      metadata: { mockSolUsdcRate: 123.45 },
    });

    assert.equal(mapped.mockSolUsdcRate, 123.45);
    assert.equal(normalizeMockSolUsdcRate(null), 88);
  });

  it('converts SOL-denominated mock trading inputs to internal USD amounts', () => {
    const quote = { priceUsd: 200 };

    assert.equal(normalizeNotionalUsdInput({ notionalSol: 1.25 }, quote), 250);
    assert.equal(normalizeAddCashUsdInput({ amountSol: 0.5 }, quote), 100);
    assert.equal(normalizeNotionalUsdInput({ notionalUsd: 75 }, quote), 75);
  });

  it('uses a recent stale SOL/USD quote for mock trading conversions', () => {
    const quote = resolveMockSolUsdQuote({
      solUsdPriceService: {
        getFreshQuote() {
          throw new Error('Fresh SOL/USD price is unavailable');
        },
        getStatus() {
          return {
            provider: 'coinmarketcap',
            priceUsd: 150,
            lastUpdatedAt: '2026-05-13T00:00:00.000Z',
            ageSeconds: 20 * 60,
            stale: true,
          };
        },
      },
      mockSolUsdMaxStaleMs: mockTradingService.DEFAULT_MOCK_SOL_USD_MAX_STALE_MS,
    });

    assert.equal(quote.priceUsd, 150);
    assert.equal(quote.stale, true);
    assert.equal(normalizeNotionalUsdInput({ notionalSol: 2 }, quote), 300);
  });

  it('rejects SOL/USD quotes beyond the mock trading stale fallback window', () => {
    assert.throws(
      () => resolveMockSolUsdQuote({
        solUsdPriceService: {
          getFreshQuote() {
            throw new Error('Fresh SOL/USD price is unavailable');
          },
          getStatus() {
            return {
              provider: 'coinmarketcap',
              priceUsd: 150,
              ageSeconds: 2 * 60 * 60,
              stale: true,
            };
          },
        },
        mockSolUsdMaxStaleMs: mockTradingService.DEFAULT_MOCK_SOL_USD_MAX_STALE_MS,
      }),
      /Fresh SOL\/USD price is unavailable/
    );
  });
});
