const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const stage143 = require('../src/utils/db-init-stage143');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

describe('Robinhood holder classification schema', () => {
  it('defines versioned evidence and independent classifier frontiers', () => {
    const sql = stage143.STATEMENTS.join('\n');
    const group = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage143-robinhood-holder-classifications'
    ));

    assert.match(sql, /CREATE TABLE IF NOT EXISTS robinhood_holder_classifications/);
    assert.match(sql, /PRIMARY KEY \(\s*chain, token_address, wallet_address, tag,/);
    assert.match(sql, /tag = 'sniper' AND reason_code = 'early_launch_buy'/);
    assert.match(sql, /'registered_token_pool', 'registered_v4_pool_manager'/);
    assert.match(sql, /jsonb_typeof\(evidence_json\) = 'object'/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS robinhood_holder_classification_states/);
    assert.match(sql, /status IN \('unavailable', 'pending', 'ready', 'stale', 'reorged'\)/);
    assert.match(sql, /\(through_block_number IS NULL\) = \(through_block_hash IS NULL\)/);
    assert.match(sql, /status IN \('ready', 'stale', 'reorged'\)/);
    assert.match(sql, /DROP CONSTRAINT IF EXISTS rh_holder_classifications_reason_check/);
    assert.doesNotMatch(sql, /DROP\s+(?:TABLE|COLUMN|INDEX)|DELETE\s+FROM/i);
    assert.equal(group.repair, 'node src/utils/db-init-stage143.js');
    assert.deepEqual(group.tables.map(({ table }) => table), [
      'robinhood_holder_classifications', 'robinhood_holder_classification_states',
    ]);
  });
});
