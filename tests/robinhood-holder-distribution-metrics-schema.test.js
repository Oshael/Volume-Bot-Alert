const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const stage144 = require('../src/utils/db-init-stage144');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

describe('Robinhood holder distribution metrics schema', () => {
  it('defines versioned, fail-closed metric snapshots', () => {
    const sql = stage144.STATEMENTS.join('\n');
    const group = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage144-robinhood-holder-distribution-metrics'
    ));

    assert.match(sql, /CREATE TABLE IF NOT EXISTS robinhood_holder_distribution_metrics/);
    assert.match(sql, /'dev_hold', 'lp_locked', 'bundled'/);
    assert.match(sql, /value_numerator_raw NUMERIC\(78,0\)/);
    assert.match(sql, /status IN \('unavailable', 'pending', 'ready', 'stale', 'reorged'\)/);
    assert.match(sql, /jsonb_typeof\(evidence_json\) = 'object'/);
    assert.match(sql, /metric = 'bundled'[\s\S]+wallet_count IS NOT NULL/);
    assert.doesNotMatch(sql, /DROP\s+|DELETE\s+FROM/i);
    assert.equal(group.repair, 'node src/utils/db-init-stage144.js');
    assert.equal(group.tables[0].table, 'robinhood_holder_distribution_metrics');
  });
});
