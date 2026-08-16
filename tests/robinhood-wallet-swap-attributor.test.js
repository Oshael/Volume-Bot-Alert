const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodWalletSwapAttributor,
} = require('../src/services/robinhood-wallet-swap-attributor');

const SIGNER_A = `0x${'a'.repeat(40)}`;
const SIGNER_B = `0x${'b'.repeat(40)}`;
const TX_1 = `0x${'1'.repeat(64)}`;
const TX_2 = `0x${'2'.repeat(64)}`;

function observation(txHash, logIndex, overrides = {}) {
  return {
    transaction_hash: txHash,
    log_index: String(logIndex),
    block_number: '100',
    protocol: 'uniswap-v3',
    market_key: 'uniswap-v3:0xpool',
    token_address: `0x${'c'.repeat(40)}`,
    quote_address: `0x${'d'.repeat(40)}`,
    side: 'buy',
    token_amount_raw: '1000',
    quote_amount_raw: '2000',
    token_decimals: '18',
    quote_decimals: '6',
    price_usd: '1.5',
    volume_usd: '3000',
    fdv_usd: '48000',
    token_total_supply_raw: '1000000000000000000000000',
    ...overrides,
  };
}

// block 0x64 = 100, timestamp 0x60000000
function blockWith(transactions) {
  return {
    number: '0x64',
    timestamp: '0x60000000',
    hash: `0x${'f'.repeat(64)}`,
    transactions,
  };
}

function fakeRepository(calls = []) {
  const inserted = [];
  return {
    inserted,
    insertWalletSwaps: async (rows) => {
      calls.push('swaps');
      inserted.push(rows);
      return { inserted: rows.length, ensuredDays: [] };
    },
  };
}

function fakeTransactionPositionRepository(calls = []) {
  const inserted = [];
  return {
    inserted,
    upsertPositions: async (rows) => {
      calls.push('positions');
      inserted.push(rows);
      return { requested: rows.length, persisted: rows.length };
    },
  };
}

