const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  buildSniperSnapshot,
  createRobinhoodHolderSniperMaterializer,
} = require('../src/services/robinhood-holder-sniper-materializer');

const TOKEN = `0x${'1'.repeat(40)}`;
const HASH = `0x${'2'.repeat(64)}`;
const TX = `0x${'3'.repeat(64)}`;
const WALLET_A = `0x${'4'.repeat(40)}`;
const WALLET_B = `0x${'5'.repeat(40)}`;

function buy(walletAddress, overrides = {}) {
  return {
    walletAddress, transactionHash: TX, actionIndex: '1', transactionIndex: '2',
    blockNumber: '101', blockHash: HASH, blockTime: '2026-08-21T12:00:05Z',
    volumeUsd: '25', evidenceVersion: 'rh_launch_v1', deltaBlocks: '1',
    deltaSeconds: 5, withinLaunchWindow: true, ...overrides,
  };
}

function evidence(overrides = {}) {
  return {
    ready: true, tokenAddress: TOKEN,
    frontier: { blockNumber: '200', blockHash: HASH },
    window: { maxBlocks: 3, maxSeconds: 90 },
    anchor: {
      transactionHash: TX, actionIndex: '0', transactionIndex: '1',
      blockNumber: '100', blockHash: HASH, blockTime: '2026-08-21T12:00:00Z',
    },
    firstBuys: [buy(WALLET_A), buy(WALLET_B, { volumeUsd: '9.99' })],
    exclusions: [],
    ...overrides,
  };
}

describe('Robinhood holder SNIPER materializer', () => {
  it('requires an explicit positive notional instead of inventing a default', () => {
    assert.throws(() => createRobinhoodHolderSniperMaterializer(), /minimumNotionalUsd/);
    assert.throws(() => createRobinhoodHolderSniperMaterializer({
      minimumNotionalUsd: '0',
    }), /must be positive/);
  });

  it('publishes only in-window, non-infrastructure buys meeting exact decimal notional', () => {
    const snapshot = buildSniperSnapshot(evidence({
      firstBuys: [
        buy(WALLET_A, { volumeUsd: '10.000' }),
        buy(WALLET_B, { volumeUsd: '100', withinLaunchWindow: false }),
      ],
      exclusions: [{ walletAddress: WALLET_B, reason: 'infrastructure_cex' }],
    }), '2026-08-21T13:00:00Z', '0010.000');

    assert.equal(snapshot.classifier, 'sniper');
    assert.deepEqual(snapshot.records.map(({ walletAddress }) => walletAddress), [WALLET_A]);
    assert.equal(snapshot.records[0].confidence, 'high');
    assert.deepEqual(snapshot.records[0].evidence.rule, {
      maxBlocks: 3, maxSeconds: 90, minimumNotionalUsd: '10',
    });
    assert.equal(snapshot.records[0].evidence.firstBuy.volumeUsd, '10.000');
  });

  it('defers without touching classification state when launch evidence is unavailable', async () => {
    let writes = 0;
    const materializer = createRobinhoodHolderSniperMaterializer({
      minimumNotionalUsd: '10',
      source: { loadLaunchEvidence: async () => ({
        ready: false, reason: 'swap_seed_not_complete',
      }) },
      classifications: { replaceClassifierSnapshot: async () => { writes += 1; } },
    });

    assert.deepEqual(await materializer.materializeToken(TOKEN), {
      status: 'deferred', reason: 'swap_seed_not_complete', records: 0,
    });
    assert.equal(writes, 0);
  });
});
