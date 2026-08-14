const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const stage132 = require('../src/utils/db-init-stage132');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

describe('Robinhood wallet transfer compaction watermark schema', () => {
  it('makes verified reconciliation fail closed without destructive SQL', () => {
    const sql = stage132.STATEMENTS.join('\n');
    const group = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage132-robinhood-wallet-transfer-compaction-watermarks'
    ));

    assert.match(sql, /target_classified_event_count = raw_event_count/);
    assert.match(sql, /summary_transfer_count = eligible_transfer_count/);
    assert.match(sql, /summary_amount_raw = eligible_amount_raw/);
    assert.match(sql, /summary_reconciled/);
    assert.match(sql, /position_complete AND evidence_complete AND cursor_complete/);
    assert.match(sql, /checkpoint_canonical/);
    assert.doesNotMatch(sql, /DROP\s+(?:TABLE|COLUMN|CONSTRAINT|INDEX)|DELETE\s+FROM/i);
    assert.equal(group.repair, 'node src/utils/db-init-stage132.js');
  });
});
