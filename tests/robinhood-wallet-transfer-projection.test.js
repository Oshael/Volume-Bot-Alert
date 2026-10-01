'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  createRobinhoodWalletTransferProjectionRepository,
} = require('../src/models/robinhood-wallet-transfer-projection');

const TOKEN = `0x${'1'.repeat(40)}`;
const HASH = `0x${'a'.repeat(64)}`;

function repositoryWithRecordedWrites() {
  const writes = [];
  const current = {
    projection_version: 'test_transfer_v1', stream: 'seed',
    next_block: '100', next_transaction_index: 0, next_log_index: 0,
    next_block_time: new Date('2099-01-01T00:00:00Z'),
    safe_head: '200', checkpoint_block: null, checkpoint_hash: null,
    lifecycle_state: 'running', version: '0', summarized_through_day: null,
  };
  const client = {
    release() {},
    async query(sql, params) {
      if (sql.includes('FROM robinhood_wallet_transfer_cursors') && sql.includes('FOR UPDATE')) {
        return { rows: [current] };
      }
      if (sql.includes('INSERT INTO robinhood_wallet_transfer_scan_scopes')) {
        writes.push(params);
      }
      if (sql.includes('UPDATE robinhood_wallet_transfer_cursors')) {
        return { rows: [{ ...current, next_block: '101', version: '1',
          next_block_time: new Date('2099-01-02T00:00:00Z') }] };
      }
      if (sql.includes('INSERT INTO robinhood_wallet_ranking_revisions')) {
        return { rows: [{ version: '1' }] };
      }
      return { rows: [] };
    },
  };
  const repository = createRobinhoodWalletTransferProjectionRepository({
    database: { getClient: async () => client },
  });
  return { repository, writes };
}

test('canonical transfer scans commit using the existing topic-only scope contract', async () => {
  const { repository, writes } = repositoryWithRecordedWrites();
  const result = await repository.commitBatch({
    projectionVersion: 'test_transfer_v1', stream: 'seed', expectedVersion: 0,
    nextBlock: '101', nextBlockTime: '2099-01-02T00:00:00Z',
    safeHead: '200', checkpointBlock: '100', checkpointHash: HASH,
    captureScope: { fromBlock: '100', tokenAddresses: [TOKEN],
      filterMode: 'canonical-journal' },
    events: [],
  });
  assert.equal(result.committed, true);
  assert.deepEqual(result.captureScope, { format: 'legacy', reason: 'baseline-missing' });
  assert.equal(writes.length, 1);
  assert.match(writes[0][6], /^[0-9a-f]{64}$/);
  assert.equal(writes[0][7], 'topics-only');
});

test('canonical scan with no tracked tokens advances without a scope row', async () => {
  const { repository, writes } = repositoryWithRecordedWrites();
  const result = await repository.commitBatch({
    projectionVersion: 'test_transfer_v1', stream: 'seed', expectedVersion: 0,
    nextBlock: '101', nextBlockTime: '2099-01-02T00:00:00Z',
    safeHead: '200', checkpointBlock: '100', checkpointHash: HASH,
    captureScope: { fromBlock: '100', tokenAddresses: [],
      filterMode: 'canonical-journal' },
    events: [],
  });
  assert.equal(result.committed, true);
  assert.equal(writes.length, 0);
});
