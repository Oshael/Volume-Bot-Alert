process.env.NODE_ENV = 'test';
const assert = require('node:assert/strict');
const { after, before, it } = require('node:test');

const db = require('../src/models/db');
const stage257 = require('../src/utils/db-init-stage257');
const { CHANNEL, publishRankingInvalidation, withRankingInvalidation } = require(
  '../src/models/robinhood-wallet-ranking-invalidation'
);
const { assertUsingTestDatabase } = require('./helpers/test-db');

before(async () => {
  await assertUsingTestDatabase(db);
  await stage257.init({ closePool: false });
});

it('revises a source only when the guarded cursor update succeeds', async () => {
  const client = await db.getClient();
  try {
    await client.query('CREATE TEMP TABLE ranking_cursor_test (version integer NOT NULL)');
    await client.query('INSERT INTO ranking_cursor_test VALUES (0)');
    const sql = withRankingInvalidation(
      'UPDATE ranking_cursor_test SET version=version+1 WHERE version=$1 RETURNING version',
      'swaps'
    );
    const before = await db.query(
      "SELECT version::text FROM robinhood_wallet_ranking_revisions WHERE source='swaps'"
    );
    assert.equal((await client.query(sql, [0])).rows[0].version, 1);
    assert.equal((await client.query(sql, [0])).rows.length, 0);
    const afterUpdate = await db.query(
      "SELECT version::text FROM robinhood_wallet_ranking_revisions WHERE source='swaps'"
    );
    assert.equal(BigInt(afterUpdate.rows[0].version), BigInt(before.rows[0]?.version || 0) + 1n);
  } finally {
    client.release();
  }
});
after(async () => { await db.pool.end(); });

it('delivers a versioned signal only after commit and preserves revision on rollback', async () => {
  const listener = await db.getClient();
  const writer = await db.getClient();
  const received = [];
  let resolveFirst;
  const firstNotification = new Promise((resolve) => { resolveFirst = resolve; });
  listener.on('notification', (message) => {
    received.push(message);
    resolveFirst();
  });
  try {
    await listener.query(`LISTEN ${CHANNEL}`);
    const baseline = await db.query(
      'SELECT version::text FROM robinhood_wallet_ranking_revisions WHERE source=$1',
      ['reorg']
    );
    const previous = BigInt(baseline.rows[0]?.version || 0);
    await writer.query('BEGIN');
    const committedVersion = await publishRankingInvalidation(writer, 'reorg');
    assert.equal(BigInt(committedVersion), previous + 1n);
    assert.equal(received.length, 0);
    await writer.query('COMMIT');
    await Promise.race([
      firstNotification,
      new Promise((_, reject) => setTimeout(() => reject(new Error('NOTIFY timed out')), 1000)),
    ]);
    assert.deepEqual(received.map(({ channel, payload }) => ({
      channel, payload: JSON.parse(payload),
    })), [{ channel: CHANNEL, payload: {
      chain: 'robinhood', source: 'reorg', version: committedVersion,
    } }]);

    await writer.query('BEGIN');
    await publishRankingInvalidation(writer, 'reorg');
    await writer.query('ROLLBACK');
    await listener.query('SELECT 1');
    assert.equal(received.length, 1);
    const stored = await db.query(
      'SELECT version::text FROM robinhood_wallet_ranking_revisions WHERE source=$1',
      ['reorg']
    );
    assert.equal(stored.rows[0].version, committedVersion);
  } finally {
    await writer.query('ROLLBACK').catch(() => {});
    await listener.query(`UNLISTEN ${CHANNEL}`).catch(() => {});
    listener.release();
    writer.release();
  }
});
