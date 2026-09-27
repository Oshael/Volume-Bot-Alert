process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const db = require('../src/models/db');
const { assertUsingTestDatabase } = require('./helpers/test-db');
const {
  createRobinhoodWalletRankingReadSnapshot,
} = require('../src/models/robinhood-wallet-ranking-read-snapshot');

describe('Robinhood ranking read snapshot', () => {
  it('keeps reads on one repeatable, read-only PostgreSQL snapshot', async () => {
    await assertUsingTestDatabase(db);
    const table = `ranking_snapshot_test_${process.pid}_${Date.now()}`;
    await db.query(`CREATE TABLE ${table} (value integer NOT NULL)`);
    try {
      await db.query(`INSERT INTO ${table} VALUES (1)`);
      const snapshot = createRobinhoodWalletRankingReadSnapshot({ database: db });
      const values = await snapshot.run(async (database) => {
        const first = await database.queryWithStatementTimeout(
          `SELECT value, current_setting('transaction_read_only') AS read_only
           FROM ${table}`, [], 5000,
        );
        await db.query(`UPDATE ${table} SET value=2`);
        const second = await database.queryWithStatementTimeout(
          `SELECT value FROM ${table}`, [], 5000,
        );
        return [first.rows[0], second.rows[0]];
      });
      assert.deepEqual(values, [{ value: 1, read_only: 'on' }, { value: 1 }]);
      const after = await db.query(`SELECT value FROM ${table}`);
      assert.equal(after.rows[0].value, 2);
      await assert.rejects(snapshot.run(async (database) => database.queryWithStatementTimeout(
        `UPDATE ${table} SET value=3`, [], 5000,
      )), /read-only transaction/);
      const unchanged = await db.query(`SELECT value FROM ${table}`);
      assert.equal(unchanged.rows[0].value, 2);
    } finally {
      await db.query(`DROP TABLE ${table}`);
    }
  });
});
