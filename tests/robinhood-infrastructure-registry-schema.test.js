const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const stage145 = require('../src/utils/db-init-stage145');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

describe('Robinhood infrastructure registry schema', () => {
  it('defines chain-scoped, evidenced validity intervals', () => {
    const sql = stage145.STATEMENTS.join('\n');
    const group = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage145-robinhood-infrastructure-registry'
    ));

    assert.match(sql, /CREATE TABLE IF NOT EXISTS robinhood_infrastructure_registry/);
    assert.match(sql, /kind IN \('cex', 'router', 'bridge', 'locker', 'burn'\)/);
    assert.match(sql, /jsonb_typeof\(evidence_json\) = 'object'/);
    assert.match(sql, /valid_through_block >= valid_from_block/);
    assert.match(sql, /WHERE valid_through_block IS NULL/);
    assert.doesNotMatch(sql, /DROP\s+|DELETE\s+FROM/i);
    assert.equal(group.repair, 'node src/utils/db-init-stage145.js');
    assert.equal(group.tables[0].table, 'robinhood_infrastructure_registry');
  });
});
