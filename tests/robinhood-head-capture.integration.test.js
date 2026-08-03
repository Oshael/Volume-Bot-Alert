process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, beforeEach, describe, it } = require('node:test');

const db = require('../src/models/db');
const {
  createRobinhoodHeadCaptureRepository,
} = require('../src/models/robinhood-head-capture');
const stage103 = require('../src/utils/db-init-stage103');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const HASH_A = `0x${'a'.repeat(64)}`;
const HASH_B = `0x${'b'.repeat(64)}`;
const ADDRESS = `0x${'c'.repeat(40)}`;
const TOPIC = `0x${'d'.repeat(64)}`;
const CHECKPOINT_AT = '2026-08-02T12:00:00.000Z';

function buildEntry(blockNumber, logIndex = 0, overrides = {}) {
  return {
    stream: 'market',
    protocol: 'uniswap-v3',
    marketKey: 'robinhood:uniswap-v3:test',
    evidence: { v3: { tokenBalanceRaw: '10', quoteBalanceRaw: '20' } },
    log: {
      transactionHash: logIndex ? HASH_B : HASH_A,
      logIndex,
      blockNumber,
      blockHash: HASH_B,
      transactionIndex: 0,
      address: ADDRESS,
      topics: [TOPIC],
      data: '0x',
    },
    ...overrides,
  };
}

function buildCursor(nextBlock, checkpointBlock) {
  return {
    stream: 'market',
    nextBlock,
    safeHead: nextBlock,
    checkpoint: { number: checkpointBlock, hash: HASH_A, timestamp: CHECKPOINT_AT },
  };
}

async function clearTables() {
  await db.query('DELETE FROM robinhood_head_captures');
  await db.query('DELETE FROM robinhood_head_capture_cursors');
}

describe('Robinhood head capture repository integration', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage103.init({ closePool: false });
  });

  beforeEach(clearTables);

  after(async () => {
    await clearTables().catch(() => {});
    await db.pool.end().catch(() => {});
  });

  it('captures each identity once and advances the capture cursor atomically', async () => {
    const repository = createRobinhoodHeadCaptureRepository();

    const first = await repository.appendCaptures({
      entries: [buildEntry(101), buildEntry(108, 1)],
      cursor: buildCursor('109', '108'),
    });
    assert.equal(first.insertedCaptures, 2);
    assert.equal(first.duplicateCaptures, 0);

    const cursor = await repository.getCaptureCursor('market');
    assert.equal(cursor.nextBlock, '109');
    assert.equal(cursor.checkpointBlock, '108');
    assert.equal(cursor.version, 0);
  });

  it('treats a replayed range as an idempotent duplicate and bumps only the cursor version', async () => {
    const repository = createRobinhoodHeadCaptureRepository();
    const input = {
      entries: [buildEntry(101), buildEntry(108, 1)],
      cursor: buildCursor('109', '108'),
    };

    await repository.appendCaptures(input);
    const replay = await repository.appendCaptures(input);
    assert.equal(replay.insertedCaptures, 0);
    assert.equal(replay.duplicateCaptures, 2);

    const rows = await db.query('SELECT COUNT(*)::int AS total FROM robinhood_head_captures');
    assert.equal(rows.rows[0].total, 2);
    const cursor = await repository.getCaptureCursor('market');
    assert.equal(cursor.version, 1);
  });

  it('never regresses the capture cursor below its persisted next block', async () => {
    const repository = createRobinhoodHeadCaptureRepository();
    await repository.appendCaptures({ entries: [buildEntry(200)], cursor: buildCursor('210', '209') });
    await repository.appendCaptures({ entries: [], cursor: buildCursor('150', '149') });

    const cursor = await repository.getCaptureCursor('market');
    assert.equal(cursor.nextBlock, '210');
  });

  it('rejects a capture whose evidence is not a JSON object without writing anything', async () => {
    const repository = createRobinhoodHeadCaptureRepository();
    await assert.rejects(
      repository.appendCaptures({
        entries: [buildEntry(300, 0, { evidence: 'not-an-object' })],
        cursor: buildCursor('301', '300'),
      }),
      /evidence must be a JSON object/
    );

    const rows = await db.query('SELECT COUNT(*)::int AS total FROM robinhood_head_captures');
    assert.equal(rows.rows[0].total, 0);
    assert.equal(await repository.getCaptureCursor('market'), null);
  });
});
