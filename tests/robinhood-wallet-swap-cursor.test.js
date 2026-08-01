const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodWalletSwapCursorRepository,
  __private: { normalizeCursor, checkpointPair, liveCheckpoint },
} = require('../src/models/robinhood-wallet-swap-cursor');

function fakeDb(rows = []) {
  const calls = [];
  const queue = [...rows];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: queue.length ? [queue.shift()] : [], rowCount: 0 };
    },
  };
}

const SEED_ROW = {
  chain: 'robinhood', stream: 'seed', next_block: '991040', safe_head: '24401995',
  checkpoint_block: null, checkpoint_hash: null, checkpoint_timestamp: null, version: '0',
};

describe('robinhood wallet swap cursor repository', () => {
  it('normalizes a cursor row into typed fields', () => {
    const cursor = normalizeCursor({ ...SEED_ROW, version: '3' });
    assert.equal(cursor.nextBlock, '991040');
    assert.equal(cursor.safeHead, '24401995');
    assert.equal(cursor.checkpointBlock, null);
    assert.equal(cursor.version, 3);
    assert.equal(normalizeCursor(null), null);
  });

  it('rejects unknown streams', async () => {
    const repo = createRobinhoodWalletSwapCursorRepository({ database: fakeDb() });
    await assert.rejects(() => repo.loadCursor('backfill'), /stream must be one of/);
  });

  it('loads a cursor with the chain/stream key', async () => {
    const database = fakeDb([SEED_ROW]);
    const repo = createRobinhoodWalletSwapCursorRepository({ database });
    const cursor = await repo.loadCursor('seed');
    assert.match(database.calls[0].sql, /SELECT \* FROM robinhood_wallet_swap_cursors/);
    assert.deepEqual(database.calls[0].params, ['robinhood', 'seed']);
    assert.equal(cursor.nextBlock, '991040');
  });

  it('initializes idempotently with ON CONFLICT DO NOTHING', async () => {
    const database = fakeDb([SEED_ROW]); // load after insert
    const repo = createRobinhoodWalletSwapCursorRepository({ database });
    await repo.initCursor('seed', '991040', { safeHead: '24401995' });
    assert.match(database.calls[0].sql, /INSERT INTO robinhood_wallet_swap_cursors[\s\S]*ON CONFLICT \(chain, stream\) DO NOTHING/);
    assert.deepEqual(database.calls[0].params, ['robinhood', 'seed', '991040', '24401995']);
  });

  it('advances with an optimistic version guard and returns null on conflict', async () => {
    const advanced = { ...SEED_ROW, next_block: '1000000', version: '1' };
    const database = fakeDb([advanced]);
    const repo = createRobinhoodWalletSwapCursorRepository({ database });

    const ok = await repo.advanceCursor('seed', {
      nextBlock: '1000000',
      checkpointBlock: '999999',
      checkpointHash: `0x${'a'.repeat(64)}`,
      checkpointTimestamp: '2026-07-02T03:33:27.000Z',
      expectedVersion: 0,
    });
    assert.match(database.calls[0].sql, /WHERE chain = \$1 AND stream = \$2 AND version = \$8/);
    assert.equal(database.calls[0].params[7], 0); // expectedVersion
    assert.equal(ok.version, 1);

    // no row returned -> version conflict
    const conflicted = await repo.advanceCursor('seed', { nextBlock: '1000000', expectedVersion: 0 });
    assert.equal(conflicted, null);
  });

  it('requires checkpoint block and hash to be set together', () => {
    assert.throws(() => checkpointPair({ checkpointBlock: '10' }), /set together/);
    assert.throws(() => checkpointPair({ checkpointHash: `0x${'a'.repeat(64)}` }), /set together/);
    assert.deepEqual(checkpointPair({}), { checkpointBlock: null, checkpointHash: null });
  });

  it('advances the live cursor monotonically and preserves an omitted checkpoint', async () => {
    const liveRow = {
      ...SEED_ROW, stream: 'live', next_block: '102', safe_head: '120', version: '4',
    };
    const database = fakeDb([liveRow]);
    const repo = createRobinhoodWalletSwapCursorRepository({ database });

    const advanced = await repo.advanceLiveCursor({
      nextBlock: '102', safeHead: '120', expectedVersion: 3,
    });

    assert.equal(advanced.stream, 'live');
    assert.match(database.calls[0].sql, /GREATEST\(COALESCE\(safe_head/);
    assert.match(database.calls[0].sql, /checkpoint_block = COALESCE/);
    assert.match(database.calls[0].sql, /next_block <= \$3::bigint/);
    assert.deepEqual(database.calls[0].params, [
      'robinhood', 'live', '102', '120', null, null, null, 3,
    ]);
  });

  it('requires a complete live checkpoint below nextBlock', () => {
    const hash = `0x${'a'.repeat(64)}`;
    assert.throws(
      () => liveCheckpoint({ checkpointBlock: '10', checkpointHash: hash }, '11'),
      /block, hash and timestamp must be set together/
    );
    assert.throws(
      () => liveCheckpoint({
        checkpointBlock: '11', checkpointHash: hash,
        checkpointTimestamp: '2026-08-01T00:00:00.000Z',
      }, '11'),
      /must be lower than nextBlock/
    );
  });
});
