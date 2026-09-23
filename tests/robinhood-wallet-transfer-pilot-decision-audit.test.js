const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { main, parseArgs, sourceInput } = require(
  '../src/utils/audit-robinhood-wallet-transfer-pilot-decisions'
);
const { TRANSFER_TOPIC } = require('../src/services/evm-erc20-supply-delta');

const BLOCK_HASH = `0x${'a'.repeat(64)}`;
const TOKEN = `0x${'b'.repeat(40)}`;
const WALLET = `0x${'c'.repeat(40)}`;
const ZERO = `0x${'0'.repeat(40)}`;
const DEAD = '0x000000000000000000000000000000000000dead';
const topic = (address) => `0x${'0'.repeat(24)}${address.slice(2)}`;
const rows = [
  { transaction_hash: `0x${'1'.repeat(64)}`, log_index: 1,
    block_time: new Date('2026-07-19T01:00:00Z'), block_number: '100',
    block_hash: BLOCK_HASH, transaction_index: 0, token_address: TOKEN,
    from_wallet: ZERO, to_wallet: WALLET, amount_raw: '7',
    transfer_kind: 'mint', classification_version: 'rh_transfer_v1' },
  { transaction_hash: `0x${'2'.repeat(64)}`, log_index: 2,
    block_time: new Date('2026-07-19T02:00:00Z'), block_number: '101',
    block_hash: BLOCK_HASH, transaction_index: 0, token_address: TOKEN,
    from_wallet: WALLET, to_wallet: DEAD, amount_raw: '9',
    transfer_kind: 'burn', classification_version: 'rh_transfer_v1' },
];

function receipt(row) {
  return { transactionHash: row.transaction_hash, blockHash: row.block_hash,
    blockNumber: `0x${BigInt(row.block_number).toString(16)}`, transactionIndex: '0x0',
    logs: [{ logIndex: `0x${row.log_index.toString(16)}`, address: TOKEN,
      blockHash: BLOCK_HASH, transactionHash: row.transaction_hash,
      topics: [TRANSFER_TOPIC, topic(row.from_wallet), topic(row.to_wallet)],
      data: `0x${BigInt(row.amount_raw).toString(16)}` }] };
}

function fixture(options = {}) {
  const queries = []; const captured = { sourceInput: null };
  const sample = rows.map((row) => ({ ...row }));
  if (options.drift) sample[0].transfer_kind = 'unknown';
  const database = { query: async (sql) => {
    queries.push(sql);
    if (sql.includes('FROM robinhood_wallet_transfer_compaction_watermarks')) {
      return { rows: [{ version: '0', checkpoint_block: '100',
        checkpoint_hash: BLOCK_HASH, raw_event_count: options.count || '2',
        lifecycle_state: 'verified' }] };
    }
    if (sql.includes('GROUP BY transfer_kind')) return { rows: [
      { transfer_kind: sample[0].transfer_kind, events: '1' },
      { transfer_kind: 'burn', events: '1' },
    ] };
    if (sql.includes('TABLESAMPLE BERNOULLI')) return { rows: sample };
    throw new Error('unexpected query');
  } };
  const rpcClient = { request: async (method) => {
    if (method === 'eth_chainId') return '0x1237';
    if (method === 'eth_getBlockByNumber') return { number: '0x64', hash: BLOCK_HASH };
    throw new Error('unexpected RPC');
  }, requestBatch: async (batch) => batch.map(({ params }) => {
    const row = rows.find((item) => item.transaction_hash === params[0]);
    return receipt(row);
  }) };
  const source = { loadBackfillRangeContext: async (input) => {
    captured.sourceInput = input;
    return { ready: true, swapCoverageComplete: true, swaps: [],
      poolAddresses: [], routerAddresses: [], contractAddresses: [],
      contractRoleEvidence: [], walletAddresses: [] };
  } };
  return { database, rpcClient, source, logger: { log() {} }, queries, captured };
}

describe('Robinhood transfer pilot decision audit', () => {
  it('checks Archive receipts and historical decision inputs without approving drop', async () => {
    const f = fixture();
    const report = await main(['--day=2026-07-19'], f);
    assert.equal(report.receiptsMatched, 2);
    assert.equal(report.decisionMatches, 2);
    assert.deepEqual(report.decisionDifferences, []);
    assert.deepEqual(report.missingKinds, []);
    assert.equal(report.readyForDrop, false);
    assert.deepEqual(f.captured.sourceInput.transactionHashes,
      rows.map((row) => row.transaction_hash));
    for (const sql of f.queries) assert.doesNotMatch(sql, /\b(?:DROP|UPDATE|DELETE|INSERT)\b/i);
  });

  it('reports decision drift and rejects incomplete population', async () => {
    const drift = await main(['--day=2026-07-19'], fixture({ drift: true }));
    assert.equal(drift.decisionMatches, 1);
    assert.equal(drift.decisionDifferences[0].storedKind, 'unknown');
    assert.equal(drift.decisionDifferences[0].replayedKind, 'mint');
    await assert.rejects(main(['--day=2026-07-19'], fixture({ count: '3' })),
      /population differs/);
    assert.throws(() => parseArgs(['--day=2026-07-18']), /requires/);
    assert.equal(sourceInput(rows).fromBlock, '100');
  });
});
