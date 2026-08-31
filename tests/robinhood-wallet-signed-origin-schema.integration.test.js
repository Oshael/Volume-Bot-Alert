process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const {
  createRobinhoodWalletSignedOriginRepository,
} = require('../src/models/robinhood-wallet-signed-origin');
const {
  createRobinhoodWalletSignedOriginCursorRepository,
} = require('../src/models/robinhood-wallet-signed-origin-cursor');
const stage181 = require('../src/utils/db-init-stage181');
const stage182 = require('../src/utils/db-init-stage182');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const WALLET = `0x${'9'.repeat(40)}`;
const HASH = `0x${'a'.repeat(64)}`;
const TX = `0x${'b'.repeat(64)}`;
const REPOSITORY_WALLET = `0x${'7'.repeat(40)}`;
const BOOTSTRAP_WALLET = `0x${'6'.repeat(40)}`;
const SAFE_HASH = `0x${'e'.repeat(64)}`;
const LIVE_HASH = `0x${'f'.repeat(64)}`;

function origin(blockNumber, transactionHash, overrides = {}) {
  return {
    walletAddress: REPOSITORY_WALLET, blockNumber: String(blockNumber),
    blockHash: HASH, blockTime: '2026-08-30T12:00:00Z', transactionHash,
    transactionIndex: '1', nonce: '0', coverageOriginBlock: '100',
    sourceStream: 'live', observedAt: '2026-08-30T12:01:00Z', ...overrides,
  };
}

async function cleanup() {
  await db.query("DELETE FROM robinhood_wallet_signed_origins WHERE chain = 'robinhood'");
  await db.query("DELETE FROM robinhood_wallet_signed_origin_cursors WHERE chain = 'robinhood'");
}

