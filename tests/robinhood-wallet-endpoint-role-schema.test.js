const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const stage135 = require('../src/utils/db-init-stage135');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

describe('Robinhood wallet endpoint role schema', () => {
  it('stores one conservative role and its canonical evidence per endpoint', () => {
    const sql = stage135.STATEMENTS.join('\n');
    const group = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage135-robinhood-wallet-endpoint-roles'
    ));
    assert.match(sql, /CREATE TABLE IF NOT EXISTS robinhood_wallet_endpoint_roles/);
    assert.match(sql, /PRIMARY KEY \(chain, endpoint_address\)/);
    assert.match(sql, /endpoint_role IN \('wallet', 'contract'\)/);
    assert.match(sql, /evidence_block BETWEEN observed_from_block AND observed_through_block/);
    assert.equal(group.repair, 'node src/utils/db-init-stage135.js');
  });
});
