const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodWalletSwapSourceReader,
  __private: { groupByBlock, boundedMaxBlocks },
  DEFAULT_MAX_BLOCKS,
  MAX_MAX_BLOCKS,
} = require('../src/models/robinhood-wallet-swap-source-reader');

function fakeDb(responses = []) {
  const calls = [];
  const queue = [...responses];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      return queue.shift() || { rows: [], rowCount: 0 };
    },
  };
}

function obs(block, logIndex, txHash) {
  return { block_number: block, log_index: String(logIndex), transaction_hash: txHash, side: 'buy' };
}

describe('robinhood wallet swap source reader', () => {
  it('groups observations by block preserving ascending order', () => {
    const groups = groupByBlock([
      obs('100', 1, '0xa'), obs('100', 2, '0xb'), obs('101', 0, '0xc'),
    ]);
    assert.equal(groups.length, 2);
    assert.deepEqual(groups[0][0], '100');
    assert.equal(groups[0][1].length, 2);
    assert.deepEqual(groups[1][0], '101');
    assert.equal(groups[1][1].length, 1);
  });

  it('bounds maxBlocks with a default and a hard cap', () => {
    assert.equal(boundedMaxBlocks(undefined), DEFAULT_MAX_BLOCKS);
    assert.equal(boundedMaxBlocks('50'), 50);
    assert.equal(boundedMaxBlocks(999999), MAX_MAX_BLOCKS);
    assert.throws(() => boundedMaxBlocks('0'), /positive integer/);
  });

  it('selects distinct accepted blocks then their observations, grouped', async () => {
    const database = fakeDb([
      { rows: [{ block_number: '100' }, { block_number: '101' }] },
      { rows: [obs('100', 1, '0xa'), obs('100', 5, '0xb'), obs('101', 0, '0xc')] },
    ]);
    const reader = createRobinhoodWalletSwapSourceReader({ database });

    const result = await reader.readAcceptedBlockGroups({ fromBlock: '100', toBlock: '200', maxBlocks: '2' });

    // first query: distinct blocks, accepted, range, limit
    assert.match(database.calls[0].sql, /SELECT DISTINCT block_number/);
    assert.match(database.calls[0].sql, /status = 'accepted'/);
    assert.deepEqual(database.calls[0].params, ['robinhood', '100', '200', 2]);
    // second query: observations for those blocks
    assert.match(database.calls[1].sql, /block_number = ANY\(\$2::bigint\[\]\)/);
    assert.deepEqual(database.calls[1].params, ['robinhood', ['100', '101']]);

    assert.deepEqual(result.blockNumbers, ['100', '101']);
    assert.equal(result.groups.length, 2);
    assert.equal(result.groups[0][1].length, 2);
  });

  it('does not query observations when no accepted blocks are found', async () => {
    const database = fakeDb([{ rows: [] }]);
    const reader = createRobinhoodWalletSwapSourceReader({ database });

    const result = await reader.readAcceptedBlockGroups({ fromBlock: '100', toBlock: '200' });
    assert.equal(database.calls.length, 1);
    assert.deepEqual(result, { groups: [], blockNumbers: [] });
  });

  it('is a no-op when the range is empty (toBlock < fromBlock)', async () => {
    const database = fakeDb();
    const reader = createRobinhoodWalletSwapSourceReader({ database });

    const result = await reader.readAcceptedBlockGroups({ fromBlock: '200', toBlock: '100' });
    assert.equal(database.calls.length, 0);
    assert.deepEqual(result, { groups: [], blockNumbers: [] });
  });
});
