const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  scoreOpenWalletPositionSnapshot,
} = require('../src/services/robinhood-wallet-ranking-snapshot-domain');

const AS_OF = '2026-09-27T12:00:00.000Z';
const IN_WINDOW = '2026-09-27T00:00:00.000Z';

function event(type, amountRaw, volumeUsd = null, time = IN_WINDOW) {
  return { type, time, amountRaw, volumeUsd };
}

function score(overrides = {}) {
  return scoreOpenWalletPositionSnapshot({
    window: '24h', asOf: AS_OF, tokenDecimals: 0,
    quantityRaw: '10', costBasisUsd: '10', quality: 'exact_swap_only',
    currentPriceUsd: '3', windowStartPriceUsd: '2',
    projectionAligned: true, eventsComplete: true, events: [],
    ...overrides,
  });
}

describe('Robinhood ranking from current position and in-window events', () => {
  it('counts an old bag in every window without loading its original buy', () => {
    for (const [window, startPrice, gain] of [
      ['24h', '2', '10'], ['7d', '1.5', '15'], ['30d', '1', '20'],
    ]) {
      const result = score({ window, windowStartPriceUsd: startPrice });
      assert.equal(result.gainUsd, gain);
      assert.equal(result.openQuantityRaw, '10');
      assert.equal(result.coverage, 'complete');
    }
  });

  it('starts new purchases at execution cost and scales old bags after sales', () => {
    assert.equal(score({
      quantityRaw: '15', events: [event('buy', '5', '12.5')],
    }).gainUsd, '12.5');
    assert.equal(score({
      quantityRaw: '10', events: [event('sell', '10')],
    }).gainUsd, '10');
    assert.equal(score({
      quantityRaw: '0', events: [event('sell', '10')],
    }).eligible, false);
  });

  it('keeps the inferred opening balance exact for an 18-decimal token', () => {
    const result = score({
      tokenDecimals: 18, quantityRaw: '1000000000000000000',
      windowStartPriceUsd: '0.00000002', currentPriceUsd: '0.00000003',
    });
    assert.equal(result.gainUsd, '0.00000001');
  });

  it('uses current projected cost for ALL and rejects unknown transfer cost', () => {
    const all = score({ window: 'ALL', windowStartPriceUsd: null });
    assert.equal(all.gainUsd, '20');
    assert.equal(all.coverage, 'complete');
    const unknown = score({ window: 'ALL', quality: 'transferred_assumed_zero' });
    assert.equal(unknown.gainUsd, null);
    assert.deepEqual(unknown.reasons, ['cost_basis_unavailable']);
  });

  it('allows a prior transfer for a window but flags one received inside it', () => {
    assert.equal(score({ quality: 'transferred_assumed_zero' }).gainUsd, '10');
    const received = score({ quantityRaw: '15', quality: 'transferred_assumed_zero',
      events: [event('transfer_in', '5')] });
    assert.equal(received.gainUsd, null);
    assert.equal(received.knownGainUsd, '10');
    assert.deepEqual(received.reasons, ['transfer_cost_unknown']);
  });

  it('fails closed on missing source coverage and inconsistent event sequence', () => {
    for (const [overrides, reason] of [
      [{ eventsComplete: false }, 'window_events_incomplete'],
      [{ projectionAligned: false }, 'projection_unaligned'],
      [{ quality: 'partial_history' }, 'position_quality_unreliable'],
    ]) {
      const result = score(overrides);
      assert.equal(result.gainUsd, null);
      assert.equal(result.knownGainUsd, null);
      assert.equal(result.coverage, 'partial');
      assert.ok(result.reasons.includes(reason));
    }
    const mismatch = score({ quantityRaw: '1', events: [
      event('sell', '10', null, '2026-09-26T13:00:00.000Z'),
      event('buy', '5', '5'),
    ] });
    assert.equal(mismatch.gainUsd, null);
    assert.ok(mismatch.reasons.includes('snapshot_event_mismatch'));
  });

  it('requires events to stay inside the selected window', () => {
    assert.throws(() => score({ events: [
      event('buy', '1', '1', '2026-09-26T11:59:59.000Z'),
    ] }), /outside the ranking window/);
  });
});
