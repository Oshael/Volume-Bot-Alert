process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, beforeEach, describe, it } = require('node:test');

const db = require('../src/models/db');
const {
  createRobinhoodChainCaptureJournal,
} = require('../src/models/robinhood-chain-capture-journal');
const {
  createRobinhoodChainDomainOutboxRepository,
} = require('../src/models/robinhood-chain-domain-outbox');
const stage191 = require('../src/utils/db-init-stage191');
const stage192 = require('../src/utils/db-init-stage192');
const stage193 = require('../src/utils/db-init-stage193');
const stage103 = require('../src/utils/db-init-stage103');
const v2 = require('../src/services/uniswap-v2-decoder');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const PARENT = `0x${'1'.repeat(64)}`;
const HASH = `0x${'2'.repeat(64)}`;
const NEXT_HASH = `0x${'3'.repeat(64)}`;
const TX = `0x${'4'.repeat(64)}`;
const ADDRESS = v2.ROBINHOOD_V2_FACTORY;
const TOPIC = v2.TOPICS.pairCreated;
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
      nonce: 7, valueWei: 42,
    }],
    events: [{
      transactionHash: TX, transactionIndex: 0, logIndex: 0,
      address: ADDRESS, topics: [TOPIC], data: '0x',
    }],
  };
}

async function clearTables() {
  await db.query('DELETE FROM robinhood_head_captures');
  await db.query('DELETE FROM robinhood_head_capture_cursors');
  await db.query('DELETE FROM robinhood_chain_capture_cursor');
  await db.query('DELETE FROM robinhood_chain_blocks');
}

describe('Robinhood canonical chain capture journal', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage103.init({ closePool: false });
    await stage191.init({ closePool: false });
    await stage192.init({ closePool: false });
    await stage193.init({ closePool: false });
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
    const context = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage192-robinhood-complete-transaction-context'
    ));
    assert.equal(context.repair, 'node src/utils/db-init-stage192.js');
    const outbox = SCHEMA_GROUPS.find(({ key }) => key === 'stage193-robinhood-domain-outbox');
    assert.equal(outbox.repair, 'node src/utils/db-init-stage193.js');
  });

  it('commits the block envelope, transaction, event, and cursor atomically', async () => {
    const journal = createRobinhoodChainCaptureJournal();
    assert.deepEqual(await journal.commitBlock(capture()), {
      status: 'committed', transactions: 1, events: 1, workItems: 1,
    });

    const counts = await db.query(
      `SELECT (SELECT COUNT(*)::int FROM robinhood_chain_blocks) AS blocks,
              (SELECT COUNT(*)::int FROM robinhood_chain_transactions) AS transactions,
              (SELECT COUNT(*)::int FROM robinhood_chain_events) AS events,
              (SELECT COUNT(*)::int FROM robinhood_chain_domain_outbox) AS work_items`
    );
    assert.deepEqual(counts.rows[0], {
      blocks: 1, transactions: 1, events: 1, work_items: 1,
    });
    const transactionContext = await db.query(
      `SELECT blocks.capture_version, tx.nonce::text, tx.value_wei::text
         FROM robinhood_chain_blocks blocks
         JOIN robinhood_chain_transactions tx USING (chain, block_hash)`
    );
    assert.deepEqual(transactionContext.rows[0], {
      capture_version: 2, nonce: '7', value_wei: '42',
    });
    const cursor = await journal.getCursor();
    assert.equal(cursor.next_block, '101');
    assert.equal(cursor.checkpoint_block, '100');
    assert.equal(cursor.checkpoint_hash, HASH);
  });

  it('accepts an exact retry but rejects gaps and parent divergence without partial writes', async () => {
    const journal = createRobinhoodChainCaptureJournal();
    await journal.commitBlock(capture());
    assert.deepEqual(await journal.commitBlock(capture()), {
      status: 'replayed', transactions: 0, events: 0, workItems: 0,
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

  it('leases only rows covered by the legacy cursor and protects settlement ownership', async () => {
    const journal = createRobinhoodChainCaptureJournal();
    await journal.commitBlock(capture());
    await db.query(
      `INSERT INTO robinhood_head_capture_cursors(chain, stream, next_block)
       VALUES ('robinhood', 'discovery', 101)`
    );
    const repository = createRobinhoodChainDomainOutboxRepository({ database: db });
    const [claimed] = await repository.claimShadow({
      domain: 'discovery', owner: 'shadow-a', limit: 10, leaseMs: 60_000,
    });
    assert.equal(claimed.block_number, '100');
    assert.equal(claimed.legacy_block_hash, null);
    assert.deepEqual(await repository.settle({
      owner: 'shadow-b', complete: [{
        domain: 'discovery', blockHash: HASH, logIndex: 0,
      }],
    }), { completed: 0, blocked: 0, retried: 0 });
    assert.deepEqual(await repository.settle({
      owner: 'shadow-a', complete: [{
        domain: 'discovery', blockHash: HASH, logIndex: 0,
      }],
    }), { completed: 1, blocked: 0, retried: 0 });
  });

  it('reclaims an expired lease and blocks a retry that exhausts its attempts', async () => {
    await createRobinhoodChainCaptureJournal().commitBlock(capture());
    await db.query(
      `INSERT INTO robinhood_head_capture_cursors(chain, stream, next_block)
       VALUES ('robinhood', 'discovery', 101)`
    );
    const repository = createRobinhoodChainDomainOutboxRepository({ database: db });
    await repository.claimShadow({
      domain: 'discovery', owner: 'shadow-a', limit: 10, leaseMs: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(await repository.reclaimExpiredLeases(), 1);
    await repository.claimShadow({
      domain: 'discovery', owner: 'shadow-b', limit: 10, leaseMs: 60_000,
    });
    assert.deepEqual(await repository.settle({
      owner: 'shadow-b', maxAttempts: 2, retry: [{
        domain: 'discovery', blockHash: HASH, logIndex: 0,
        error: { code: 'test_failure' }, backoffMs: 1_000,
      }],
    }), { completed: 0, blocked: 1, retried: 0 });
    const result = await db.query(
      `SELECT status, last_error FROM robinhood_chain_domain_outbox
       WHERE domain='discovery' AND block_hash=$1 AND log_index=0`, [HASH]
    );
    assert.deepEqual(result.rows[0], {
      status: 'blocked', last_error: { code: 'test_failure' },
    });
  });
});
