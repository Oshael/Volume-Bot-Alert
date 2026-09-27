const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { scoreOpenWalletPosition } = require('../src/services/robinhood-wallet-ranking-domain');

const AS_OF = '2026-09-27T12:00:00.000Z';
const START = '2026-09-26T12:00:00.000Z';
const OLD = '2026-08-01T12:00:00.000Z';
const NEW = '2026-09-27T00:00:00.000Z';

function event(type, time, amountRaw, volumeUsd = null) {
  return { type, time, amountRaw, volumeUsd };
}

function score(overrides = {}) {
  return scoreOpenWalletPosition({
    asOf: AS_OF, windowStart: START,
    tokenDecimals: 0, currentPriceUsd: '3', windowStartPriceUsd: '2',
    historyComplete: true, events: [], ...overrides,
  });
}

describe('Robinhood wallet ranking window gain', () => {
  it('includes an old bag in 24h, 7d and 30d when its price rises', () => {
    for (const [windowStart, windowStartPriceUsd, expected] of [
      [START, '2', '10'],
      ['2026-09-20T12:00:00.000Z', '1.5', '15'],
      ['2026-08-28T12:00:00.000Z', '1', '20'],
    ]) {
      const result = score({
        windowStart, windowStartPriceUsd, events: [event('buy', OLD, '10', '10')],
      });
      assert.equal(result.eligible, true);
      assert.equal(result.gainUsd, expected);
      assert.equal(result.openQuantityRaw, '10');
      assert.equal(result.coverage, 'complete');
    }
  });

  it('starts a new purchase at its executed cost, not the earlier window price', () => {
    const result = score({ events: [
      event('buy', OLD, '10', '10'),
      event('buy', NEW, '5', '12.5'),
    ] });
    assert.equal(result.gainUsd, '12.5');
  });

  it('allocates a partial sale proportionally, matching the position cost policy', () => {
    const events = [
      event('buy', OLD, '10', '10'),
      event('buy', NEW, '10', '25'),
      event('sell', NEW, '10'),
    ];
    assert.equal(score({ events }).gainUsd, '7.5');
    assert.equal(score({ events, windowStart: null }).gainUsd, '12.5');
  });

  it('removes a fully sold position from the ranking, including ALL', () => {
    const events = [event('buy', OLD, '10', '10'), event('sell', NEW, '10')];
    for (const windowStart of [START, null]) {
      const result = score({ events, windowStart });
      assert.equal(result.eligible, false);
      assert.equal(result.gainUsd, null);
      assert.equal(result.openQuantityRaw, '0');
    }
  });

  it('starts a reopened position from the new purchase only', () => {
    const result = score({ events: [
      event('buy', OLD, '10', '10'),
      event('sell', NEW, '10'),
      event('buy', NEW, '5', '12.5'),
    ] });
    assert.equal(result.openQuantityRaw, '5');
    assert.equal(result.gainUsd, '2.5');
  });

  it('reduces gain proportionally when inventory leaves by transfer', () => {
    const result = score({ events: [
      event('buy', OLD, '10', '10'),
      event('transfer_out', NEW, '5'),
    ] });
    assert.equal(result.gainUsd, '5');
    assert.equal(result.coverage, 'complete');
  });

  it('keeps losses negative instead of hiding them', () => {
    const result = score({
      currentPriceUsd: '1',
      events: [event('buy', OLD, '10', '10')],
    });
    assert.equal(result.gainUsd, '-10');
  });

  it('keeps token decimals and USD math exact for small bags', () => {
    const result = score({
      tokenDecimals: 18,
      currentPriceUsd: '0.00000003',
      windowStartPriceUsd: '0.00000002',
      events: [event('buy', OLD, '1000000000000000000', '0.00000001')],
    });
    assert.equal(result.gainUsd, '0.00000001');
  });

  it('does not rank unknown transfer cost as a free purchase', () => {
    const result = score({ events: [
      event('buy', OLD, '10', '10'),
      event('transfer_in', NEW, '5'),
    ] });
    assert.equal(result.gainUsd, null);
    assert.equal(result.knownGainUsd, '10');
    assert.equal(result.coverage, 'partial');
    assert.deepEqual(result.reasons, ['transfer_cost_unknown']);
  });

  it('marks missing baseline, current price and history as partial', () => {
    const events = [event('buy', OLD, '10', '10')];
    const missingBaseline = score({ events, windowStartPriceUsd: null });
    assert.equal(missingBaseline.gainUsd, null);
    assert.deepEqual(missingBaseline.reasons, ['basis_unavailable']);

    const missingCurrent = score({ events, currentPriceUsd: null });
    assert.equal(missingCurrent.gainUsd, null);
    assert.equal(missingCurrent.knownGainUsd, null);
    assert.deepEqual(missingCurrent.reasons, ['current_price_unavailable']);

    const partialHistory = score({ events, historyComplete: false });
    assert.equal(partialHistory.gainUsd, null);
    assert.equal(partialHistory.knownGainUsd, '10');
    assert.deepEqual(partialHistory.reasons, ['incomplete_history']);
  });

  it('flags unmatched outflows and rejects events outside canonical order', () => {
    const result = score({ events: [
      event('buy', OLD, '5', '5'),
      event('sell', NEW, '6'),
    ] });
    assert.equal(result.eligible, false);
    assert.deepEqual(result.reasons, ['unmatched_outflow']);
    assert.throws(() => score({ events: [
      event('buy', NEW, '1', '1'), event('buy', OLD, '1', '1'),
    ] }), /canonical chronological order/);
  });
});
