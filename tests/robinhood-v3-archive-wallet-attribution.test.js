'use strict';

const assert = require('node:assert/strict');
const { it } = require('node:test');
const {
  createRobinhoodV3ArchiveWalletAttribution,
} = require('../src/services/robinhood-v3-archive-wallet-attribution');

const HASH = `0x${'a'.repeat(64)}`;
const TX = `0x${'b'.repeat(64)}`;
const WALLET = `0x${'c'.repeat(40)}`;

function fixture(blockHash = HASH) {
  const writes = [];
  const database = { query: async (sql) => {
    assert.match(sql, /observation\.status = 'accepted'/);
    return { rows: [{
      transaction_hash: TX, log_index: '1', block_number: '100',
      protocol: 'uniswap-v3', market_key: 'robinhood:uniswap-v3:test',
      token_address: `0x${'d'.repeat(40)}`, quote_address: `0x${'e'.repeat(40)}`,
      side: 'buy', token_amount_raw: '10', quote_amount_raw: '20',
      token_decimals: 18, quote_decimals: 6, token_amount: '1', quote_amount: '2',
      price_usd: '2', volume_usd: '2', fdv_usd: '200', token_total_supply_raw: '100',
    }] };
  } };
  const replay = createRobinhoodV3ArchiveWalletAttribution({
    database,
    rpcClient: { request: async () => ({
      number: '0x64', hash: blockHash, timestamp: '0x5f5e100',
      transactions: [{ hash: TX, from: WALLET, transactionIndex: '0x0' }],
    }) },
    walletRepository: {
      insertWalletSwaps: async (rows) => { writes.push(rows[0]); return { inserted: 1 }; },
    },
    transactionPositionRepository: {
      upsertPositions: async (rows) => { writes.push(rows[0]); },
    },
  });
  return { replay, writes };
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
