const assert = require('node:assert/strict');
const { it } = require('node:test');

const stage189 = require('../src/utils/db-init-stage189');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

it('registers a partial covering index for accepted FDV-reference samples', () => {
  const sql = stage189.CREATE_STATEMENT;
  const group = SCHEMA_GROUPS.find(({ key }) => (
    key === 'stage189-robinhood-fdv-reference-index'
  ));

  assert.match(sql, /CREATE INDEX CONCURRENTLY IF NOT EXISTS/);
  assert.match(sql, /\(token_address, observed_at DESC\)/);
  assert.match(sql, /INCLUDE \(fdv_usd\)/);
  assert.match(sql, /chain = 'robinhood'/);
  assert.match(sql, /status = 'accepted'/);
  assert.match(sql, /fdv_usd IS NOT NULL/);
  assert.equal(group.repair, 'node src/utils/db-init-stage189.js');
  assert.equal(group.tables[0].indexes[0].name, stage189.INDEX_NAME);
});

it('rebuilds an interrupted concurrent index before validating it', async () => {
  const calls = [];
  const database = { async query(sql) {
    calls.push(sql);
    if (sql.startsWith('SELECT indisvalid FROM')) return { rows: [{ indisvalid: false }] };
    if (sql.includes('SELECT indisvalid, indisready')) {
      return { rows: [{ indisvalid: true, indisready: true }] };
    }
    return { rows: [] };
  } };

  await stage189.init({ database, closePool: false });

  assert.equal(calls.filter((sql) => sql.startsWith('DROP INDEX CONCURRENTLY')).length, 1);
  assert.equal(calls.filter((sql) => sql.startsWith('CREATE INDEX CONCURRENTLY')).length, 1);
});
