const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { compareReceipt, main, parseArgs } = require(
  '../src/utils/audit-robinhood-wallet-transfer-pilot-parity'
);
const { TRANSFER_TOPIC } = require('../src/services/evm-erc20-supply-delta');

const BLOCK_HASH = `0x${'a'.repeat(64)}`;
const TOKEN = `0x${'b'.repeat(40)}`;
const FROM = `0x${'c'.repeat(40)}`;
const TO = `0x${'d'.repeat(40)}`;
const topic = (address) => `0x${'0'.repeat(24)}${address.slice(2)}`;
const sample = Array.from({ length: 24 }, (_, index) => ({
  transaction_hash: `0x${(index + 1).toString(16).padStart(64, '0')}`,
  log_index: index, block_number: '100', block_hash: BLOCK_HASH,
  transaction_index: index, token_address: TOKEN, from_wallet: FROM,
  to_wallet: TO, amount_raw: '7', transfer_kind: 'unknown',
  classification_version: 'rh_transfer_v1',
}));

function receipt(row) {
  return { transactionHash: row.transaction_hash, blockHash: row.block_hash,
    blockNumber: '0x64', transactionIndex: `0x${row.transaction_index.toString(16)}`,
    logs: [{ logIndex: `0x${row.log_index.toString(16)}`,
      address: row.token_address, blockHash: row.block_hash,
      transactionHash: row.transaction_hash, topics: [TRANSFER_TOPIC,
        topic(row.from_wallet), topic(row.to_wallet)],
      data: `0x${BigInt(row.amount_raw).toString(16).padStart(64, '0')}` }] };
}

function fixture(overrides = {}) {
  const queries = []; const calls = [];
  const database = { query: async (sql) => {
    queries.push(sql);
    if (sql.includes('FROM robinhood_wallet_transfer_compaction_watermarks')) {
      return { rows: [{ version: '0', checkpoint_block: '100',
        checkpoint_hash: BLOCK_HASH, raw_event_count: '24',
        eligible_transfer_count: '0', eligible_amount_raw: '0',
        summary_transfer_count: '0', summary_amount_raw: '0',
        lifecycle_state: 'verified', ...overrides.watermark }] };
    }
    if (sql.includes('COUNT(*)::text AS raw_event_count')) {
      return { rows: [{ raw_event_count: '24', eligible_transfer_count: '0',
        eligible_amount_raw: '0', ...overrides.totals }] };
    }
    if (sql.includes('ORDER BY transaction_hash')) return { rows: sample };
    throw new Error('unexpected query');
  } };
  const rpcClient = { request: async (method, params) => {
    calls.push(method);
    if (method === 'eth_chainId') return overrides.chainId || '0x1237';
    if (method === 'eth_getBlockByNumber') return {
      number: params[0], hash: overrides.checkpointHash || BLOCK_HASH,
    };
    if (method === 'eth_getTransactionReceipt') {
      const row = sample.find((item) => item.transaction_hash === params[0]);
      const value = receipt(row);
      if (overrides.mismatchReceipt) value.logs[0].data = '0x08';
      return value;
    }
    throw new Error('unexpected RPC');
  } };
  return { database, rpcClient, queries, calls };
}

describe('Robinhood transfer pilot parity audit', () => {
  it('compares deterministic raw receipts with Archive without writing or approving the drop', async () => {
    const f = fixture();
    const report = await main(['--day=2026-07-19'], {
      ...f, logger: { log() {} },
    });
    assert.equal(report.deterministicReceiptSample.matched, 24);
    assert.equal(report.archiveReplay.status, 'sample_only');
    assert.equal(report.readyForDrop, false);
    assert.equal(report.destructive, false);
    assert.equal(f.calls.filter((method) => method === 'eth_getTransactionReceipt').length, 24);
    for (const sql of f.queries) assert.doesNotMatch(sql, /\b(?:DROP|UPDATE|DELETE|INSERT)\b/i);
  });

  it('fails closed on chain, checkpoint, totals and receipt differences', async () => {
    for (const [overrides, error] of [
      [{ chainId: '0x1' }, /chain ID/],
      [{ checkpointHash: `0x${'f'.repeat(64)}` }, /checkpoint differs/],
      [{ totals: { raw_event_count: '23' } }, /differs from watermark/],
      [{ mismatchReceipt: true }, /receipt differs/],
    ]) {
      await assert.rejects(main(['--day=2026-07-19'], {
        ...fixture(overrides), logger: { log() {} },
      }), error);
    }
    assert.equal(compareReceipt(sample[0], receipt(sample[0])), true);
    assert.equal(compareReceipt(sample[0], null), false);
    assert.throws(() => parseArgs(['--day=2026-07-18']), /requires/);
  });
});
