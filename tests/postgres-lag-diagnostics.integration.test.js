process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, test } = require('node:test');
const db = require('../src/models/db');
const { assertUsingTestDatabase } = require('./helpers/test-db');
const { CAPTURE_COMMIT_SQL } = require('../src/utils/collect-postgres-lag-diagnostics');

after(async () => { await db.pool.end(); });

test('capture COMMIT wait probe reads at most one tagged backend', async () => {
  await assertUsingTestDatabase(db);
  const result = await db.query(CAPTURE_COMMIT_SQL);
  assert.equal(result.rowCount <= 1, true);
  if (result.rowCount) assert.equal(typeof result.rows[0].value.pid, 'number');
});
