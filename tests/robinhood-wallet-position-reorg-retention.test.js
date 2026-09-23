'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  createRobinhoodWalletPositionReorg,
} = require('../src/models/robinhood-wallet-position-reorg');

test('unified position rollback stops before replay when older raw was dropped', async () => {
  const queries = [];
  const client = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.includes('FROM robinhood_wallet_position_cursors live')) {
        return { rows: [{
          projection_version: 'unified_transfer_v1',
          next_block: '103', checkpoint_block: '102',
          checkpoint_hash: `0x${'a'.repeat(64)}`,
          lifecycle_state: 'running', seed_state: 'complete',
          checkpoint_canonical: true, version: '1',
        }] };
      }
      if (sql.includes('FROM robinhood_wallet_transfer_compaction_watermarks')) {
        return { rowCount: 1, rows: [{ partition_day: '2026-07-18' }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const range = {
    ancestorBlock: '100', fromBlock: '101', throughBlock: '102',
    ancestorTimestamp: '2026-09-23T00:00:00Z',
    fromTimestamp: '2026-09-23T00:00:01Z',
    throughTimestamp: '2026-09-23T00:00:02Z',
  };

  await assert.rejects(
    createRobinhoodWalletPositionReorg().rollback(client, range),
    { code: 'archive_required', message: /dropped day 2026-07-18/ }
  );
  assert.equal(queries.length, 2);
  assert.match(queries[1].sql, /partition_day <=/);
  assert.deepEqual(queries[1].params, ['robinhood', range.ancestorTimestamp]);
});
