const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const stage73 = require('../src/utils/db-init-stage73');
const stage75 = require('../src/utils/db-init-stage75');
const { SCHEMA_GROUPS, getGroupsForProfile } = require('../src/utils/runtime-schema');

describe('workspace window metric schema', () => {
  it('adds coverage provenance without rewriting legacy metric values', () => {
    const sql = stage73.STATEMENTS.join('\n');
    assert.match(sql, /ALTER TABLE token_market_volume_buckets_1m/);
    assert.match(sql, /window_coverage JSONB NOT NULL DEFAULT '\{\}'::jsonb/);
    assert.match(sql, /jsonb_typeof\(window_coverage\) = 'object'/);
    assert.match(sql, /NOT VALID/);
    assert.doesNotMatch(sql, /UPDATE token_market_volume_buckets_1m/);
    assert.doesNotMatch(sql, /CREATE (?:UNIQUE )?INDEX|DROP\s+(?:COLUMN|TABLE)/i);
  });

  it('keeps runtime repair and constraint checks synchronized', () => {
    const group = SCHEMA_GROUPS.find((entry) => (
      entry.key === 'stage73-rolling-volume-coverage'
    ));
    assert.equal(group.repair, 'node src/utils/db-init-stage73.js');
    assert.deepEqual(group.tables[0].columns, ['window_coverage']);
    assert.equal(
      group.tables[0].constraints[0].name,
      'token_market_volume_buckets_1m_window_coverage_check',
    );
  });

  it('constrains coverage keys, states, and structured sources without a table scan', () => {
    const sql = stage75.STATEMENTS.join('\n');
    const group = SCHEMA_GROUPS.find((entry) => (
      entry.key === 'stage75-structured-volume-coverage'
    ));

    assert.match(sql, /window_coverage - ARRAY\['1m', '5m', '1h', '6h', '24h'\]/);
    assert.match(sql, /'complete', 'partial', 'unavailable'/);
    assert.match(sql, /\? 'state'/);
    assert.match(sql, /\? 'source'/);
    assert.match(sql, /NOT VALID/);
    assert.doesNotMatch(sql, /UPDATE token_market_volume_buckets_1m/);
    assert.equal(group.repair, 'node src/utils/db-init-stage75.js');
  });

  it('requires rolling-volume coverage in the real test schema profile', () => {
    const keys = getGroupsForProfile('test').map((group) => group.key);
    assert.deepEqual(keys, [
      'core-auth-billing',
      'stage48-user-custom-alert-rules',
      'stage63-robinhood-persistence-control-plane',
      'stage73-rolling-volume-coverage',
      'stage74-robinhood-coverage-origin',
      'stage75-structured-volume-coverage',
      'stage76-custom-alert-capabilities',
      'stage77-chain-scoped-alert-state',
    ]);
  });
});
