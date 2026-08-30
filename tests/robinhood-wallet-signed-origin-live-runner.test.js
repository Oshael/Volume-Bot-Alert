const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  runLiveTick,
} = require('../src/services/robinhood-wallet-signed-origin-live-runner');

const blockHash = (number) => `0x${BigInt(number).toString(16).padStart(64, '0')}`;
const hex = (number) => `0x${BigInt(number).toString(16)}`;

function cursor(overrides = {}) {
  return { stream: 'live', originBlock: '90', originBlockHash: blockHash(90),
    nextBlock: '101', safeHead: '100', safeHeadHash: blockHash(100),
    checkpointBlock: '100', checkpointHash: blockHash(100),
    lifecycleState: 'caught_up', version: 2, ...overrides };
}

function runtime(overrides = {}) {
  let current = cursor(); const commits = [];
  const value = {
    commits,
    repository: {
      initializeLiveFromSeed: async () => current,
      commitLiveBatch: async (input) => {
        commits.push(input);
        const nextBlock = (BigInt(input.blocks.at(-1).number) + 1n).toString();
        current = { ...current, nextBlock, safeHead: input.safeHead,
          safeHeadHash: input.safeHeadHash, version: current.version + 1,
          checkpointBlock: input.blocks.at(-1).number,
          checkpointHash: input.blocks.at(-1).hash,
          lifecycleState: BigInt(nextBlock) > BigInt(input.safeHead) ? 'caught_up' : 'running' };
        return { cursor: current, blocksCommitted: input.blocks.length, originsWritten: 0 };
      },
    },
    reader: { readBlocks: async ({ blockNumbers }) => ({
      blocks: blockNumbers.map((number) => ({ number, hash: blockHash(number),
        blockTime: '2026-08-30T12:00:00.000Z', transactionCount: 0 })),
      origins: [], metrics: { blocksScanned: blockNumbers.length },
    }) },
    loadSourceFrontier: async () => ({ safeHead: '103' }),
    fetchBlockHeader: async (number) => ({ number: hex(number), hash: blockHash(number) }),
    maxBlocks: 2,
    ...overrides,
  };
  return value;
}

describe('Robinhood signed-origin LIVE runner', () => {
  it('advances a bounded contiguous batch against the committed source frontier', async () => {
    const deps = runtime();
    const result = await runLiveTick(deps);
    assert.deepEqual({ status: result.status, nextBlock: result.nextBlock,
      lagBlocks: result.lagBlocks, blocksCommitted: result.blocksCommitted }, {
      status: 'advanced', nextBlock: '103', lagBlocks: '1', blocksCommitted: 2,
    });
    assert.deepEqual(deps.commits[0].blocks.map(({ number }) => number), ['101', '102']);
    assert.deepEqual({ safeHead: deps.commits[0].safeHead,
      safeHeadHash: deps.commits[0].safeHeadHash }, {
      safeHead: '103', safeHeadHash: blockHash(103),
    });
  });

  it('halts before reading when the committed checkpoint changed', async () => {
    let reads = 0; const deps = runtime({
      reader: { readBlocks: async () => { reads += 1; } },
      fetchBlockHeader: async (number) => ({ number: hex(number), hash: blockHash(999) }),
    });
    await assert.rejects(runLiveTick(deps), (error) => (
      error.code === 'persistent_reorg' && error.fatal === true
    ));
    assert.equal(reads, 0); assert.equal(deps.commits.length, 0);
  });

  it('halts on source regression and returns caught-up without writes', async () => {
    const regressed = runtime({ loadSourceFrontier: async () => ({ safeHead: '99' }) });
    await assert.rejects(runLiveTick(regressed),
      (error) => error.code === 'persistent_reorg' && error.fatal === true);
    const caughtUp = runtime({ loadSourceFrontier: async () => ({ safeHead: '100' }) });
    const result = await runLiveTick(caughtUp);
    assert.equal(result.status, 'caught_up'); assert.equal(caughtUp.commits.length, 0);
    const waiting = await runLiveTick(runtime({ loadSourceFrontier: async () => null }));
    assert.deepEqual([waiting.status, waiting.sourceSafeHead, waiting.lagBlocks],
      ['waiting_source', null, null]);
  });
});
