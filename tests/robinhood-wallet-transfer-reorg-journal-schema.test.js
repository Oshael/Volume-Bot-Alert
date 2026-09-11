'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const stage208 = require('../src/utils/db-init-stage208');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

describe('Robinhood wallet-transfer reorg journal schema', () => {
  it('keeps exact preimages for only three days', () => {
    const sql = stage208.STATEMENTS.join('\n');
    assert.equal(stage208.RETENTION_DAYS, 3);
    assert.match(sql, /previous_row JSONB/);
    assert.match(sql, /expires_at = block_time \+ INTERVAL '3 days'/);
    assert.match(sql, /block_marker/);
    assert.match(sql, /relationship_evidence/);
    assert.match(sql, /idx_rh_wallet_transfer_reorg_journal_expiry/);
  });

  it('registers Stage 208 in the runtime schema guard', () => {
    const group = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage208-robinhood-wallet-transfer-reorg-journal'
    ));
    assert.equal(group.repair, 'node src/utils/db-init-stage208.js');
    assert.deepEqual(group.tables.map(({ table }) => table), [
      'robinhood_wallet_transfer_reorg_journal',
    ]);
  });
});
