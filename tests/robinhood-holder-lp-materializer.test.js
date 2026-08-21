const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  buildLpSnapshot,
  createRobinhoodHolderLpMaterializer,
} = require('../src/services/robinhood-holder-lp-materializer');

const TOKEN = `0x${'1'.repeat(40)}`;
const POOL_A = `0x${'2'.repeat(40)}`;
const POOL_B = `0x${'3'.repeat(40)}`;
const HASH = `0x${'a'.repeat(64)}`;

function candidate(overrides = {}) {
  return {
    ready: true,
    tokenAddress: TOKEN,
    frontier: { blockNumber: '200', blockHash: HASH },
    pools: [{
      walletAddress: POOL_B, poolAddress: POOL_B, poolId: null,
      protocol: 'uniswap-v3', marketKey: 'v3-b',
      discoveryBlock: '20', discoveryBlockHash: HASH,
      discoveryTransactionHash: HASH, discoveryLogIndex: '2',
    }, {
      walletAddress: POOL_A, poolAddress: POOL_A, poolId: null,
      protocol: 'uniswap-v2', marketKey: 'v2-a',
      discoveryBlock: '10', discoveryBlockHash: HASH,
      discoveryTransactionHash: HASH, discoveryLogIndex: '1',
    }],
    ...overrides,
  };
}

describe('Robinhood holder LP materializer', () => {
  it('builds deterministic LP records at the holder ledger frontier', () => {
    const snapshot = buildLpSnapshot(candidate(), '2026-08-21T12:00:00Z');

    assert.equal(snapshot.classifier, 'lp');
    assert.equal(snapshot.throughBlockNumber, '200');
    assert.deepEqual(snapshot.records.map((record) => record.walletAddress), [POOL_A, POOL_B]);
    assert.equal(snapshot.records[0].confidence, 'deterministic');
    assert.equal(snapshot.records[0].reasonCode, 'registered_token_pool');
    assert.deepEqual(snapshot.records[0].evidence, {
      source: 'robinhood_pool_registry',
      registrations: [{
        protocol: 'uniswap-v2', marketKey: 'v2-a', role: 'pool_contract',
        poolAddress: POOL_A, poolId: null, discoveryBlock: '10',
        discoveryBlockHash: HASH, discoveryTransactionHash: HASH, discoveryLogIndex: '1',
      }],
    });
  });

  it('does not mutate classification state before the holder frontier is ready', async () => {
    let publications = 0;
    const materializer = createRobinhoodHolderLpMaterializer({
      source: { loadTokenPoolEvidence: async () => ({
        ready: false, reason: 'holder_frontier_unavailable', pools: [],
      }) },
      classifications: { replaceClassifierSnapshot: async () => { publications += 1; } },
    });

    assert.deepEqual(await materializer.materializeToken(TOKEN), {
      status: 'deferred', reason: 'holder_frontier_unavailable', records: 0,
    });
    assert.equal(publications, 0);
  });
});
