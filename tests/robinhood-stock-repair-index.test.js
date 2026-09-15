'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const stage223 = require('../src/utils/db-init-stage223');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

describe('Robinhood stock capture repair index', () => {
  it('defines a concurrent ordered partial index and runtime repair contract', () => {
    assert.match(stage223.CREATE_STATEMENT, /CREATE INDEX CONCURRENTLY IF NOT EXISTS/);
    assert.match(stage223.CREATE_STATEMENT,
      /block_number, transaction_index, log_index, transaction_hash/);
    assert.match(stage223.CREATE_STATEMENT, /INCLUDE \(protocol, market_key\)/);
    assert.match(stage223.CREATE_STATEMENT,
      /chain='robinhood' AND stream='market' AND processing_status='rejected'/);
    const group = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage223-robinhood-rejected-market-repair-index'
    ));
    assert.equal(group.repair, 'node src/utils/db-init-stage223.js');
    assert.equal(group.tables[0].indexes[0].name, stage223.INDEX_NAME);
  });

  it('rebuilds an interrupted index before asserting readiness', async () => {
    const calls = [];
    let reads = 0;
    const database = {
      pool: { end: async () => {} },
      async query(sql, params) {
        calls.push({ sql, params });
        if (/FROM pg_index/.test(sql)) {
          reads += 1;
          return { rows: [reads === 1
            ? { indisvalid: false, indisready: false }
            : { indisvalid: true, indisready: true }] };
        }
        return { rows: [] };
      },
    };

    await stage223.init({ database, closePool: false });

    assert.match(calls[1].sql, /DROP INDEX CONCURRENTLY IF EXISTS/);
    assert.equal(calls[2].sql, stage223.CREATE_STATEMENT);
    assert.equal(calls[3].params[0], stage223.INDEX_NAME);
  });
});
