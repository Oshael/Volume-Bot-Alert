process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, beforeEach, describe, it } = require('node:test');

const db = require('../src/models/db');
const {
  createRobinhoodChainCaptureJournal,
} = require('../src/models/robinhood-chain-capture-journal');
const stage191 = require('../src/utils/db-init-stage191');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const PARENT = `0x${'1'.repeat(64)}`;
const HASH = `0x${'2'.repeat(64)}`;
const NEXT_HASH = `0x${'3'.repeat(64)}`;
const TX = `0x${'4'.repeat(64)}`;
const ADDRESS = `0x${'5'.repeat(40)}`;
const TOPIC = `0x${'6'.repeat(64)}`;
const OBSERVED_AT = '2026-09-03T20:00:00.000Z';

function capture(number = 100, hash = HASH, parentHash = PARENT) {
  return {
    block: {
      number, hash, parentHash, timestamp: OBSERVED_AT, finality: 'observed',
      headObservedAt: OBSERVED_AT, receiptsAvailableAt: OBSERVED_AT,
    },
    nodeHead: number + 2,
    finalizedHead: number - 2,
    transactions: [{
      hash: TX, index: 0, from: ADDRESS, to: null,
      succeeded: true, contractAddress: ADDRESS,
    }],
    events: [{
      transactionHash: TX, transactionIndex: 0, logIndex: 0,
      address: ADDRESS, topics: [TOPIC], data: '0x',
    }],
  };
}

async function clearTables() {
  await db.query('DELETE FROM robinhood_chain_capture_cursor');
  await db.query('DELETE FROM robinhood_chain_blocks');
}

describe('Robinhood canonical chain capture journal', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage191.init({ closePool: false });
  });

  beforeEach(clearTables);

  after(async () => {
    await clearTables().catch(() => {});
    await db.pool.end().catch(() => {});
  });

  it('registers the complete journal contract in the runtime schema guard', () => {
    const group = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage191-robinhood-canonical-chain-journal'
    ));
    assert.equal(group.repair, 'node src/utils/db-init-stage191.js');
    assert.deepEqual(group.tables.map(({ table }) => table), [
      'robinhood_chain_blocks', 'robinhood_chain_transactions',
      'robinhood_chain_events', 'robinhood_chain_capture_cursor',
    ]);
  });

  it('commits the block envelope, transaction, event, and cursor atomically', async () => {
    const journal = createRobinhoodChainCaptureJournal();
    assert.deepEqual(await journal.commitBlock(capture()), {
      status: 'committed', transactions: 1, events: 1,
    });

    const counts = await db.query(
      `SELECT (SELECT COUNT(*)::int FROM robinhood_chain_blocks) AS blocks,
              (SELECT COUNT(*)::int FROM robinhood_chain_transactions) AS transactions,
              (SELECT COUNT(*)::int FROM robinhood_chain_events) AS events`
    );
    assert.deepEqual(counts.rows[0], { blocks: 1, transactions: 1, events: 1 });
    const cursor = await journal.getCursor();
    assert.equal(cursor.next_block, '101');
    assert.equal(cursor.checkpoint_block, '100');
    assert.equal(cursor.checkpoint_hash, HASH);
  });

  it('accepts an exact retry but rejects gaps and parent divergence without partial writes', async () => {
    const journal = createRobinhoodChainCaptureJournal();
    await journal.commitBlock(capture());
    assert.deepEqual(await journal.commitBlock(capture()), {
      status: 'replayed', transactions: 0, events: 0,
    });
    const divergent = capture();
    divergent.events[0].data = '0x01';
    await assert.rejects(journal.commitBlock(divergent),
      (error) => error.code === 'capture_replay_conflict');
    await assert.rejects(
      journal.commitBlock(capture(102, NEXT_HASH, HASH)),
      (error) => error.code === 'capture_sequence_conflict'
    );
    await assert.rejects(
      journal.commitBlock(capture(101, NEXT_HASH, PARENT)),
      (error) => error.code === 'capture_reorg_detected'
    );
    const counts = await db.query('SELECT COUNT(*)::int AS blocks FROM robinhood_chain_blocks');
    assert.equal(counts.rows[0].blocks, 1);
    assert.equal((await journal.getCursor()).next_block, '101');
  });
});
