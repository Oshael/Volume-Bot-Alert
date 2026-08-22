const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  deriveFirstBuyEvidence,
  deriveLaunchAnchor,
} = require('../src/services/robinhood-holder-launch-domain');

const WALLET_A = `0x${'1'.repeat(40)}`;
const WALLET_B = `0x${'2'.repeat(40)}`;
const HASH_A = `0x${'a'.repeat(64)}`;
const HASH_B = `0x${'b'.repeat(64)}`;
const BLOCK_HASH = `0x${'c'.repeat(64)}`;
const FRONTIER_HASH = `0x${'d'.repeat(64)}`;

function swap(overrides = {}) {
  return {
    walletAddress: WALLET_A, transactionHash: HASH_A, actionIndex: '2',
    transactionIndex: '1', blockNumber: '100', blockHash: BLOCK_HASH,
    blockTime: '2026-08-21T12:00:00Z', side: 'buy', volumeUsd: '10',
    ...overrides,
  };
}

function anchor(swaps, overrides = {}) {
  return deriveLaunchAnchor({
    coverageReady: true,
    frontier: { blockNumber: '200', blockHash: FRONTIER_HASH },
    swaps,
    ...overrides,
  });
}

describe('Robinhood holder launch evidence domain', () => {
  it('selects the first swap by canonical block, transaction and action position', () => {
    const result = anchor([
      swap({ transactionHash: HASH_A, transactionIndex: '3', actionIndex: '0' }),
      swap({ transactionHash: HASH_B, transactionIndex: '1', actionIndex: '9' }),
      swap({ transactionHash: HASH_A, transactionIndex: '1', actionIndex: '2' }),
      swap({ blockNumber: '201', blockHash: FRONTIER_HASH }),
    ]);

    assert.equal(result.ready, true);
    assert.equal(result.anchor.transactionIndex, '1');
    assert.equal(result.anchor.actionIndex, '2');
    assert.equal(result.anchor.evidenceVersion, 'rh_launch_v1');
    assert.equal(Object.isFrozen(result.anchor), true);
  });

  it('fails closed for incomplete coverage, missing positions and forked first blocks', () => {
    assert.deepEqual(deriveLaunchAnchor({ coverageReady: false }), {
      ready: false, reason: 'source_coverage_unavailable', frontier: null, anchor: null,
    });
    assert.equal(anchor([]).reason, 'launch_swap_unavailable');
    assert.equal(anchor([swap({ transactionIndex: null })]).reason,
      'transaction_position_unavailable');
    assert.equal(anchor([
      swap(), swap({ transactionHash: HASH_B, blockHash: FRONTIER_HASH }),
    ]).reason, 'launch_block_incoherent');
  });

  it('derives one first buy per wallet and applies the OR launch window boundaries', () => {
    const anchorResult = anchor([swap()]);
    const result = deriveFirstBuyEvidence({
      anchorResult, maxBlocks: 3, maxSeconds: 90,
      swaps: [
        swap({ side: 'sell', actionIndex: '3' }),
        swap({ blockNumber: '201', blockHash: FRONTIER_HASH }),
        swap({ blockNumber: '103', blockTime: '2026-08-21T12:10:00Z' }),
        swap({ transactionHash: HASH_B, walletAddress: WALLET_B, blockNumber: '110',
          blockHash: FRONTIER_HASH, blockTime: '2026-08-21T12:01:30Z', volumeUsd: null }),
        swap({ transactionHash: HASH_B, walletAddress: WALLET_A, blockNumber: '101',
          blockHash: FRONTIER_HASH, blockTime: '2026-08-21T12:00:30Z' }),
      ],
    });

    assert.equal(result.ready, true);
    assert.equal(result.records.length, 2);
    assert.equal(result.records.find(({ walletAddress }) => walletAddress === WALLET_A)
      .deltaBlocks, '1');
    assert.equal(result.records.every(({ withinLaunchWindow }) => withinLaunchWindow), true);
    assert.equal(result.records.find(({ walletAddress }) => walletAddress === WALLET_B)
      .volumeUsd, null);
  });

  it('keeps out-of-window evidence and rejects incomplete canonical positions', () => {
    const anchorResult = anchor([swap()]);
    const outside = deriveFirstBuyEvidence({
      anchorResult, maxBlocks: 3, maxSeconds: 90,
      swaps: [swap({ blockNumber: '104', blockTime: '2026-08-21T12:01:31Z' })],
    });
    assert.equal(outside.records[0].withinLaunchWindow, false);
    assert.equal(deriveFirstBuyEvidence({
      anchorResult, maxBlocks: 3, maxSeconds: 90,
      swaps: [swap({ transactionIndex: null })],
    }).reason, 'transaction_position_unavailable');
    assert.throws(() => deriveFirstBuyEvidence({
      anchorResult, maxBlocks: 3, maxSeconds: 90,
      swaps: [swap({ transactionIndex: '0' })],
    }), /precedes the launch anchor/);
  });
});
