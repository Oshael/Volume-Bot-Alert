process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const { createRobinhoodWalletPositionRepository } = require('../src/models/robinhood-wallet-position');
const {
  restoreMarker,
} = require('../src/models/robinhood-wallet-position-preimage-recovery');
const {
  __private: { loadCanonicalLedger, replayCanonicalPrefix },
} = require('../src/models/robinhood-wallet-position-reorg');
const {
  createRobinhoodWalletSwapRepository,
} = require('../src/models/robinhood-wallet-swap-persistence');
const {
  createRobinhoodTransactionPositionRepository,
} = require('../src/models/robinhood-transaction-position');
const stage90 = require('../src/utils/db-init-stage90');
const stage109 = require('../src/utils/db-init-stage109');
const stage116 = require('../src/utils/db-init-stage116');
const stage126 = require('../src/utils/db-init-stage126');
const stage127 = require('../src/utils/db-init-stage127');
const stage128 = require('../src/utils/db-init-stage128');
const stage137 = require('../src/utils/db-init-stage137');
const stage139 = require('../src/utils/db-init-stage139');
const stage245 = require('../src/utils/db-init-stage245');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const VERSION = 'test_swap_only_v1';
const LIVE_VERSION = 'test_unified_live_v1';
const JOURNAL_VERSION = 'test_position_journal_v1';
const PREFIX_VERSION = 'test_position_prefix_v1';
const TOKEN = `0x${'11'.repeat(20)}`;
const WALLET = `0x${'22'.repeat(20)}`;
const OTHER_TOKEN = `0x${'33'.repeat(20)}`;
const QUOTE = `0x${'44'.repeat(20)}`;
const SWAP_HASHES = [`0x${'a1'.repeat(32)}`, `0x${'b2'.repeat(32)}`];
const PREFIX_TX = `0x${'e3'.repeat(32)}`;
const PREFIX_TOKEN = `0x${'77'.repeat(20)}`;
const PREFIX_WALLET = `0x${'88'.repeat(20)}`;

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
  const versions = [VERSION, LIVE_VERSION, JOURNAL_VERSION, PREFIX_VERSION];
  await db.query(
    'DELETE FROM robinhood_wallet_position_reorg_preimages WHERE projection_version = ANY($1::varchar[])',
    [[JOURNAL_VERSION, PREFIX_VERSION]]
  );
  await db.query(
    'DELETE FROM robinhood_wallet_token_positions WHERE projection_version = ANY($1::varchar[])',
    [versions]
  );
  await db.query(
    'DELETE FROM robinhood_wallet_position_cursors WHERE projection_version = ANY($1::varchar[])',
    [versions]
  );
  await db.query('DELETE FROM robinhood_holder_balances WHERE token_address = $1', [TOKEN]);
  await db.query('DELETE FROM robinhood_holder_token_states WHERE token_address = $1', [TOKEN]);
  await db.query('DELETE FROM robinhood_wallet_swaps WHERE transaction_hash = ANY($1::varchar[])',
    [[...SWAP_HASHES, PREFIX_TX]]);
  await db.query('DELETE FROM robinhood_swap_mc WHERE transaction_hash = ANY($1::varchar[])',
    [[...SWAP_HASHES, PREFIX_TX]]);
  await db.query(
    'DELETE FROM robinhood_transaction_positions WHERE transaction_hash = ANY($1::varchar[])',
    [[...SWAP_HASHES, PREFIX_TX]]
  );
}

