const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const stage131 = require('../src/utils/db-init-stage131');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

describe('Robinhood wallet transfer daily summary schema', () => {
  it('keeps per-token totals versioned, reconcilable and non-destructive', () => {
    const sql = stage131.STATEMENTS.join('\n');
    const group = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage131-robinhood-wallet-transfer-daily-summaries'
    ));

    assert.match(sql, /PRIMARY KEY \(\s*chain, projection_version, summary_day, token_address/);
    assert.match(sql, /wallet_transfer_count \+ dex_flow_count = transfer_count/);
    assert.match(sql, /wallet_transfer_amount_raw \+ dex_flow_amount_raw = total_amount_raw/);
    assert.match(sql, /through_block_time AT TIME ZONE 'UTC'\)::date = summary_day/);
    assert.doesNotMatch(sql, /DROP\s+(?:TABLE|COLUMN|CONSTRAINT|INDEX)|DELETE\s+FROM/i);
    assert.equal(group.repair, 'node src/utils/db-init-stage131.js');
    assert.deepEqual(group.tables.map(({ table }) => table), [
      'robinhood_wallet_transfer_daily_summaries',
    ]);
  });
});
