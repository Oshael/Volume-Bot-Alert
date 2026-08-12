const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodWalletSwapCursorRepository,
  __private: { normalizeCursor, checkpointPair, liveCheckpoint, buildRetentionGate },
} = require('../src/models/robinhood-wallet-swap-cursor');

function fakeDb(rows = []) {
  const calls = [];
  const queue = [...rows];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      const next = queue.shift();
      return { rows: next == null ? [] : (Array.isArray(next) ? next : [next]), rowCount: 0 };
    },
  };
}

const SEED_ROW = {
  chain: 'robinhood', stream: 'seed', next_block: '991040', safe_head: '24401995',
  checkpoint_block: null, checkpoint_hash: null, checkpoint_timestamp: null, version: '0',
  lifecycle_state: 'pending', state_reason: null, completed_at: null, abandoned_at: null,
  updated_at: '2026-08-12T00:00:00.000Z',
};

describe('robinhood wallet swap cursor repository', () => {
  it('normalizes a cursor row into typed fields', () => {
    const cursor = normalizeCursor({ ...SEED_ROW, version: '3' });
    assert.equal(cursor.nextBlock, '991040');
    assert.equal(cursor.safeHead, '24401995');
    assert.equal(cursor.checkpointBlock, null);
    assert.equal(cursor.lifecycleState, 'pending');
    assert.equal(cursor.updatedAt, '2026-08-12T00:00:00.000Z');
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
    const advanced = {
      ...SEED_ROW, next_block: '1000000', lifecycle_state: 'running', version: '1',
    };
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
    assert.match(database.calls[0].sql, /next_block <= \$3::bigint/);
    assert.match(database.calls[0].sql, /GREATEST\(COALESCE\(safe_head/);
    assert.match(database.calls[0].sql, /safe_head <= \$4::bigint/);
    assert.match(database.calls[0].sql, /lifecycle_state IN \('pending', 'running'\)/);
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

  it('completes or explicitly abandons seed with optimistic guards', async () => {
    const completed = {
      ...SEED_ROW, next_block: '24401996', lifecycle_state: 'complete',
      completed_at: '2026-08-12T01:00:00.000Z', version: '4',
    };
    const abandoned = {
      ...SEED_ROW, lifecycle_state: 'abandoned', state_reason: 'operator decision',
      abandoned_at: '2026-08-12T01:00:00.000Z', version: '5',
    };
    const database = fakeDb([completed, abandoned]);
    const repo = createRobinhoodWalletSwapCursorRepository({ database });

    assert.equal((await repo.completeSeed({ expectedVersion: 3 })).lifecycleState, 'complete');
    assert.match(database.calls[0].sql, /next_block > safe_head/);
    assert.equal((await repo.abandonSeed({
      expectedVersion: 4, reason: 'operator decision',
    })).stateReason, 'operator decision');
    await assert.rejects(() => repo.abandonSeed({ expectedVersion: 4 }), /requires a reason/);
  });

  it('builds a fail-closed retention gate from terminal seed and LIVE progress', () => {
    const hash = `0x${'a'.repeat(64)}`;
    const live = {
      ...SEED_ROW, stream: 'live', next_block: '201', safe_head: '200',
      checkpoint_block: '200', checkpoint_hash: hash,
      checkpoint_timestamp: '2026-08-12T00:00:00.000Z', lifecycle_state: 'running',
    };
    const completeSeed = {
      ...SEED_ROW, next_block: '24401996', lifecycle_state: 'complete',
      completed_at: '2026-08-12T00:00:00.000Z',
    };

    const gate = buildRetentionGate([completeSeed, live]);
    assert.equal(gate.valid, true);
    assert.equal(gate.consumer, 'wallet-attribution');
    assert.equal(gate.completeThroughBlock, '200');
    assert.equal(gate.sourceFrontierBlock, '200');

    assert.equal(buildRetentionGate([live]).reason, 'seed_missing');
    assert.equal(buildRetentionGate([SEED_ROW, live]).reason, 'seed_incomplete');
    assert.equal(buildRetentionGate([completeSeed]).reason, 'live_missing');
    assert.equal(buildRetentionGate([
      completeSeed, { ...live, safe_head: '199' },
    ]).reason, 'live_frontier_unproven');
    assert.equal(buildRetentionGate([
      completeSeed, live,
    ], { previousCompleteThroughBlock: '201' }).reason, 'watermark_regressed');

    const database = fakeDb([[completeSeed, live]]);
    const repo = createRobinhoodWalletSwapCursorRepository({ database });
    return repo.loadRetentionGate().then((loaded) => {
      assert.equal(loaded.completeThroughBlock, '200');
      assert.match(database.calls[0].sql, /stream IN \('seed', 'live'\)/);
    });
  });
});
