'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const stage218 = require('../src/utils/db-init-stage218');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

test('Stage 218 defines a constrained and indexed liquidity quarantine', async () => {
  const sql = stage218.STATEMENTS.join('\n');
  assert.match(sql, /status = 'quarantined'/);
  assert.match(sql, /last_error IS NOT NULL/);
  assert.match(sql, /liquidity_currency_decimals_unavailable/);
  assert.match(sql, /WHERE status = 'quarantined'/);
  const group = SCHEMA_GROUPS.find(({ key }) => (
    key === 'stage218-robinhood-liquidity-quarantine'
  ));
  assert.equal(group.repair, 'node src/utils/db-init-stage218.js');
  const calls = [];
  await stage218.init({ database: { query: async (sql) => calls.push(sql) }, closePool: false });
  assert.deepEqual(calls, stage218.STATEMENTS);
});
