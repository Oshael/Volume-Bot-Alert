const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  applyWalletPositionEvent,
  createWalletPosition,
  deriveWalletPositionMetrics,
} = require('../src/services/robinhood-wallet-position-domain');

function applyEvents(events, initial = {}) {
  return events.reduce((position, event) => applyWalletPositionEvent(position, event), initial);
}

describe('Robinhood wallet position domain', () => {
  it('starts with an exact empty position', () => {
    assert.deepEqual(createWalletPosition(), {
      quantityRaw: '0', costBasisUsd: '0', realizedPnlUsd: '0', buyVolumeUsd: '0',
      sellProceedsUsd: '0', buyMcapWeightedSum: '0', buyMcapWeightUsd: '0',
      sellMcapWeightedSum: '0', sellMcapWeightUsd: '0', buyTxCount: 0,
      sellTxCount: 0, zeroCostReceivedRaw: '0', zeroCostSoldRaw: '0',
      costBasisSource: 'swap_only', quality: 'exact_swap_only',
    });
  });

  it('maintains exact cost and volume-weighted buy market cap', () => {
    const position = applyEvents([
      { type: 'buy', amountRaw: '10', volumeUsd: '100', marketCapUsd: '1000' },
      { type: 'buy', amountRaw: '20', volumeUsd: '300', marketCapUsd: '2000' },
      {
        type: 'buy', amountRaw: '1', volumeUsd: '0', marketCapUsd: null,
        newSideTransaction: false,
      },
    ]);
    const metrics = deriveWalletPositionMetrics(position);

    assert.equal(position.quantityRaw, '31');
    assert.equal(position.costBasisUsd, '400');
    assert.equal(position.buyVolumeUsd, '400');
    assert.equal(position.buyTxCount, 2);
    assert.equal(metrics.avgBuyMcapUsd, '1750');
  });

  it('allocates cost proportionally on a partial sale and realizes a loss', () => {
    const position = applyEvents([
      { type: 'buy', amountRaw: '10', volumeUsd: '100', marketCapUsd: '1000' },
      { type: 'sell', amountRaw: '4', volumeUsd: '30', marketCapUsd: '1500' },
    ]);
    const metrics = deriveWalletPositionMetrics(position);

    assert.equal(position.quantityRaw, '6');
    assert.equal(position.costBasisUsd, '60');
    assert.equal(position.realizedPnlUsd, '-10');
    assert.equal(position.sellProceedsUsd, '30');
    assert.equal(position.sellTxCount, 1);
    assert.equal(metrics.avgSellMcapUsd, '1500');
  });

  it('treats transferred inventory as zero cost and shows its current value as U. PnL', () => {
    const position = applyWalletPositionEvent({}, { type: 'transfer_in', amountRaw: '250' });
    const metrics = deriveWalletPositionMetrics(position, {
      holderBalanceRaw: '250', totalSupplyRaw: '1000', currentFdvUsd: '200000',
    });

    assert.equal(position.costBasisUsd, '0');
    assert.equal(position.zeroCostReceivedRaw, '250');
    assert.equal(position.quality, 'transferred_assumed_zero');
    assert.equal(metrics.currentValueUsd, '50000');
    assert.equal(metrics.unrealizedPnlUsd, '50000');
    assert.equal(metrics.unrealizedPnlPct, null);
  });

  it('derives unrealized PnL and percentage from remaining cost basis', () => {
    const position = applyWalletPositionEvent(
      {}, { type: 'buy', amountRaw: '10', volumeUsd: '100', marketCapUsd: '1000' }
    );
    const metrics = deriveWalletPositionMetrics(position, {
      holderBalanceRaw: '10', totalSupplyRaw: '100', currentFdvUsd: '1500',
    });

    assert.equal(metrics.currentValueUsd, '150');
    assert.equal(metrics.unrealizedPnlUsd, '50');
    assert.equal(metrics.unrealizedPnlPct, '50');
  });

  it('moves proportional cost on transfer-out without realizing PnL', () => {
    const position = applyEvents([
      { type: 'buy', amountRaw: '10', volumeUsd: '100', marketCapUsd: '1000' },
      { type: 'transfer_out', amountRaw: '4' },
    ]);

    assert.equal(position.quantityRaw, '6');
    assert.equal(position.costBasisUsd, '60');
    assert.equal(position.realizedPnlUsd, '0');
    assert.equal(position.quality, 'transfer_adjusted');
  });

  it('allocates oversell proceeds to zero-cost inventory without negative quantity', () => {
    const position = applyEvents([
      { type: 'buy', amountRaw: '10', volumeUsd: '100', marketCapUsd: '1000' },
      { type: 'sell', amountRaw: '15', volumeUsd: '120', marketCapUsd: '800' },
    ]);

    assert.equal(position.quantityRaw, '0');
    assert.equal(position.costBasisUsd, '0');
    assert.equal(position.realizedPnlUsd, '20');
    assert.equal(position.zeroCostSoldRaw, '5');
    assert.equal(position.quality, 'transferred_assumed_zero');
  });

  it('marks an unexplained transfer-out as partial history and clamps at zero', () => {
    const position = applyWalletPositionEvent(
      { quantityRaw: '3', costBasisUsd: '9' },
      { type: 'transfer_out', amountRaw: '5' },
    );

    assert.equal(position.quantityRaw, '0');
    assert.equal(position.costBasisUsd, '0');
    assert.equal(position.realizedPnlUsd, '0');
    assert.equal(position.quality, 'partial_history');
  });

  it('keeps large raw quantities exact when valuing the holder balance', () => {
    const metrics = deriveWalletPositionMetrics({}, {
      holderBalanceRaw: '123456789012345678901234567890',
      totalSupplyRaw: '1000000000000000000000000000000',
      currentFdvUsd: '1000000',
    });

    assert.equal(metrics.currentValueUsd, '123456.78901234567890123456789');
    assert.equal(metrics.unrealizedPnlUsd, '123456.78901234567890123456789');
  });

  it('rejects invalid events and impossible persisted values', () => {
    const cases = [
      () => applyWalletPositionEvent({}, { type: 'mint', amountRaw: '1' }),
      () => applyWalletPositionEvent({}, { type: 'buy', amountRaw: '0', volumeUsd: '1' }),
      () => applyWalletPositionEvent({}, { type: 'sell', amountRaw: '1', volumeUsd: '-1' }),
      () => applyWalletPositionEvent({}, {
        type: 'buy', amountRaw: '1', volumeUsd: '1', newSideTransaction: 'yes',
      }),
      () => createWalletPosition({ quantityRaw: '-1' }),
      () => createWalletPosition({ quantityRaw: '0', costBasisUsd: '1' }),
      () => deriveWalletPositionMetrics({}, { totalSupplyRaw: '0', currentFdvUsd: '1' }),
    ];

    for (const execute of cases) assert.throws(execute);
  });
});
