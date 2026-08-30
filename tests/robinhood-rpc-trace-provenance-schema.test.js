const assert = require('node:assert/strict');
const { it } = require('node:test');

const stage163 = require('../src/utils/db-init-stage163');
const stage164 = require('../src/utils/db-init-stage164');
const stage165 = require('../src/utils/db-init-stage165');
const stage183 = require('../src/utils/db-init-stage183');
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

it('registers exact Blockscout internal creation provenance', () => {
  const sql = stage164.STATEMENTS.join('\n');
  const group = SCHEMA_GROUPS.find(({ key }) => (
    key === 'stage164-robinhood-blockscout-internal-provenance'
  ));
  assert.match(sql, /'blockscout_internal'/);
  assert.match(sql, /source IN \('blockscout_internal', 'rpc_trace', 'launchpad_event'\)/);
  assert.equal(group.repair, 'node src/utils/db-init-stage164.js');
});

it('registers the live catalog deployment outbox and trigger', () => {
  const sql = stage165.STATEMENTS.join('\n');
  const group = SCHEMA_GROUPS.find(({ key }) => key === 'stage165-robinhood-token-deployment-outbox');
  assert.match(sql, /AFTER INSERT ON token_catalog/);
  assert.match(sql, /pg_notify\('robinhood_token_deployment_outbox'/);
  assert.equal(group.repair, 'node src/utils/db-init-stage165.js');
});

it('registers exact pruned-RPC evidence without locking the live journal', () => {
  const sql = stage183.STATEMENTS.join('\n');
  const group = SCHEMA_GROUPS.find(({ key }) => (
    key === 'stage183-robinhood-pruned-rpc-deployment-evidence'
  ));
  assert.match(sql, /source = 'rpc_code_transition'.*creator_address IS NULL/s);
  assert.match(sql, /set_config\('lock_timeout', '2s', true\)/);
  assert.match(sql, /NOT VALID/);
  assert.doesNotMatch(sql, /robinhood_holder_transfer_journal|CREATE TRIGGER/);
  assert.equal(group.repair, 'node src/utils/db-init-stage183.js');
});
