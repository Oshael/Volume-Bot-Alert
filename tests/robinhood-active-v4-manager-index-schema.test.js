const assert = require('node:assert/strict');
const { test } = require('node:test');
const stage264 = require('../src/utils/db-init-stage264');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

function migrationDatabase(states) {
  const statements = [];
  const database = {
    statements,
    async query(sql) {
      statements.push(sql);
      return { rows: sql.includes('FROM pg_index') ? states.splice(0, 1).filter(Boolean) : [] };
    },
  };
  return database;
}

test('registers the partial manager index as a runtime prerequisite', () => {
  const group = SCHEMA_GROUPS.find(({ key }) => key === 'stage264-robinhood-active-v4-manager-index');
  assert.equal(group.repair, 'node src/utils/db-init-stage264.js');
  assert.equal(group.tables[0].indexes[0].name, stage264.INDEX_NAME);
  assert.match(stage264.CREATE_STATEMENT, /CREATE INDEX CONCURRENTLY IF NOT EXISTS/);
  assert.match(stage264.CREATE_STATEMENT, /\(chain, origin_address\)/);
  assert.match(stage264.CREATE_STATEMENT,
    /WHERE active = true AND protocol = 'uniswap-v4' AND origin_address IS NOT NULL/);
});

test('recovers an interrupted concurrent build without opening a transaction', async () => {
  const database = migrationDatabase([
    { indisvalid: false, indisready: true }, { indisvalid: true, indisready: true },
  ]);
  await stage264.init({ database, closePool: false });
  assert.ok(database.statements.some((sql) => sql.startsWith('DROP INDEX CONCURRENTLY')));
  assert.ok(database.statements.includes(stage264.CREATE_STATEMENT));
  assert.equal(database.statements.some((sql) => /^(BEGIN|COMMIT)/.test(sql)), false);
});

test('rejects an index that is still invalid after building', async () => {
  const database = migrationDatabase([null, { indisvalid: false, indisready: true }]);
  await assert.rejects(stage264.init({ database, closePool: false }), /index is not ready/);
});

test('preserves an already valid index on repeated execution', async () => {
  const database = migrationDatabase([
    { indisvalid: true, indisready: true }, { indisvalid: true, indisready: true },
  ]);
  await stage264.init({ database, closePool: false });
  assert.equal(database.statements.some((sql) => sql.startsWith('DROP INDEX')), false);
});
