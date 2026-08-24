const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const stage158 = require('../src/utils/db-init-stage158');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

describe('Robinhood token-scoped transfer coverage schema', () => {
  it('adds resumable coverage and frozen replay tokens without mutating runtime data', () => {
    const sql = stage158.STATEMENTS.join('\n');
    const group = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage158-robinhood-token-scoped-transfer-coverage'
    ));

    assert.match(sql, /robinhood_wallet_transfer_token_coverage/);
    assert.match(sql, /next_block BETWEEN source_from_block AND source_through_block \+ 1/);
    assert.match(sql, /status = 'leased'.*lease_owner IS NOT NULL/s);
    assert.match(sql, /status = 'complete'.*next_block = source_through_block \+ 1/s);
    assert.match(sql, /robinhood_directional_transfer_replay_tokens/);
    assert.match(sql, /PRIMARY KEY \(run_id, token_address\)/);
    assert.doesNotMatch(sql, /\bUPDATE\b|DELETE\s+FROM|DROP\s+/i);
    assert.equal(group.repair, 'node src/utils/db-init-stage158.js');
  });
});
