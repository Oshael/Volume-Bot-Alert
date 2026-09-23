const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { main, parseArgs, decodeCursor } = require(
  '../src/utils/replay-robinhood-wallet-transfer-pilot-receipts'
);
const { TRANSFER_TOPIC } = require('../src/services/evm-erc20-supply-delta');

const BLOCK_HASH = `0x${'a'.repeat(64)}`;
const TOKEN = `0x${'b'.repeat(40)}`;
const FROM = `0x${'c'.repeat(40)}`;
const TO = `0x${'d'.repeat(40)}`;
const topic = (address) => `0x${'0'.repeat(24)}${address.slice(2)}`;
const rows = Array.from({ length: 3 }, (_, index) => ({
  transaction_hash: `0x${(index + 1).toString(16).padStart(64, '0')}`,
  log_index: index, block_time: new Date(`2026-07-19T00:00:0${index}Z`),
  block_number: '100', block_hash: BLOCK_HASH, transaction_index: index,
  token_address: TOKEN, from_wallet: FROM, to_wallet: TO,
  amount_raw: '7', transfer_kind: 'unknown', classification_version: 'rh_transfer_v1',
}));

function receipt(row) {
  return { transactionHash: row.transaction_hash, blockHash: row.block_hash,
    blockNumber: '0x64', transactionIndex: `0x${row.transaction_index.toString(16)}`,
    logs: [{ logIndex: `0x${row.log_index.toString(16)}`,
      address: row.token_address, blockHash: row.block_hash,
      transactionHash: row.transaction_hash,
      topics: [TRANSFER_TOPIC, topic(FROM), topic(TO)], data: '0x07' }] };
}

function fixture(options = {}) {
  const queries = []; const logged = [];
  const database = { query: async (sql, params) => {
    queries.push(sql);
    if (sql.includes('FROM robinhood_wallet_transfer_compaction_watermarks')) {
      return { rows: [{ version: options.version || '0', checkpoint_block: '100',
        checkpoint_hash: BLOCK_HASH, raw_event_count: options.count || '3',
        lifecycle_state: 'verified' }] };
    }
    if (sql.includes('FROM public.robinhood_token_transfer_events_2026_07_19')) {
      const after = params[0];
      return { rows: rows.filter((row) => after === null
        || row.transaction_hash > after).slice(0, params[3]) };
    }
    throw new Error('unexpected query');
  } };
  const rpcClient = { request: async (method) => {
    if (method === 'eth_chainId') return '0x1237';
    if (method === 'eth_getBlockByNumber') return { number: '0x64', hash: BLOCK_HASH };
    throw new Error('unexpected RPC');
  }, requestBatch: async (batch) => batch.map(({ params }) => {
    const row = rows.find((item) => item.transaction_hash === params[0]);
    const value = receipt(row);
    if (options.badReceipt && row === rows[2]) value.logs[0].data = '0x08';
    return value;
  }) };
  return { database, rpcClient, logger: { log: (value) => logged.push(JSON.parse(value)) },
    queries, logged };
}

describe('Robinhood transfer pilot receipt replay', () => {
  it('resumes from the exact cursor and completes only after all receipts match', async () => {
    const f = fixture();
    const partial = await main(['--day=2026-07-19', '--batch-size=2', '--max-batches=1'], f);
    assert.equal(partial.scanComplete, false);
    assert.equal(partial.scannedTotal, 2);
    assert.equal(decodeCursor(partial.nextCursor).transactionHash, rows[1].transaction_hash);
    const complete = await main(['--day=2026-07-19', '--batch-size=2',
      `--after=${partial.nextCursor}`], f);
    assert.equal(complete.scanComplete, true);
    assert.equal(complete.scannedTotal, 3);
    assert.equal(complete.archiveRawReceipts, 'resume_requires_log_verification');
    assert.equal(complete.archiveReplay.status, 'partial');
    assert.equal(complete.readyForDrop, false);
    assert.equal(complete.nextCursor, null);
    for (const sql of f.queries) assert.doesNotMatch(sql, /\b(?:DROP|UPDATE|DELETE|INSERT)\b/i);
  });

  it('fails closed on a changed watermark, missing rows or a wrong receipt', async () => {
    const first = await main(['--day=2026-07-19', '--batch-size=2', '--max-batches=1'],
      fixture());
    await assert.rejects(main(['--day=2026-07-19', `--after=${first.nextCursor}`],
      fixture({ version: '1' })), /cursor does not match/);
    await assert.rejects(main(['--day=2026-07-19'], fixture({ count: '4' })),
      /count differs/);
    await assert.rejects(main(['--day=2026-07-19'], fixture({ badReceipt: true })),
      /receipt differs/);
    assert.throws(() => parseArgs(['--day=2026-07-18']), /requires/);
    assert.throws(() => decodeCursor('invalid'), /invalid replay cursor/);
  });
});
