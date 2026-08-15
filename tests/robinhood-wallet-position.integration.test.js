process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const { createRobinhoodWalletPositionRepository } = require('../src/models/robinhood-wallet-position');
const {
  createRobinhoodWalletSwapRepository,
} = require('../src/models/robinhood-wallet-swap-persistence');
const stage90 = require('../src/utils/db-init-stage90');
const stage109 = require('../src/utils/db-init-stage109');
const stage116 = require('../src/utils/db-init-stage116');
const stage126 = require('../src/utils/db-init-stage126');
const stage127 = require('../src/utils/db-init-stage127');
const stage137 = require('../src/utils/db-init-stage137');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const VERSION = 'test_swap_only_v1';
const TOKEN = `0x${'11'.repeat(20)}`;
const WALLET = `0x${'22'.repeat(20)}`;
const OTHER_TOKEN = `0x${'33'.repeat(20)}`;
const QUOTE = `0x${'44'.repeat(20)}`;
const SWAP_HASHES = [`0x${'a1'.repeat(32)}`, `0x${'b2'.repeat(32)}`];

function swapRow(overrides = {}) {
  return {
    walletAddress: WALLET, transactionHash: SWAP_HASHES[0], actionIndex: '3',
    blockNumber: '150', blockTime: '2099-08-15T00:01:00.000Z',
    protocol: 'uniswap-v2', marketKey: `uniswap-v2:${TOKEN}:${QUOTE}`,
    tokenAddress: TOKEN, quoteAddress: QUOTE, side: 'buy',
    tokenAmountRaw: '10', quoteAmountRaw: '20', volumeUsd: '25',
    parserVersion: 'test-unified-v1', fdvUsd: '50000', ...overrides,
  };
}

async function cleanup() {
  await db.query('DELETE FROM robinhood_wallet_token_positions WHERE projection_version = $1', [VERSION]);
  await db.query('DELETE FROM robinhood_wallet_position_cursors WHERE projection_version = $1', [VERSION]);
  await db.query('DELETE FROM robinhood_holder_balances WHERE token_address = $1', [TOKEN]);
  await db.query('DELETE FROM robinhood_holder_token_states WHERE token_address = $1', [TOKEN]);
  await db.query('DELETE FROM robinhood_wallet_swaps WHERE transaction_hash = ANY($1::varchar[])',
    [SWAP_HASHES]);
  await db.query('DELETE FROM robinhood_swap_mc WHERE transaction_hash = ANY($1::varchar[])',
    [SWAP_HASHES]);
}