describe('robinhood wallet swap attributor', () => {
  it('attributes each swap to its transaction signer and writes mapped rows', async () => {
    const calls = [];
    const repository = fakeRepository(calls);
    const transactionPositionRepository = fakeTransactionPositionRepository(calls);
    const fetchBlock = async () => blockWith([
      { hash: TX_1, from: SIGNER_A },
      { hash: TX_2, from: SIGNER_B },
    ]);
    const published = [];
    const attributor = createRobinhoodWalletSwapAttributor({
      repository, transactionPositionRepository, fetchBlock,
      onTradesPersisted: async (rows) => published.push(rows),
    });

    const result = await attributor.attributeBlock(100n, [
      observation(TX_1, 5),
      observation(TX_2, 9),
    ]);

    assert.deepEqual(result, {
      blockNumber: '100',
      blockHash: `0x${'f'.repeat(64)}`,
      blockTime: new Date(0x60000000 * 1000).toISOString(),
      attributed: 2, inserted: 2, unresolved: 0, missing: 0,
    });
    const rows = repository.inserted[0];
    assert.equal(rows[0].walletAddress, SIGNER_A);
    // Crystallized per-swap MC + at-block supply carried from the observation.
    assert.equal(rows[0].fdvUsd, '48000');
    assert.equal(rows[0].tokenTotalSupplyRaw, '1000000000000000000000000');
    assert.equal(rows[0].actionIndex, '5');
    assert.equal(rows[0].blockTime, new Date(0x60000000 * 1000).toISOString());
    assert.equal(rows[0].parserVersion, 'rh-wallet-seed-1');
    assert.equal(rows[1].walletAddress, SIGNER_B);
    assert.equal(published[0], rows);
    assert.deepEqual(transactionPositionRepository.inserted[0], [{
      transactionHash: TX_1, blockNumber: '100',
      blockHash: `0x${'f'.repeat(64)}`, transactionIndex: '0',
    }, {
      transactionHash: TX_2, blockNumber: '100',
      blockHash: `0x${'f'.repeat(64)}`, transactionIndex: '1',
    }]);
    assert.deepEqual(calls, ['positions', 'swaps']);
  });

  it('writes nothing when any transaction is absent from the block', async () => {
    const repository = fakeRepository();
    const transactionPositionRepository = fakeTransactionPositionRepository();
    const fetchBlock = async () => blockWith([{ hash: TX_1, from: SIGNER_A }]);
    const attributor = createRobinhoodWalletSwapAttributor({
      repository, transactionPositionRepository, fetchBlock,
    });

    const result = await attributor.attributeBlock(100n, [
      observation(TX_1, 5),
      observation(TX_2, 9), // not in the block
    ]);

    assert.equal(result.attributed, 0);
    assert.equal(result.unresolved, 1);
    assert.equal(result.missing, 1);
    assert.equal(repository.inserted.length, 0);
  });

  it('propagates the reorg guard when the fetched block number is wrong', async () => {
    const repository = fakeRepository();
    const transactionPositionRepository = fakeTransactionPositionRepository();
    const fetchBlock = async () => blockWith([{ hash: TX_1, from: SIGNER_A }]); // number 0x64 = 100
    const attributor = createRobinhoodWalletSwapAttributor({
      repository, transactionPositionRepository, fetchBlock,
    });

    await assert.rejects(
      () => attributor.attributeBlock(101n, [observation(TX_1, 5)]),
      /does not match expected 101/
    );
    assert.equal(repository.inserted.length, 0);
  });

  it('does not fetch or write for an empty observation set', async () => {
    const repository = fakeRepository();
    const transactionPositionRepository = fakeTransactionPositionRepository();
    let fetched = 0;
    const fetchBlock = async () => { fetched += 1; return blockWith([]); };
    const attributor = createRobinhoodWalletSwapAttributor({
      repository, transactionPositionRepository, fetchBlock,
    });

    const result = await attributor.attributeBlock(100n, []);
    assert.equal(fetched, 0);
    assert.equal(repository.inserted.length, 0);
    assert.deepEqual(result, {
      blockNumber: '100', blockHash: null, blockTime: null,
      attributed: 0, inserted: 0, unresolved: 0, missing: 0,
    });
  });

  it('aggregates totals across grouped blocks', async () => {
    const repository = fakeRepository();
    const transactionPositionRepository = fakeTransactionPositionRepository();
    const blocks = {
      100n: blockWith([{ hash: TX_1, from: SIGNER_A }]),
      101n: blockWith([{ hash: TX_2, from: SIGNER_B }]),
    };
    const fetchBlock = async (n) => {
      // return the block whose number matches, adjusting the fixture number
      const base = blocks[BigInt(n)];
      return { ...base, number: `0x${BigInt(n).toString(16)}` };
    };
    const attributor = createRobinhoodWalletSwapAttributor({
      repository, transactionPositionRepository, fetchBlock,
    });

    const totals = await attributor.attributeGroups([
      [100n, [observation(TX_1, 1)]],
      [101n, [observation(TX_2, 2)]],
    ]);
    assert.deepEqual(totals, { blocks: 2, attributed: 2, inserted: 2, unresolved: 0, missing: 0 });
  });

  it('does not persist swaps or advanceable output when position persistence fails', async () => {
    const repository = fakeRepository();
    const expected = new Error('position store unavailable');
    const transactionPositionRepository = {
      upsertPositions: async () => { throw expected; },
    };
    const attributor = createRobinhoodWalletSwapAttributor({
      repository, transactionPositionRepository,
      fetchBlock: async () => blockWith([{ hash: TX_1, from: SIGNER_A }]),
    });

    await assert.rejects(() => attributor.attributeBlock(
      100n, [observation(TX_1, 5)]
    ), expected);
    assert.equal(repository.inserted.length, 0);
  });
});