describe('Robinhood wallet position persistence', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage90.init({ closePool: false });
    await stage109.init({ closePool: false });
    await stage116.init({ closePool: false });
    await stage126.init({ closePool: false });
    await stage127.init({ closePool: false });
    await stage128.init({ closePool: false });
    await stage137.init({ closePool: false });
    await stage139.init({ closePool: false });
    await stage245.init({ closePool: false });
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
    await createRobinhoodTransactionPositionRepository({ database: db }).upsertPositions([{
      transactionHash: SWAP_HASHES[0], blockNumber: '150',
      blockHash: `0x${'ee'.repeat(32)}`, transactionIndex: '2',
    }]);
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
    assert.equal(String(swaps[0].transaction_index), '2');
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

  it('captures previous LIVE positions atomically for opt-in reorg recovery', async () => {
    const repository = createRobinhoodWalletPositionRepository({
      database: db, positionPreimageEnabled: true,
    });
    await repository.initCursor({
      projectionVersion: JOURNAL_VERSION, stream: 'live', nextBlock: '100',
      nextBlockTime: '2026-08-01T00:00:00.000Z', safeHead: '102',
    });
    for (const [version, block, quantity] of [[0, 100, '10'], [1, 101, '15']]) {
      const result = await repository.commitBatch({
        projectionVersion: JOURNAL_VERSION, stream: 'live', expectedVersion: version,
        nextBlock: String(block + 1), safeHead: '102',
        checkpointBlock: String(block), checkpointHash: `0x${String(block).padStart(64, 'a')}`,
        nextBlockTime: `2026-08-01T00:0${version + 1}:00.000Z`,
        positions: [{
          tokenAddress: TOKEN, walletAddress: WALLET, quantityRaw: quantity,
          costBasisUsd: quantity, throughBlock: String(block), throughLogIndex: '1',
        }],
      });
      assert.equal(result.committed, true);
    }
    const journal = await db.query(
      `SELECT through_block::text, record_kind, had_previous,
              previous_row->>'quantity_raw' AS previous_quantity
         FROM robinhood_wallet_position_reorg_preimages
        WHERE projection_version=$1 ORDER BY through_block, record_kind`,
      [JOURNAL_VERSION]
    );
    assert.deepEqual(journal.rows, [
      { through_block: '100', record_kind: 'batch', had_previous: false,
        previous_quantity: null },
      { through_block: '100', record_kind: 'position', had_previous: false,
        previous_quantity: null },
      { through_block: '101', record_kind: 'batch', had_previous: false,
        previous_quantity: null },
      { through_block: '101', record_kind: 'position', had_previous: true,
        previous_quantity: '10' },
    ]);
    const stale = await repository.commitBatch({
      projectionVersion: JOURNAL_VERSION, stream: 'live', expectedVersion: 1,
      nextBlock: '103', safeHead: '102', checkpointBlock: '102',
      checkpointHash: `0x${'c'.repeat(64)}`,
      nextBlockTime: '2026-08-01T00:03:00.000Z',
    });
    assert.deepEqual(stale, { committed: false, reason: 'cursor_conflict' });
    const count = await db.query(
      'SELECT COUNT(*)::integer AS total FROM robinhood_wallet_position_reorg_preimages WHERE projection_version=$1',
      [JOURNAL_VERSION]
    );
    assert.equal(count.rows[0].total, 4);
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      const restored = await restoreMarker(client, { projection_version: JOURNAL_VERSION }, {
        from_block: '101', through_block: '101',
        checkpoint_hash: `0x${String(101).padStart(64, 'a')}`,
      }, { ancestorBlock: '100' });
      assert.equal(restored.removed, 1);
      assert.equal(restored.rebuilt, 1);
      assert.equal(restored.hasPrefix, false);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    const restoredPosition = await db.query(
      `SELECT quantity_raw::text FROM robinhood_wallet_token_positions
        WHERE projection_version=$1 AND token_address=$2 AND wallet_address=$3`,
      [JOURNAL_VERSION, TOKEN, WALLET]
    );
    assert.equal(restoredPosition.rows[0].quantity_raw, '10');
  });

  it('restores a crossing batch and replays only its canonical prefix', async () => {
    const repository = createRobinhoodWalletPositionRepository({
      database: db, positionPreimageEnabled: true,
    });
    await repository.initCursor({
      projectionVersion: PREFIX_VERSION, stream: 'live', nextBlock: '100',
      nextBlockTime: '2026-08-01T00:00:00.000Z', safeHead: '101',
    });
    await db.query(
      `INSERT INTO robinhood_wallet_token_positions (
         chain, projection_version, token_address, wallet_address, quantity_raw,
         cost_basis_usd, through_block, through_log_index
       ) VALUES ('robinhood',$1,$2,$3,5,5,99,1)`,
      [PREFIX_VERSION, PREFIX_TOKEN, PREFIX_WALLET]
    );
    const checkpointHash = `0x${'f'.repeat(64)}`;
    const advanced = await repository.commitBatch({
      projectionVersion: PREFIX_VERSION, stream: 'live', expectedVersion: 0,
      nextBlock: '102', safeHead: '101', checkpointBlock: '101', checkpointHash,
      nextBlockTime: '2026-08-01T00:02:00.000Z',
      positions: [{ tokenAddress: PREFIX_TOKEN, walletAddress: PREFIX_WALLET,
        quantityRaw: '25', costBasisUsd: '25', throughBlock: '101', throughLogIndex: '3' }],
    });
    assert.equal(advanced.committed, true);
    const insertedSwap = await createRobinhoodWalletSwapRepository({ database: db }).insertWalletSwaps([
      swapRow({ transactionHash: PREFIX_TX, blockNumber: '100',
        blockTime: '2026-08-01T00:01:00.000Z', tokenAmountRaw: '10',
        tokenAddress: PREFIX_TOKEN, walletAddress: PREFIX_WALLET,
        marketKey: `uniswap-v2:${PREFIX_TOKEN}:${QUOTE}`,
        volumeUsd: '10', fdvUsd: null }),
    ]);
    assert.equal(insertedSwap.inserted, 1);
    await createRobinhoodTransactionPositionRepository({ database: db }).upsertPositions([{
      transactionHash: PREFIX_TX, blockNumber: '100',
      blockHash: `0x${'e'.repeat(64)}`, transactionIndex: '0',
    }]);
    const range = {
      ancestorBlock: '100', ancestorHash: `0x${'e'.repeat(64)}`,
      ancestorTimestamp: '2026-08-01T00:01:00.000Z',
    };
    const marker = { from_block: '100', through_block: '101', checkpoint_hash: checkpointHash,
      from_time: '2026-08-01T00:01:00.000Z' };
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      const ledger = await loadCanonicalLedger(client, range, [{
        token_address: PREFIX_TOKEN, wallet_address: PREFIX_WALLET,
      }], true, { block: '100', time: marker.from_time });
      assert.equal(ledger.swaps.length, 1);
      assert.equal(ledger.transfers.length, 0);
      const restored = await restoreMarker(client, { projection_version: PREFIX_VERSION },
        marker, range);
      assert.equal(restored.hasPrefix, true);
      assert.deepEqual(restored.pairs, [{
        token_address: PREFIX_TOKEN, wallet_address: PREFIX_WALLET,
      }]);
      const replayed = await replayCanonicalPrefix(
        client, range, marker, restored.pairs, PREFIX_VERSION
      );
      assert.equal(replayed.rebuilt, 1);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    const position = await db.query(
      `SELECT quantity_raw::text, cost_basis_usd::text
         FROM robinhood_wallet_token_positions WHERE projection_version=$1`,
      [PREFIX_VERSION]
    );
    assert.deepEqual(position.rows[0], { quantity_raw: '15', cost_basis_usd: '15' });
    const journal = await db.query(
      `SELECT from_block::text, through_block::text, checkpoint_hash
         FROM robinhood_wallet_position_reorg_preimages
        WHERE projection_version=$1 AND record_kind='batch'`,
      [PREFIX_VERSION]
    );
    assert.deepEqual(journal.rows, [{ from_block: '100', through_block: '100',
      checkpoint_hash: range.ancestorHash }]);
    await db.query(
      `UPDATE robinhood_wallet_position_reorg_preimages
          SET previous_row=jsonb_set(previous_row, '{wallet_address}', to_jsonb($2::text))
        WHERE projection_version=$1 AND record_kind='position'`,
      [PREFIX_VERSION, WALLET]
    );
    await assert.rejects(restoreMarker(db, { projection_version: PREFIX_VERSION }, {
      from_block: '100', through_block: '100', checkpoint_hash: range.ancestorHash,
    }, { ancestorBlock: '99' }), {
      code: 'archive_required', message: /identity is inconsistent/,
    });
  });

  it('hands a completed seed to an independently advancing LIVE cursor', async () => {
    const repository = createRobinhoodWalletPositionRepository({ database: db });
    await repository.initCursor({
      projectionVersion: LIVE_VERSION, stream: 'seed', originBlock: '90',
      nextBlock: '90', safeHead: '90', nextBlockTime: '2026-08-01T00:00:00.000Z',
    });
    const completed = await repository.commitBatch({
      projectionVersion: LIVE_VERSION, stream: 'seed', expectedVersion: 0,
      nextBlock: '91', safeHead: '90', nextBlockTime: '2026-08-01T00:01:00.000Z',
    });
    assert.equal(completed.cursor.lifecycleState, 'complete');

    await repository.initCursor({
      projectionVersion: LIVE_VERSION, stream: 'live', originBlock: '91',
      nextBlock: '91', safeHead: '100', nextBlockTime: '2026-08-01T00:01:00.000Z',
    });
    const advanced = await repository.commitBatch({
      projectionVersion: LIVE_VERSION, stream: 'live', expectedVersion: 0,
      nextBlock: '92', safeHead: '101', checkpointBlock: '91',
      checkpointHash: `0x${'dd'.repeat(32)}`,
      nextBlockTime: '2026-08-01T00:02:00.000Z',
    });

    assert.equal(advanced.committed, true);
    assert.equal(advanced.cursor.lifecycleState, 'running');
    assert.equal(advanced.cursor.originBlock, '91');
    assert.equal((await repository.loadCursor(LIVE_VERSION, 'seed')).lifecycleState, 'complete');
  });
});
