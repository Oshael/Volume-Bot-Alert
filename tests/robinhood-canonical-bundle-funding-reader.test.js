'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  createRobinhoodCanonicalBundleFundingReader,
} = require('../src/services/robinhood-canonical-bundle-funding-reader');

const HASH_A = `0x${'a'.repeat(64)}`;
const HASH_B = `0x${'b'.repeat(64)}`;
const TX_A = `0x${'c'.repeat(64)}`;
const TX_B = `0x${'d'.repeat(64)}`;
const WALLET = `0x${'1'.repeat(40)}`;
const FUNDER = `0x${'2'.repeat(40)}`;

function row(overrides = {}) {
  return {
    block_number: '10', block_hash: HASH_A,
    block_timestamp: '2026-09-05T00:01:40.000Z',
    transaction_hash: TX_A, transaction_index: 0,
    from_address: FUNDER, to_address: WALLET, value_wei: '10',
    ...overrides,
  };
}

function database(rows) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.startsWith('SELECT 1')) return { rowCount: 1, rows: [{ '?column?': 1 }] };
      if (sql.includes('SELECT block_hash')) return { rowCount: 1, rows: [{ block_hash: HASH_B }] };
      if (sql.includes('WITH coverage')) return { rowCount: 1, rows: [{
        blocks: '2', transaction_gaps: '0', missing_values: '0',
      }] };
      return { rowCount: rows.length, rows };
    },
  };
}

describe('Robinhood canonical bundle-funding reader', () => {
  it('projects the exact legacy top-level native transfer contract', async () => {
    const source = database([
      row(),
      row({ transaction_hash: TX_B, transaction_index: 1,
        from_address: WALLET, to_address: FUNDER, value_wei: '0' }),
      row({ block_number: '11', block_hash: HASH_B,
        transaction_hash: null, transaction_index: null,
        from_address: null, to_address: null, value_wei: null }),
    ]);
    const reader = createRobinhoodCanonicalBundleFundingReader({
      database: source, candidateWallets: [WALLET.toUpperCase()],
    });
    assert.equal(await reader.assertChain(), '4663');
    assert.equal(await reader.checkpoint('11'), HASH_B);
    const result = await reader.readBlocks(['10', '11']);
    assert.equal(result.blocksScanned, 2);
    assert.equal(result.transfers.length, 1);
    assert.equal(result.candidateInboundTransfers, 1);
    assert.equal(result.candidateOutboundTransfers, 0);
    assert.deepEqual(result.transfers[0], {
      transactionHash: TX_A, transactionIndex: '0',
      fromAddress: FUNDER, toAddress: WALLET, valueWei: '10',
      blockNumber: '10', blockHash: HASH_A, blockTimestamp: '1788566500',
    });
    assert.deepEqual(source.calls[2].params, ['robinhood', '10', '11']);
    assert.ok(result.payloadBytes > 0);
    assert.equal(await reader.assertCoverage({ fromBlock: '10', throughBlock: '11' }), true);
  });

  it('fails closed when a requested block or transaction value is absent', async () => {
    const missingBlock = createRobinhoodCanonicalBundleFundingReader({
      database: database([row()]), candidateWallets: [],
    });
    await assert.rejects(missingBlock.readBlocks(['10', '11']), (error) => (
      error.code === 'canonical_bundle_funding_source_gap'
      && /block 11 is missing/.test(error.message)
    ));

    const missingValue = createRobinhoodCanonicalBundleFundingReader({
      database: database([row({ value_wei: null })]), candidateWallets: [],
    });
    await assert.rejects(missingValue.readBlocks(['10']), (error) => (
      error.code === 'canonical_bundle_funding_source_gap'
      && /transaction value is missing/.test(error.message)
    ));
  });

  it('fails closed on transaction gaps and missing checkpoints', async () => {
    const gap = createRobinhoodCanonicalBundleFundingReader({
      database: database([row({ transaction_index: 1 })]), candidateWallets: [],
    });
    await assert.rejects(gap.readBlocks(['10']), /transaction gap/);

    const source = database([]);
    source.query = async (sql) => (sql.includes('SELECT block_hash')
      ? { rowCount: 0, rows: [] } : { rowCount: 0, rows: [] });
    const missing = createRobinhoodCanonicalBundleFundingReader({
      database: source, candidateWallets: [],
    });
    await assert.rejects(missing.assertChain(), /capture cursor is missing/);
    await assert.rejects(missing.checkpoint('10'), /checkpoint 10 is missing/);
  });

  it('rejects unsafe batches before querying PostgreSQL', async () => {
    const source = database([]);
    const reader = createRobinhoodCanonicalBundleFundingReader({
      database: source, candidateWallets: [],
    });
    await assert.rejects(reader.readBlocks([]), /batch size/);
    await assert.rejects(reader.readBlocks(['10', '12']), /must be contiguous/);
    await assert.rejects(reader.readBlocks(Array.from({ length: 101 }, (_, index) => index)),
      /batch size/);
    assert.equal(source.calls.length, 0);
    assert.throws(() => createRobinhoodCanonicalBundleFundingReader({
      database: source, candidateWallets: ['invalid'],
    }), /candidateWallet is invalid/);
  });

  it('fails closed when aggregate coverage is incomplete', async () => {
    const cases = [
      [{ blocks: '1', transaction_gaps: '0', missing_values: '0' }, /missing blocks/],
      [{ blocks: '2', transaction_gaps: '1', missing_values: '0' }, /transaction gaps/],
      [{ blocks: '2', transaction_gaps: '0', missing_values: '7' }, /missing values/],
    ];
    for (const [coverage, pattern] of cases) {
      const source = database([]);
      source.query = async (sql) => (sql.includes('WITH coverage')
        ? { rows: [coverage] } : { rowCount: 1, rows: [] });
      const reader = createRobinhoodCanonicalBundleFundingReader({
        database: source, candidateWallets: [],
      });
      await assert.rejects(reader.assertCoverage({ fromBlock: '10', throughBlock: '11' }),
        pattern);
    }
  });
});
