'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  createRobinhoodWalletPositionReorg,
} = require('../src/models/robinhood-wallet-position-reorg');
const {
  __private: { coveredMarkers },
} = require('../src/models/robinhood-wallet-position-preimage-recovery');

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
      if (sql.includes('FROM robinhood_wallet_position_reorg_preimages marker')) {
        return { rows: [] };
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
    { code: 'archive_required', message: /position preimage gap/ }
  );
  assert.equal(queries.length, 3);
  assert.match(queries[1].sql, /partition_day <=/);
  assert.deepEqual(queries[1].params, ['robinhood', range.ancestorTimestamp]);
});

test('preimage coverage accepts a batch crossing the ancestor and rejects gaps', () => {
  const markers = [
    { from_block: '110', through_block: '119' },
    { from_block: '100', through_block: '109' },
  ];
  assert.deepEqual(coveredMarkers(markers, '105', '119'), markers);
  assert.deepEqual(coveredMarkers(markers, '112', '119'), [markers[0]]);
  assert.throws(() => coveredMarkers([markers[0]], '105', '119'), {
    code: 'archive_required', message: /gap at block 109/,
  });
  assert.throws(() => coveredMarkers([
    markers[0], { from_block: '100', through_block: '108' },
  ], '105', '119'), { code: 'archive_required', message: /gap at block 109/ });
});

test('dropped-history rollback restores a covered LIVE batch without scanning old raw', async () => {
  const queries = [];
  const hash = `0x${'a'.repeat(64)}`;
  const client = {
    async query(sql) {
      queries.push(sql);
      if (sql.includes('FROM robinhood_wallet_position_cursors live')) return { rows: [{
        projection_version: 'unified_transfer_v1', next_block: '103',
        checkpoint_block: '102', checkpoint_hash: hash, lifecycle_state: 'running',
        seed_state: 'complete', checkpoint_canonical: true, version: '1',
      }] };
      if (sql.includes('FROM robinhood_wallet_transfer_compaction_watermarks')) {
        return { rows: [{ partition_day: '2026-07-18' }] };
      }
      if (sql.includes('FROM robinhood_wallet_position_reorg_preimages marker')) {
        return { rows: [{ from_block: '101', through_block: '102',
          checkpoint_hash: hash, from_time: '2026-09-23T00:00:01Z' }] };
      }
      if (sql.includes('WITH affected AS MATERIALIZED')) return { rows: [{
        token_address: `0x${'1'.repeat(40)}`,
        wallet_address: `0x${'2'.repeat(40)}`,
      }] };
      if (sql.includes('SELECT DISTINCT preimage.identity_key')) return { rows: [{
        identity_key: `0x${'1'.repeat(40)}:0x${'2'.repeat(40)}`,
      }] };
      if (sql.includes('SELECT split_part(identity_key')) return { rows: [{
        token_address: `0x${'1'.repeat(40)}`,
        wallet_address: `0x${'2'.repeat(40)}`,
      }] };
      if (sql.includes('SELECT 1 FROM robinhood_wallet_position_reorg_preimages')) {
        return { rowCount: 0 };
      }
      if (sql.startsWith('DELETE FROM robinhood_wallet_token_positions')) {
        return { rowCount: 1 };
      }
      if (sql.startsWith('INSERT INTO robinhood_wallet_token_positions')) {
        return { rowCount: 1 };
      }
      if (sql.startsWith('DELETE FROM robinhood_wallet_position_reorg_preimages')) {
        return { rowCount: 2 };
      }
      if (sql.startsWith('UPDATE robinhood_wallet_position_cursors')) {
        return { rowCount: 1 };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const summary = await createRobinhoodWalletPositionReorg().rollback(client, {
    ancestorBlock: '100', ancestorHash: `0x${'b'.repeat(64)}`,
    ancestorTimestamp: '2026-09-23T00:00:00Z',
    fromBlock: '101', throughBlock: '102',
    fromTimestamp: '2026-09-23T00:00:01Z',
    throughTimestamp: '2026-09-23T00:00:02Z',
  });
  assert.deepEqual(summary, { projections: 1, affectedPositions: 1,
    removedPositions: 1, rebuiltPositions: 1, cursorsRewound: 1 });
  assert.equal(queries.some((sql) => sql.includes('SELECT DISTINCT transfer.*')), false);
});
