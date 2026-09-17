'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const stage236 = require('../src/utils/db-init-stage236');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

test('Stage 236 installs a narrow shadow state with atomic source synchronization', () => {
  const sql = stage236.STATEMENTS.join('\n');
  assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${stage236.STATE_TABLE}`));
  assert.match(sql, /ON DELETE CASCADE/);
  assert.match(sql, new RegExp(`CREATE TRIGGER ${stage236.SYNC_TRIGGER}`));
  assert.match(sql, /AFTER INSERT OR UPDATE OF/);
  assert.match(sql, /ON CONFLICT \(chain, transaction_hash, log_index, block_hash, event_kind\)/);
  assert.doesNotMatch(sql, /payload JSONB/);

  const group = SCHEMA_GROUPS.find(({ key }) => (
    key === 'stage236-robinhood-wallet-swap-realtime-state-shadow'
  ));
  assert.equal(group.repair, 'node src/utils/db-init-stage236.js');
  assert.equal(group.tables[0].table, stage236.STATE_TABLE);
  assert.equal(group.tables[1].triggers[0].name, stage236.SYNC_TRIGGER);
});
