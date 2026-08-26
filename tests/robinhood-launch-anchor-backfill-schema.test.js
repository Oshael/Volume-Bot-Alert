const assert = require('node:assert/strict');
const { test } = require('node:test');

const stage166 = require('../src/utils/db-init-stage166');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

test('adds resumable launch-anchor campaigns without starting a backfill', () => {
  const sql = stage166.STATEMENTS.join('\n');
  const group = SCHEMA_GROUPS.find(({ key }) => (
    key === 'stage166-robinhood-launch-anchor-backfill-control'
  ));

  assert.match(sql, /robinhood_launch_anchor_backfill_runs/);
  assert.match(sql, /robinhood_launch_anchor_backfill_targets/);
  assert.match(sql, /source_through_block/);
  assert.match(sql, /source_through_hash/);
  assert.match(sql, /status IN \('pending', 'leased', 'completed', 'unavailable', 'failed'\)/);
  assert.match(sql, /idx_rh_launch_anchor_backfill_targets_claim/);
  assert.match(sql, /anchors_written BETWEEN 0 AND 1/);
  assert.doesNotMatch(sql, /INSERT INTO|\bUPDATE\b|DELETE FROM/i);
  assert.equal(group.repair, 'node src/utils/db-init-stage166.js');
});
