const assert = require('node:assert/strict');
const { it } = require('node:test');
const stage175 = require('../src/utils/db-init-stage175');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

it('registers the public token-scoped BUNDLED contract', () => {
  const sql = stage175.STATEMENTS.join('\n');
  const group = SCHEMA_GROUPS.find(({ key }) => (
    key === 'stage175-robinhood-public-bundled-contract'
  ));
  assert.match(sql, /tag = 'bundled'.*connected_funding_launch_cluster/s);
  assert.match(sql, /classifier IN \([^)]*'bundled'/s);
  assert.equal(group.repair, 'node src/utils/db-init-stage175.js');
});
