const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  runRobinhoodWalletTransferTokenRepairRange,
} = require('../src/services/robinhood-wallet-transfer-token-repair-runner');

const TOKEN = `0x${'1'.repeat(40)}`;
const HASH = `0x${'a'.repeat(64)}`;

function event(transferKind = 'wallet_transfer') {
  return {
    tokenAddress: TOKEN, fromWallet: `0x${'2'.repeat(40)}`,
    toWallet: `0x${'3'.repeat(40)}`, blockNumber: '100', transactionIndex: 0,
    logIndex: 1, blockTime: '2026-08-24T00:00:00.000Z',
    transactionHash: HASH, amountRaw: '10', transferKind,
    classificationVersion: 'rh_transfer_v1',
  };
}

function setup(canonical = true) {
  const calls = [];
  const coverage = {
    async claim(input) {
      calls.push(['claim', input]);
      return { tokenAddress: TOKEN, nextBlock: '100', sourceThroughBlock: '199' };
    },
    async commitShadowRange(input) {
      calls.push(['commit', input]);
      return { complete: false, projected: { edgeGroups: 1 } };
    },
    async retry(input) { calls.push(['retry', input]); return 'pending'; },
  };
  const tickDeps = { evidence: { async matchesCheckpoint() { return canonical; } } };
  const prepareRange = async (_deps, input) => {
    calls.push(['prepare', input]);
    return {
      captured: { checkpoint: { number: input.toBlock, hash: HASH } },
      classified: { events: [event(), event('wallet_self')] },
    };
  };
  return { calls, coverage, tickDeps, prepareRange };
}

describe('Robinhood wallet-transfer token repair runner', () => {
  it('processes one bounded canonical range and persists only edge-eligible events', async () => {
    const deps = setup();
    const result = await runRobinhoodWalletTransferTokenRepairRange(deps, {
      owner: 'test-owner', maxBlocks: 50,
    });
    assert.equal(result.status, 'projected');
    assert.deepEqual([result.fromBlock, result.toBlock, result.events], ['100', '149', 1]);
    const committed = deps.calls.find(([name]) => name === 'commit')[1];
    assert.equal(committed.events.length, 1);
    assert.equal(committed.events[0].transferKind, 'wallet_transfer');
  });

  it('requeues instead of writing when the range checkpoint is not canonical', async () => {
    const deps = setup(false);
    const result = await runRobinhoodWalletTransferTokenRepairRange(deps, {
      owner: 'test-owner', maxBlocks: 50,
    });
    assert.equal(result.status, 'pending');
    assert.equal(result.error.code, 'token_repair_checkpoint_mismatch');
    assert.equal(deps.calls.some(([name]) => name === 'commit'), false);
    assert.equal(deps.calls.some(([name]) => name === 'retry'), true);
  });
});
