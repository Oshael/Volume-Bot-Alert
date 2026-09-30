'use strict';

const assert = require('node:assert/strict');
const { it } = require('node:test');
const { setImmediate } = require('node:timers/promises');
const {
  createRobinhoodV3ArchiveWalletAttribution,
} = require('../src/services/robinhood-v3-archive-wallet-attribution');

const HASH = `0x${'a'.repeat(64)}`;
const TX = `0x${'b'.repeat(64)}`;
const WALLET = `0x${'c'.repeat(40)}`;

function fixture(blockHash = HASH, options = {}) {
  const writes = [];
  const observations = Array.from({ length: options.blocks || 1 }, (_, index) => ({
    transaction_hash: index ? `0x${String(index).padStart(64, '0')}` : TX,
    log_index: '1', block_number: String(100 + index),
    protocol: 'uniswap-v3', market_key: 'robinhood:uniswap-v3:test',
    token_address: `0x${'d'.repeat(40)}`, quote_address: `0x${'e'.repeat(40)}`,
    side: 'buy', token_amount_raw: '10', quote_amount_raw: '20',
    token_decimals: 18, quote_decimals: 6, token_amount: '1', quote_amount: '2',
    price_usd: '2', volume_usd: '2', fdv_usd: '200', token_total_supply_raw: '100',
  }));
  const database = { query: async (sql) => {
    assert.match(sql, /observation\.status = 'accepted'/);
    return { rows: observations };
  } };
  const replay = createRobinhoodV3ArchiveWalletAttribution({
    database,
    fetchConcurrency: options.fetchConcurrency,
    rpcClient: { request: async (_method, [tag]) => {
      const number = Number(BigInt(tag));
      await options.onFetch?.(number);
      return {
        number: tag, hash: options.hashForBlock?.(number) || blockHash,
        timestamp: '0x5f5e100',
        transactions: [{ hash: observations[number - 100].transaction_hash,
          from: WALLET, transactionIndex: '0x0' }],
      };
    } },
    walletRepository: {
      insertWalletSwaps: async (rows) => { writes.push(...rows); return { inserted: rows.length }; },
    },
    transactionPositionRepository: {
      upsertPositions: async (rows) => { writes.push(...rows); },
    },
  });
  const captures = observations.map((row) => ({ ...row, block_hash: HASH }));
  return { replay, writes, captures };
}

it('attributes a repaired accepted swap through the archive full block', async () => {
  const { replay, writes } = fixture();
  const result = await replay.attribute([{
    transaction_hash: TX, log_index: '1', block_number: '100', block_hash: HASH,
  }]);
  assert.deepEqual(result, { accepted: 1, attributed: 1, inserted: 1, blocks: 1 });
  assert.equal(writes[0].blockHash, HASH);
  assert.equal(writes[1].walletAddress, WALLET);
});

it('refuses an archive block whose hash differs from the repaired capture', async () => {
  const { replay, writes } = fixture(`0x${'f'.repeat(64)}`);
  await assert.rejects(replay.attribute([{
    transaction_hash: TX, log_index: '1', block_number: '100', block_hash: HASH,
  }]), /archive block hash differs/);
  assert.equal(writes.length, 0);
});

it('bounds archive reads and preserves attribution order when blocks finish out of order', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let active = 0; let maxActive = 0;
  const started = [];
  const { replay, writes, captures } = fixture(HASH, {
    blocks: 5, fetchConcurrency: 2,
    onFetch: async (number) => {
      started.push(number); active += 1; maxActive = Math.max(maxActive, active);
      if (number === 100) await gate;
      active -= 1;
    },
  });
  const pending = replay.attribute(captures);
  await setImmediate();
  const prefetched = started.length;
  const prematureWrites = writes.length;
  release();
  const result = await pending;
  assert.equal(prefetched, 5);
  assert.equal(maxActive, 2);
  assert.equal(prematureWrites, 0);
  assert.equal(result.attributed, 5);
  assert.deepEqual(writes.slice(5).map((row) => row.blockNumber), captures.map((row) => row.block_number));
});

it('writes nothing when one of the concurrent archive blocks has a divergent hash', async () => {
  const { replay, writes, captures } = fixture(HASH, {
    blocks: 3, fetchConcurrency: 2,
    hashForBlock: (number) => number === 101 ? `0x${'f'.repeat(64)}` : HASH,
  });
  await assert.rejects(replay.attribute(captures), /archive block hash differs/);
  assert.equal(writes.length, 0);
});
