'use strict';

const assert = require('node:assert/strict');
const { it } = require('node:test');
const stage235 = require('../src/utils/db-init-stage235');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

it('defines bounded holder capture receipts and immutable journal evidence', () => {
  const sql = stage235.STATEMENTS.join('\n');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS robinhood_holder_capture_receipts/);
  assert.match(sql, /PRIMARY KEY \(chain, block_number\)/);
  assert.match(sql, /transfer_count > 0/);
  assert.match(sql, /evidence_hash ~ '\^0x\[0-9a-f\]\{64\}\$'/);
  assert.match(sql, /Robinhood holder journal evidence is immutable/);
  assert.match(sql, new RegExp(`CREATE TRIGGER ${stage235.IMMUTABILITY_TRIGGER}`));

  const group = SCHEMA_GROUPS.find(({ key }) => (
    key === 'stage235-robinhood-holder-capture-receipts'
  ));
  assert.equal(group.repair, 'node src/utils/db-init-stage235.js');
  assert.equal(group.tables[1].triggers[0].name, stage235.IMMUTABILITY_TRIGGER);
});
