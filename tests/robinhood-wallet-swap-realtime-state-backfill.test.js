'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const stage237 = require('../src/utils/db-init-stage237');
const stage238 = require('../src/utils/db-init-stage238');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');
const { batchSql, parseArgs } = require(
  '../src/utils/backfill-robinhood-wallet-swap-realtime-states'
);

test('wallet-swap state backfill CLI is bounded and preview-first', () => {
  assert.deepEqual(parseArgs([]), { apply: false, limit: 1000 });
  assert.deepEqual(parseArgs(['--apply', '--limit=5000']), { apply: true, limit: 5000 });
  assert.throws(() => parseArgs(['--limit=10001']), /between 1 and 10000/);
  assert.throws(() => parseArgs(['--restart']), /unknown argument/);
  assert.doesNotMatch(batchSql(false), /INSERT INTO robinhood_wallet_swap_realtime_states/);
  assert.match(batchSql(true), /ON CONFLICT \(chain, transaction_hash/);
  assert.match(batchSql(true), /WHERE state\.chain IS NULL/);
  assert.match(batchSql(true), /target_transaction_hash/);
  assert.match(batchSql(true), /<= ROW\(progress\.target_transaction_hash/);
  assert.match(batchSql(true),
    /ORDER BY transaction_hash DESC, log_index DESC, block_hash DESC, event_kind DESC LIMIT 1/);
  assert.doesNotMatch(batchSql(true), /payload/);

  const group = SCHEMA_GROUPS.find(({ key }) => (
    key === 'stage237-robinhood-wallet-swap-realtime-state-backfill'
  ));
  assert.equal(group.repair, 'node src/utils/db-init-stage237.js');
  assert.equal(group.tables[0].table, stage237.PROGRESS_TABLE);

  const targetGroup = SCHEMA_GROUPS.find(({ key }) => (
    key === 'stage238-robinhood-wallet-swap-realtime-state-target'
  ));
  assert.equal(targetGroup.repair, 'node src/utils/db-init-stage238.js');
  assert.match(stage238.STATEMENTS.join('\n'), /ORDER BY transaction_hash DESC/);
});
