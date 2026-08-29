const assert = require('node:assert/strict');
const { test } = require('node:test');

const stage170 = require('../src/utils/db-init-stage170');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

test('adds resumable token-scoped unified-position repair coverage', () => {
  const sql = stage170.STATEMENTS.join('\n');
  const group = SCHEMA_GROUPS.find(({ key }) => (
    key === 'stage170-robinhood-position-token-repair-coverage'
  ));
  assert.match(sql, /robinhood_wallet_position_token_coverage/);
  assert.match(sql, /unified_transfer_token_repair_v1/);
  assert.match(sql, /next_block BETWEEN source_from_block AND source_through_block \+ 1/);
  assert.match(sql, /status = 'leased'.*lease_owner IS NOT NULL/s);
  assert.match(sql, /published_at IS NULL OR.*status = 'complete'/s);
  assert.doesNotMatch(sql, /INSERT INTO|\bUPDATE\b|DELETE FROM|DROP\s+/i);
  assert.equal(group.repair, 'node src/utils/db-init-stage170.js');
});