describe('Robinhood wallet position persistence', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage90.init({ closePool: false });
    await stage109.init({ closePool: false });
    await stage116.init({ closePool: false });
    await stage126.init({ closePool: false });
    await stage127.init({ closePool: false });
    await stage137.init({ closePool: false });
    await cleanup();
  });
  after(async () => {
    await cleanup();
    await db.pool.end();
  });

  it('registers the versioned schema without destructive SQL', () => {
    const sql = stage126.STATEMENTS.join('\n');
    assert.match(sql, /PRIMARY KEY[\s\S]+projection_version/);
    assert.doesNotMatch(sql, /DROP\s+(?:TABLE|COLUMN|CONSTRAINT|INDEX)/i);
    assert.equal(SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage126-robinhood-wallet-positions'
    )).repair, 'node src/utils/db-init-stage126.js');
  });

  it('loads every scoped swap and durable market cap from an exact range', async () => {
    const writer = createRobinhoodWalletSwapRepository({ database: db });
    await writer.insertWalletSwaps([
      swapRow(),
      swapRow({
        transactionHash: SWAP_HASHES[1], actionIndex: '4', blockNumber: '151',
        tokenAddress: OTHER_TOKEN, marketKey: `uniswap-v2:${OTHER_TOKEN}:${QUOTE}`,
        fdvUsd: '90000',
      }),
    ]);
    const repository = createRobinhoodWalletPositionRepository({ database: db });
    const swaps = await repository.readUnifiedRangeSwaps({
      fromBlock: '149', toBlock: '151',
      fromTime: '2099-08-15T00:00:00.000Z', toTime: '2099-08-15T00:02:00.000Z',
      tokenAddresses: [TOKEN],
    });

    assert.equal(swaps.length, 1);
    assert.equal(swaps[0].transaction_hash, SWAP_HASHES[0]);
    assert.equal(String(swaps[0].market_cap_usd), '50000');
    assert.equal(String(swaps[0].volume_usd), '25');
  });

  it('commits positions with the cursor and rolls back a stale writer', async () => {
    const repository = createRobinhoodWalletPositionRepository({ database: db });
    const initial = await repository.initCursor({
      projectionVersion: VERSION, stream: 'seed', nextBlock: '100', safeHead: '200',
      originBlock: '90',
      nextBlockTime: '2026-08-01T00:00:00.000Z',
    });
    assert.equal(initial.version, 0);
    assert.equal(initial.originBlock, '90');
    assert.equal(initial.nextBlockTime, '2026-08-01T00:00:00.000Z');

    const first = await repository.commitBatch({
      projectionVersion: VERSION, stream: 'seed', expectedVersion: 0,
      nextBlock: '101', safeHead: '200', checkpointBlock: '100',
      checkpointHash: `0x${'aa'.repeat(32)}`,
      positions: [{
        tokenAddress: TOKEN, walletAddress: WALLET, quantityRaw: '10',
        costBasisUsd: '25', buyVolumeUsd: '25', buyTxCount: 1,
        throughBlock: '100', throughLogIndex: '7',
      }],
    });
    assert.equal(first.committed, true);
    assert.equal(first.cursor.version, 1);

    const frontierOnly = await repository.commitBatch({
      projectionVersion: VERSION, stream: 'seed', expectedVersion: 1, nextBlock: '102',
    });
    assert.equal(frontierOnly.cursor.version, 2);
    assert.equal(frontierOnly.cursor.checkpointBlock, '100');

    const stale = await repository.commitBatch({
      projectionVersion: VERSION, stream: 'seed', expectedVersion: 1, nextBlock: '103',
      positions: [{
        tokenAddress: TOKEN, walletAddress: WALLET, quantityRaw: '99',
        costBasisUsd: '99', throughBlock: '102', throughLogIndex: '1',
      }],
    });
    assert.deepEqual(stale, { committed: false, reason: 'cursor_conflict' });

    const completed = await repository.commitBatch({
      projectionVersion: VERSION, stream: 'seed', expectedVersion: 2,
      nextBlock: '201', safeHead: '200', nextBlockTime: '2026-08-02T00:00:00.000Z',
    });
    assert.equal(completed.cursor.lifecycleState, 'complete');
    assert.equal(completed.cursor.originBlock, '90');

    const { rows } = await db.query(
      `SELECT quantity_raw::text, cost_basis_usd::text
       FROM robinhood_wallet_token_positions
       WHERE projection_version = $1 AND token_address = $2 AND wallet_address = $3`,
      [VERSION, TOKEN, WALLET]
    );
    assert.deepEqual(rows[0], { quantity_raw: '10', cost_basis_usd: '25' });

    await db.query(
      `INSERT INTO robinhood_holder_token_states (
         chain, token_address, ledger_status, live_through_block, live_through_hash
       ) VALUES ('robinhood', $1, 'live', 100, $2)`,
      [TOKEN, `0x${'bb'.repeat(32)}`]
    );
    await db.query(
      `INSERT INTO robinhood_holder_balances (
         chain, token_address, wallet_address, balance_raw, last_block_number,
         last_transaction_hash, last_log_index
       ) VALUES ('robinhood', $1, $2, 9, 100, $3, 1)`,
      [TOKEN, WALLET, `0x${'cc'.repeat(32)}`]
    );
    const reconciliation = await repository.reconcileTouchedPositions(
      VERSION, [{ tokenAddress: TOKEN, walletAddress: WALLET }], '100'
    );
    assert.equal(reconciliation.aligned, 1);
    assert.equal(reconciliation.mismatched, 1);
  });
});
