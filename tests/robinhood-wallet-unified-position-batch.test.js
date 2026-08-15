const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  buildRobinhoodWalletUnifiedPositionBatch,
} = require('../src/services/robinhood-wallet-unified-position-batch');

const TOKEN = `0x${'1'.repeat(40)}`;
const ALICE = `0x${'2'.repeat(40)}`;
const FUNDER = `0x${'3'.repeat(40)}`;
const POOL = `0x${'4'.repeat(40)}`;
const HASH_A = `0x${'a'.repeat(64)}`;
const HASH_B = `0x${'b'.repeat(64)}`;

function transfer(overrides = {}) {
  return {
    blockNumber: '100', transactionIndex: '0', logIndex: '1',
    transactionHash: HASH_A, tokenAddress: TOKEN,
    fromWallet: FUNDER, toWallet: ALICE, amountRaw: '10',
    transferKind: 'wallet_transfer', ...overrides,
  };
}

function swap(overrides = {}) {
  return {
    block_number: '100', transaction_hash: HASH_B, action_index: '3',
    token_address: TOKEN, wallet_address: ALICE, token_amount_raw: '10',
    side: 'sell', volume_usd: '100', market_cap_usd: '1000', ...overrides,
  };
}

function position(result, walletAddress) {
  return result.positions.find((item) => item.walletAddress === walletAddress);
}

describe('Robinhood unified wallet position batch', () => {
  it('uses canonical transaction order even when swaps arrive first', () => {
    const result = buildRobinhoodWalletUnifiedPositionBatch({
      swaps: [swap()],
      transfers: [
        transfer(),
        transfer({
          transactionHash: HASH_B, transactionIndex: '1', logIndex: '2',
          fromWallet: ALICE, toWallet: POOL, transferKind: 'dex_flow',
        }),
      ],
    });
    const alice = position(result, ALICE);
    assert.equal(alice.quantityRaw, '0');
    assert.equal(alice.realizedPnlUsd, '100');
    assert.equal(alice.sellTxCount, 1);
    assert.equal(alice.quality, 'transferred_assumed_zero');
    assert.deepEqual(result.telemetry, {
      swaps: 1, walletTransfers: 1, financialEvents: 3, touchedPositions: 2,
    });
  });

  it('does not double count DEX transfers already represented by swaps', () => {
    const result = buildRobinhoodWalletUnifiedPositionBatch({
      swaps: [swap({ side: 'buy', volume_usd: '50' })],
      transfers: [transfer({
        transactionHash: HASH_B, transactionIndex: '1', logIndex: '4',
        fromWallet: POOL, toWallet: ALICE, transferKind: 'dex_flow',
      })],
    });
    const alice = position(result, ALICE);
    assert.equal(alice.quantityRaw, '10');
    assert.equal(alice.costBasisUsd, '50');
    assert.equal(alice.buyTxCount, 1);
    assert.equal(result.telemetry.financialEvents, 1);
  });

  it('counts multiple same-side swap actions in one transaction only once', () => {
    const result = buildRobinhoodWalletUnifiedPositionBatch({
      swaps: [
        swap({ side: 'buy', token_amount_raw: '4', volume_usd: '40' }),
        swap({ side: 'buy', action_index: '5', token_amount_raw: '6', volume_usd: '60' }),
      ],
      transfers: [transfer({
        transactionHash: HASH_B, transactionIndex: '1', transferKind: 'dex_flow',
      })],
    });
    const alice = position(result, ALICE);
    assert.equal(alice.quantityRaw, '10');
    assert.equal(alice.buyVolumeUsd, '100');
    assert.equal(alice.buyTxCount, 1);
  });

  it('applies transfers over an existing position without realizing PnL', () => {
    const result = buildRobinhoodWalletUnifiedPositionBatch({
      positions: [{
        tokenAddress: TOKEN, walletAddress: FUNDER,
        quantityRaw: '20', costBasisUsd: '200', throughBlock: '99', throughLogIndex: '0',
      }],
      transfers: [transfer()],
    });
    const funder = position(result, FUNDER);
    const alice = position(result, ALICE);
    assert.equal(funder.quantityRaw, '10');
    assert.equal(funder.costBasisUsd, '100');
    assert.equal(funder.realizedPnlUsd, '0');
    assert.equal(alice.quantityRaw, '10');
    assert.equal(alice.costBasisUsd, '0');
  });

  it('fails closed when canonical swap transaction order cannot be proven', () => {
    assert.throws(
      () => buildRobinhoodWalletUnifiedPositionBatch({ swaps: [swap()], transfers: [] }),
      /transaction index is unavailable/
    );
    assert.throws(() => buildRobinhoodWalletUnifiedPositionBatch({
      swaps: [swap({ transaction_index: '2' })],
      transfers: [transfer({
        transactionHash: HASH_B, transactionIndex: '1', transferKind: 'dex_flow',
      })],
    }), /conflicts with captured transfers/);
  });

  it('ignores a classified self-transfer that cannot affect a position', () => {
    const result = buildRobinhoodWalletUnifiedPositionBatch({
      transfers: [transfer({
        fromWallet: ALICE, toWallet: ALICE,
        affectsPosition: false, connectionEligible: false,
      })],
    });
    assert.deepEqual(result.positions, []);
    assert.equal(result.telemetry.financialEvents, 0);
  });
});
