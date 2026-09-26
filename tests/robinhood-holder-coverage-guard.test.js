'use strict';

const assert = require('node:assert/strict');
const { it } = require('node:test');
const stage234 = require('../src/utils/db-init-stage234');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

it('defines a policy-gated central coverage fence', () => {
  const sql = stage234.STATEMENTS.join('\n');
  for (const pattern of [
    /capture_mode INTO effective_mode/,
    /WHERE chain = NEW\.chain FOR SHARE/,
    /ledger_status IN \('shadow', 'live'\)/,
    /manifest\.coverage_generation = NEW\.coverage_generation/,
    /NEW\.tail_capture_from_block IS NULL/,
    /NEW\.tail_capture_from_block < live_next_block/,
    /OLD\.ledger_status NOT IN \('backfilling', 'shadow', 'live'\)/,
  ]) assert.match(sql, pattern);
  assert.ok(sql.indexOf('SELECT next_block, journal_floor_block')
    < sql.indexOf('SELECT capture_mode INTO effective_mode'));
  assert.match(sql, new RegExp(`CREATE TRIGGER ${stage234.TRIGGER_NAME}`));
  assert.ok(stage234.TRIGGER_NAME > 'trg_rh_holder_legacy_coverage_invalidation');

  const group = SCHEMA_GROUPS.find(({ key }) => (
    key === 'stage234-robinhood-holder-coverage-guard'
  ));
  assert.equal(group.repair, 'node src/utils/db-init-stage234.js');
  assert.equal(group.tables[0].triggers[0].name, stage234.TRIGGER_NAME);
});
