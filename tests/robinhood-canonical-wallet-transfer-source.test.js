'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  createRobinhoodCanonicalWalletTransferSource,
} = require('../src/models/robinhood-canonical-wallet-transfer-source');

const BLOCK_100 = `0x${'a'.repeat(64)}`;
const BLOCK_101 = `0x${'b'.repeat(64)}`;

function transferReader(overrides = {}) {
  return {
    async matchesCheckpoint() { return true; },
    async readGlobalRange(input) {
      return {
        ...input, nextBlock: '102', scopeTokens: 1,
        checkpoint: { number: '101', hash: BLOCK_101 },
        transfers: [{ blockNumber: '100', blockHash: BLOCK_100,
          transactionHash: `0x${'c'.repeat(64)}`, transactionIndex: 1, logIndex: 2,
          tokenAddress: `0x${'1'.repeat(40)}`, fromWallet: `0x${'2'.repeat(40)}`,
          toWallet: `0x${'3'.repeat(40)}`, amountRaw: '7' }],
        telemetry: { requests: 0 }, ...overrides,
      };
    },
  };
}

function database(rows) {
  return { async query(sql, params) {
    assert.match(sql, /canonical=TRUE/);
    assert.deepEqual(params, ['robinhood', ['100', '101']]);
    return { rows };
  } };
}

describe('Robinhood canonical wallet-transfer source', () => {
  it('adds canonical block times without an RPC request', async () => {
    const source = createRobinhoodCanonicalWalletTransferSource({
      database: database([
        { block_number: '100', block_hash: BLOCK_100,
          block_timestamp: '2026-09-05T20:00:00.000Z' },
        { block_number: '101', block_hash: BLOCK_101,
          block_timestamp: '2026-09-05T20:00:01.000Z' },
      ]),
      transferReader: transferReader(),
    });
    const range = await source.readRange({
      fromBlock: '100', toBlock: '101', tokenAddresses: [`0x${'1'.repeat(40)}`],
    });
    assert.equal(range.fromBlockTime, '2026-09-05T20:00:00.000Z');
    assert.equal(range.checkpoint.blockTime, '2026-09-05T20:00:01.000Z');
    assert.equal(range.transfers[0].blockTime, '2026-09-05T20:00:00.000Z');
    assert.equal(range.telemetry.source, 'canonical-journal');
    assert.equal(await source.matchesCheckpoint({}), true);
  });

  it('fails closed when canonical evidence is missing or changes during the read', async () => {
    const missing = createRobinhoodCanonicalWalletTransferSource({
      database: database([{ block_number: '100', block_hash: BLOCK_100,
        block_timestamp: '2026-09-05T20:00:00.000Z' }]),
      transferReader: transferReader(),
    });
    await assert.rejects(() => missing.readRange({ fromBlock: '100', toBlock: '101',
      tokenAddresses: [] }), (error) => error.code === 'source_contract_error');

    const changed = createRobinhoodCanonicalWalletTransferSource({
      database: database([
        { block_number: '100', block_hash: BLOCK_100,
          block_timestamp: '2026-09-05T20:00:00.000Z' },
        { block_number: '101', block_hash: `0x${'d'.repeat(64)}`,
          block_timestamp: '2026-09-05T20:00:01.000Z' },
      ]),
      transferReader: transferReader(),
    });
    await assert.rejects(() => changed.readRange({ fromBlock: '100', toBlock: '101',
      tokenAddresses: [] }), /checkpoint changed/);
  });
});