describe('Robinhood wallet signed origin schema', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage181.init({ closePool: false });
    await stage181.init({ closePool: false });
    await stage182.init({ closePool: false });
    await stage182.init({ closePool: false });
    await cleanup();
  });

  after(async () => {
    await cleanup();
    await db.pool.end();
  });

  it('registers both tables in the runtime schema contract', () => {
    const group = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage181-robinhood-wallet-signed-origins'
    ));
    assert.equal(group.repair, 'node src/utils/db-init-stage181.js');
    assert.deepEqual(group.tables.map(({ table }) => table), [
      'robinhood_wallet_signed_origins',
      'robinhood_wallet_signed_origin_cursors',
    ]);
    const frozen = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage182-robinhood-signed-origin-frozen-frontiers'
    ));
    assert.equal(frozen.repair, 'node src/utils/db-init-stage182.js');
  });

  it('persists a canonical origin and an ordered cursor', async () => {
    await db.query(`INSERT INTO robinhood_wallet_signed_origin_cursors (
      stream, origin_block, origin_block_hash, next_block, safe_head, safe_head_hash, checkpoint_block,
      checkpoint_hash, checkpoint_timestamp, lifecycle_state
    ) VALUES ('live', 100, $1, 111, 120, $1, 110, $1,
      '2026-08-30T12:00:00Z', 'running')`, [HASH]);
    await db.query(`INSERT INTO robinhood_wallet_signed_origins (
      wallet_address, first_block_number, first_block_hash, first_block_time,
      first_transaction_hash, first_transaction_index, first_nonce,
      coverage_origin_block, source_stream, observed_at
    ) VALUES ($1, 105, $2, '2026-08-30T11:59:55Z', $3, 2, 0,
      100, 'live', '2026-08-30T12:00:00Z')`, [WALLET, HASH, TX]);
    assert.deepEqual((await db.query(`SELECT first_block_number::text,
      first_transaction_index, first_nonce::text, coverage_origin_block::text
      FROM robinhood_wallet_signed_origins WHERE wallet_address = $1`, [WALLET])).rows[0], {
      first_block_number: '105', first_transaction_index: 2,
      first_nonce: '0', coverage_origin_block: '100',
    });
  });

  it('rejects duplicate wallets, invalid coverage, and false caught-up cursors', async () => {
    await assert.rejects(db.query(`INSERT INTO robinhood_wallet_signed_origins (
      wallet_address, first_block_number, first_block_hash, first_block_time,
      first_transaction_hash, first_transaction_index, first_nonce,
      coverage_origin_block, source_stream, observed_at
    ) VALUES ($1, 106, $2, NOW(), $3, 0, 0, 100, 'live', NOW())`,
    [WALLET, HASH, `0x${'c'.repeat(64)}`]), /rh_wallet_signed_origins_pkey/);
    await assert.rejects(db.query(`INSERT INTO robinhood_wallet_signed_origins (
      wallet_address, first_block_number, first_block_hash, first_block_time,
      first_transaction_hash, first_transaction_index, first_nonce,
      coverage_origin_block, source_stream, observed_at
    ) VALUES ($1, 99, $2, NOW(), $3, 0, 0, 100, 'seed', NOW())`,
    [`0x${'8'.repeat(40)}`, HASH, `0x${'d'.repeat(64)}`]),
    /rh_wallet_signed_origins_contract_check/);
    await assert.rejects(db.query(`INSERT INTO robinhood_wallet_signed_origin_cursors (
      stream, origin_block, origin_block_hash, next_block, safe_head, safe_head_hash,
      checkpoint_block, checkpoint_timestamp
    ) VALUES ('seed', 100, $1, 110, 120, $1, 109, NOW())`, [HASH]),
    /rh_wallet_signed_origin_cursors_checkpoint_check/);
    await assert.rejects(db.query(`INSERT INTO robinhood_wallet_signed_origin_cursors (
      stream, origin_block, origin_block_hash, next_block, safe_head, safe_head_hash, checkpoint_block,
      checkpoint_hash, checkpoint_timestamp, lifecycle_state
    ) VALUES ('seed', 100, $1, 110, 120, $1, 109, $1, NOW(), 'completed')`, [HASH]),
    /rh_wallet_signed_origin_cursors_frontier_check/);
  });

  it('keeps the earliest origin idempotently and rejects canonical conflicts', async () => {
    const repository = createRobinhoodWalletSignedOriginRepository({ database: db });
    const first = origin(120, `0x${'1'.repeat(64)}`);
    assert.deepEqual(await repository.persistOrigins([first]), {
      originsConsidered: 1, originsWritten: 1,
    });
    assert.deepEqual(await repository.persistOrigins([first]), {
      originsConsidered: 1, originsWritten: 0,
    });
    assert.equal((await repository.persistOrigins([
      origin(121, `0x${'2'.repeat(64)}`),
    ])).originsWritten, 0);
    const earlier = origin(110, `0x${'3'.repeat(64)}`);
    assert.equal((await repository.persistOrigins([earlier])).originsWritten, 1);
    await assert.rejects(repository.persistOrigins([
      origin(110, `0x${'4'.repeat(64)}`),
    ]), (error) => error.code === 'signed_origin_reorg_conflict');
    assert.deepEqual((await db.query(`SELECT first_block_number::text,
      first_transaction_hash FROM robinhood_wallet_signed_origins
      WHERE wallet_address = $1`, [REPOSITORY_WALLET])).rows[0], {
      first_block_number: '110', first_transaction_hash: earlier.transactionHash,
    });
    assert.deepEqual(await repository.persistForwardOrigins([
      origin(121, `0x${'5'.repeat(64)}`),
    ]), { originsConsidered: 1, originsWritten: 0 });
    await assert.rejects(repository.persistForwardOrigins([
      origin(109, `0x${'6'.repeat(64)}`),
    ]), (error) => error.code === 'signed_origin_reorg_conflict');
    assert.deepEqual(await repository.persistForwardOrigins([origin(122,
      `0x${'7'.repeat(64)}`, { walletAddress: `0x${'5'.repeat(40)}` })]),
    { originsConsidered: 1, originsWritten: 1 });
  });

  it('freezes frontiers and commits origins with the cursor atomically', async () => {
    const repository = createRobinhoodWalletSignedOriginCursorRepository({ database: db });
    const plan = { stream: 'seed', originBlock: '100', originBlockHash: HASH,
      safeHead: '102', safeHeadHash: SAFE_HASH };
    const initial = await repository.createOrResume(plan);
    assert.deepEqual([initial.nextBlock, initial.version], ['100', 0]);
    assert.equal((await repository.createOrResume(plan)).nextBlock, '100');
    await assert.rejects(repository.createOrResume({ ...plan, originBlockHash: SAFE_HASH }),
      (error) => error.code === 'signed_origin_cursor_conflict');
    const firstOrigin = origin(100, `0x${'5'.repeat(64)}`, {
      walletAddress: BOOTSTRAP_WALLET, transactionIndex: '0', sourceStream: 'seed',
    });
    const advanced = await repository.commitBatch({
      stream: 'seed', expectedVersion: 0, expectedNextBlock: '100', origins: [firstOrigin],
      blocks: [{ number: '100', hash: HASH, blockTime: firstOrigin.blockTime },
        { number: '101', hash: HASH, blockTime: firstOrigin.blockTime }],
    });
    assert.deepEqual([advanced.cursor.nextBlock, advanced.cursor.version,
      advanced.cursor.lifecycleState], ['102', 1, 'running']);
    await assert.rejects(repository.commitBatch({
      stream: 'seed', expectedVersion: 0, expectedNextBlock: '102', origins: [],
      blocks: [{ number: '102', hash: SAFE_HASH, blockTime: firstOrigin.blockTime }],
    }), (error) => error.code === 'signed_origin_cursor_conflict');
    await assert.rejects(repository.commitBatch({
      stream: 'seed', expectedVersion: 1, expectedNextBlock: '102',
      origins: [{ ...firstOrigin, blockNumber: '102', blockHash: SAFE_HASH }],
      blocks: [{ number: '102', hash: SAFE_HASH, blockTime: firstOrigin.blockTime }],
    }), (error) => error.code === 'signed_origin_reorg_conflict');
    assert.equal((await repository.loadCursor()).nextBlock, '102');
    const completed = await repository.commitBatch({
      stream: 'seed', expectedVersion: 1, expectedNextBlock: '102', origins: [],
      blocks: [{ number: '102', hash: SAFE_HASH, blockTime: firstOrigin.blockTime }],
    });
    assert.deepEqual([completed.cursor.nextBlock, completed.cursor.lifecycleState],
      ['103', 'completed']);
  });

  it('hands completed seed coverage to LIVE and advances its moving frontier', async () => {
    await cleanup();
    const repository = createRobinhoodWalletSignedOriginCursorRepository({ database: db });
    const plan = { stream: 'seed', originBlock: '100', originBlockHash: HASH,
      safeHead: '101', safeHeadHash: SAFE_HASH };
    await repository.createOrResume(plan);
    const seed = await repository.commitBatch({ stream: 'seed', expectedVersion: 0,
      expectedNextBlock: '100', origins: [], blocks: [
        { number: '100', hash: HASH, blockTime: '2026-08-30T12:00:00Z' },
        { number: '101', hash: SAFE_HASH, blockTime: '2026-08-30T12:00:01Z' },
      ] });
    assert.equal(seed.cursor.lifecycleState, 'completed');
    const live = await repository.initializeLiveFromSeed();
    assert.deepEqual([live.nextBlock, live.safeHead, live.lifecycleState],
      ['102', '101', 'caught_up']);
    const advanced = await repository.commitLiveBatch({ expectedVersion: 0,
      expectedNextBlock: '102', safeHead: '103', safeHeadHash: LIVE_HASH, origins: [],
      blocks: [
        { number: '102', hash: HASH, blockTime: '2026-08-30T12:00:02Z' },
        { number: '103', hash: LIVE_HASH, blockTime: '2026-08-30T12:00:03Z' },
      ] });
    assert.deepEqual([advanced.cursor.nextBlock, advanced.cursor.safeHead,
      advanced.cursor.lifecycleState], ['104', '103', 'caught_up']);
    await assert.rejects(repository.commitLiveBatch({ expectedVersion: 1,
      expectedNextBlock: '104', safeHead: '102', safeHeadHash: HASH, origins: [],
      blocks: [{ number: '104', hash: HASH, blockTime: '2026-08-30T12:00:04Z' }],
    }), (error) => error.code === 'persistent_reorg' && error.fatal === true);
    assert.equal((await repository.loadCursor('live')).nextBlock, '104');
  });
});
