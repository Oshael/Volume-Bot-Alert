'use strict';

const assert = require('node:assert/strict');
const { after, before, it } = require('node:test');
const db = require('../src/models/db');
const stage255 = require('../src/utils/db-init-stage255');
const { assertUsingTestDatabase } = require('./helpers/test-db');

before(async () => assertUsingTestDatabase(db));
after(async () => db.pool.end());

it('persists the table-specific autovacuum settings in PostgreSQL', async () => {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    for (const statement of stage255.STATEMENTS) await client.query(statement);
    const { rows } = await client.query(`SELECT relname, reloptions
      FROM pg_class WHERE oid = ANY($1::regclass[])
      ORDER BY relname`, [stage255.TABLES.map((table) => `public.${table}`)]);
    assert.equal(rows.length, stage255.TABLES.length);
    for (const row of rows) {
      assert.ok(row.reloptions.includes('autovacuum_vacuum_threshold=350000'));
      assert.ok(row.reloptions.includes('autovacuum_vacuum_scale_factor=0'));
    }
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
});
