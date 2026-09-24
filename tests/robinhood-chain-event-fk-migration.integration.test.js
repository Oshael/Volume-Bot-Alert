'use strict';

const assert = require('node:assert/strict');
const { after, before, it } = require('node:test');
const db = require('../src/models/db');
const stage247 = require('../src/utils/db-init-stage247');
const migration = require('../src/utils/migrate-robinhood-chain-event-fks');
const { __private: schema } = require('../src/utils/runtime-schema');
const { assertUsingTestDatabase } = require('./helpers/test-db');

before(async () => {
  await assertUsingTestDatabase(db);
  await stage247.init({ database: db, closePool: false, tablespace: 'pg_default',
    fromBlock: 0, throughBlock: 249999 });
});

after(async () => db.pool.end());

it('schema guard rejects an unvalidated replacement FK', () => {
  const requirement = { table: 'example', constraints: [{ name: 'example_fkey',
    includes: ['FOREIGN KEY'], excludes: ['NOT VALID'] }] };
  const definitions = new Map([['example_fkey', 'FOREIGN KEY (id) REFERENCES parent(id) NOT VALID']]);
  assert.deepEqual(schema.collectMissingConstraints(requirement, definitions),
    ['example.example_fkey missing unexpected NOT VALID']);
});

it('validates replacement FKs, preserves child rows, and rolls back the cutover', async () => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const before = await client.query(`SELECT
      (SELECT count(*) FROM robinhood_chain_v3_balance_snapshots) AS snapshots,
      (SELECT count(*) FROM token_launchpad_lifecycle_events) AS lifecycle`);
    const initial = await migration.inspect(client);
    assert.equal(initial.length, 3);
    assert.ok(initial.every((item) => !item.migrated));
    const prepared = await migration.prepare(client);
    assert.ok(prepared.every((item) => item.prepared));
    await assert.rejects(migration.cutover(client), /must be validated/);
    const validated = await migration.validate(client);
    assert.ok(validated.every((item) => item.validated));
    const final = await migration.cutover(client);
    assert.ok(final.every((item) => item.migrated && item.validated));
    const afterRows = await client.query(`SELECT
      (SELECT count(*) FROM robinhood_chain_v3_balance_snapshots) AS snapshots,
      (SELECT count(*) FROM token_launchpad_lifecycle_events) AS lifecycle`);
    assert.deepEqual(afterRows.rows, before.rows);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
  const restored = await migration.inspect(db);
  assert.ok(restored.every((item) => !item.migrated && !item.prepared));
});
