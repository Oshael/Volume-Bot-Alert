'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const stage224 = require('../src/utils/db-init-stage224');
const stage227 = require('../src/utils/db-init-stage227');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

describe('Robinhood head-state retention index replacement', () => {
  it('defines one covering replacement in the final runtime schema', () => {
    assert.equal(stage227.INDEX_NAME, 'idx_rh_head_capture_states_retention_v2');
    assert.equal(stage227.OLD_INDEX_NAME, 'idx_rh_head_capture_states_retention');
    assert.match(stage227.CREATE_STATEMENT, /CREATE INDEX CONCURRENTLY/);
    assert.match(stage227.CREATE_STATEMENT, /INCLUDE \(terminal_at\)/);
    const group = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage224-robinhood-head-capture-state'
    ));
    const names = group.tables[0].indexes.map(({ name }) => name);
    assert.ok(names.includes(stage227.INDEX_NAME));
    assert.ok(!names.includes(stage227.OLD_INDEX_NAME));
    assert.equal(stage224.INDEX_NAMES[2], stage227.INDEX_NAME);
  });

  it('builds and validates the replacement before retiring the legacy index', async () => {
    const calls = [];
    let legacyExists = true;
    const database = { async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql === 'SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass($1)') {
        return { rows: [{ indisvalid: true }] };
      }
      if (sql.includes('pg_get_indexdef')) {
        return { rows: [{
          indisvalid: true,
          indisready: true,
          definition: stage227.CREATE_STATEMENT,
        }] };
      }
      if (sql.startsWith('DROP INDEX CONCURRENTLY')) {
        legacyExists = false;
        return { rows: [] };
      }
      if (sql === 'SELECT to_regclass($1) AS index_name') {
        return { rows: [{ index_name: legacyExists ? params[0] : null }] };
      }
      return { rows: [] };
    } };
    await stage227.init({ database, closePool: false });
    const createAt = calls.findIndex(({ sql }) => sql.startsWith('CREATE INDEX'));
    const validateAt = calls.findIndex(({ sql }) => sql.includes('pg_get_indexdef'));
    const dropAt = calls.findIndex(({ sql }) => (
      sql === `DROP INDEX CONCURRENTLY IF EXISTS ${stage227.OLD_INDEX_NAME}`
    ));
    assert.ok(createAt < validateAt && validateAt < dropAt);
  });

  it('removes an invalid replacement before recreating it', async () => {
    const calls = [];
    const database = { async query(sql) {
      calls.push(sql);
      if (sql.startsWith('SELECT indisvalid')) return { rows: [{ indisvalid: false }] };
      if (sql.includes('pg_get_indexdef')) {
        return { rows: [{
          indisvalid: true, indisready: true, definition: stage227.CREATE_STATEMENT,
        }] };
      }
      if (sql.startsWith('SELECT to_regclass')) return { rows: [{ index_name: null }] };
      return { rows: [] };
    } };
    await stage227.init({ database, closePool: false });
    assert.equal(calls.filter((sql) => (
      sql === `DROP INDEX CONCURRENTLY IF EXISTS ${stage227.INDEX_NAME}`
    )).length, 1);
  });
});
