const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const stage155 = require('../src/utils/db-init-stage155');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

describe('Robinhood token launch-anchor cache schema', () => {
  it('adds an indexed exact-anchor projection without starting a backfill', () => {
    const sql = stage155.STATEMENTS.join('\n');
    const group = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage155-robinhood-token-launch-anchor-cache'
    ));

    assert.match(sql, /PRIMARY KEY \(chain, token_address\)/);
    assert.match(sql, /launch_block >= first_pool_block/);
    assert.match(sql, /source_through_block >= launch_block/);
    assert.doesNotMatch(sql, /INSERT INTO|UPDATE|DELETE FROM/);
    assert.equal(group.repair, 'node src/utils/db-init-stage155.js');
  });
});
