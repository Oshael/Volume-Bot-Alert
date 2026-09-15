'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const stage222 = require('../src/utils/db-init-stage222');
const {
  appendCapturedEvents, backfillRange,
} = require('../src/models/robinhood-stock-usd-reference-journal');
const v3 = require('../src/services/uniswap-v3-decoder');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

describe('Robinhood compact stock/USD reference journal', () => {
  it('defines an independent compact event table and removes the abandoned raw indexes', () => {
    const sql = stage222.STATEMENTS.join('\n');
    assert.match(sql, /CREATE TABLE IF NOT EXISTS robinhood_stock_usd_reference_events/);
    assert.match(sql, /PRIMARY KEY \([\s\S]*chain, protocol, market_key, block_hash, log_index/);
    assert.match(sql, /idx_rh_stock_usd_reference_events_canonical_lookup/);
    assert.match(sql, /WHERE canonical=TRUE/);
    const group = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage222-robinhood-stock-usd-reference-journal'
    ));
    assert.equal(group.repair, 'node src/utils/db-init-stage222.js');
    assert.equal(group.tables[0].table, stage222.TABLE);
    assert.deepEqual(stage222.LEGACY_INDEX_NAMES, [
      'idx_rh_chain_events_v2_v3_pool_tail',
      'idx_rh_chain_events_v4_pool_tail',
      'idx_rh_stock_usd_reference_events_lookup',
    ]);
  });

  it('filters live input to reference topics and keeps writes idempotent', async () => {
    const calls = [];
    const ignored = await appendCapturedEvents({ query: async () => assert.fail() }, [{
      topic0: `0x${'0'.repeat(64)}`,
    }]);
    assert.equal(ignored, 0);
    const inserted = await appendCapturedEvents({ query: async (sql, params) => {
      calls.push({ sql, params });
      return { rowCount: 1 };
    } }, [{
      topic0: v3.TOPICS.swap, block_number: '10', block_hash: `0x${'1'.repeat(64)}`,
    }]);
    assert.equal(inserted, 1);
    assert.match(calls[0].sql, /ON CONFLICT DO NOTHING/);
    assert.match(calls[0].sql, /registry\.quote_address=\$2/);
  });

  it('backfills only a bounded canonical raw range', async () => {
    const calls = [];
    await backfillRange({ fromBlock: '100', throughBlock: '200' }, {
      database: { query: async (sql, params) => {
        calls.push({ sql, params }); return { rowCount: 3 };
      } },
    });
    assert.match(calls[0].sql, /block\.canonical=TRUE/);
    assert.match(calls[0].sql, /event\.block_number BETWEEN \$1::bigint AND \$2::bigint/);
    assert.deepEqual(calls[0].params.slice(0, 2), ['100', '200']);
  });
});
