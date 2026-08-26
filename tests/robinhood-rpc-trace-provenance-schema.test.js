const assert = require('node:assert/strict');
const { it } = require('node:test');

const stage163 = require('../src/utils/db-init-stage163');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

it('registers exact RPC trace provenance and requires a factory address', () => {
  const sql = stage163.STATEMENTS.join('\n');
  const group = SCHEMA_GROUPS.find(({ key }) => (
    key === 'stage163-robinhood-rpc-trace-provenance'
  ));
  assert.match(sql, /source IN \('blockscout', 'rpc_direct', 'rpc_trace', 'launchpad_event'\)/);
  assert.match(sql, /source = 'rpc_trace'.*attribution_factory_address/s);
  assert.equal(group.repair, 'node src/utils/db-init-stage163.js');
  assert.deepEqual(group.tables[0].constraints.map(({ name }) => name), [
    'robinhood_token_attributions_source_check',
    'robinhood_token_attributions_provenance_check',
  ]);
});
