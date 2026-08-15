process.env.NODE_ENV = 'test';
const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const { createRobinhoodTokenTransferRepository } = require('../src/models/robinhood-token-transfer-persistence');
const { createRobinhoodWalletTransferProjectionRepository } = require('../src/models/robinhood-wallet-transfer-projection');
const { runRobinhoodWalletTransferBackfillCommit } = require('../src/services/robinhood-wallet-transfer-backfill-tick');
const stage128 = require('../src/utils/db-init-stage128');
const stage129 = require('../src/utils/db-init-stage129');
const stage130 = require('../src/utils/db-init-stage130');
const stage131 = require('../src/utils/db-init-stage131');
const stage134 = require('../src/utils/db-init-stage134');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const VERSION = 'rh_transfer_v1';
const TOKEN = `0x${'7'.repeat(40)}`;
const ALICE = `0x${'8'.repeat(40)}`;
const BOB = `0x${'9'.repeat(40)}`;
const HASH = `0x${'a'.repeat(64)}`;
const PARTITION = 'robinhood_token_transfer_events_2099_08_14';

function event(blockNumber, blockTime, suffix) {
  return {
    blockNumber: String(blockNumber), blockHash: HASH, blockTime,
    transactionHash: `0x${String(suffix).padStart(64, 'b')}`,
    transactionIndex: suffix, logIndex: suffix, tokenAddress: TOKEN,
    fromWallet: ALICE, toWallet: BOB, amountRaw: '10',
  };
}

async function cleanup() {
  await db.query('DELETE FROM robinhood_token_transfer_events WHERE token_address = $1', [TOKEN]);
  await db.query('DELETE FROM robinhood_wallet_relationship_evidence WHERE algorithm_version = $1 AND token_address = $2', [VERSION, TOKEN]);
  await db.query('DELETE FROM robinhood_wallet_transfer_edges WHERE classification_version = $1 AND token_address = $2', [VERSION, TOKEN]);
  await db.query('DELETE FROM robinhood_wallet_transfer_daily_summaries WHERE projection_version = $1 AND token_address = $2', [VERSION, TOKEN]);
  await db.query('DELETE FROM robinhood_wallet_transfer_cursors WHERE projection_version = $1', [VERSION]);
}

describe('Robinhood wallet-transfer backfill commit integration', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    for (const stage of [stage128, stage129, stage130, stage131, stage134]) {
      await stage.init({ closePool: false });
    }
    await cleanup();
  });
  after(async () => {
    await cleanup();
    await db.query(`DROP TABLE IF EXISTS ${PARTITION}`);
    await db.pool.end();
  });

  it('keeps old events summary-only and advances the seed cursor atomically', async () => {
    const captured = {
      fromBlock: '90', fromBlockTime: '2099-07-14T00:00:00.000Z',
      toBlock: '200', nextBlock: '201', scopeTokens: 1,
      checkpoint: { number: '200', hash: HASH, blockTime: '2099-08-14T12:00:00.000Z' },
      transfers: [
        event(100, '2099-07-14T12:00:00.000Z', 1),
        event(200, '2099-08-14T12:00:00.000Z', 2),
      ],
      telemetry: { requests: 1 },
    };
    const dependencies = {
      source: {
        loadBackfillPlan: async () => ({
          ready: true, status: 'uninitialized', fromBlock: '90', throughBlock: '200',
          nextBlock: '90', seed: null,
        }),
        listTrackedTokenAddresses: async () => [TOKEN],
        loadBackfillRangeContext: async () => ({
          ready: true, swaps: [], swapCoverageComplete: true,
          poolAddresses: [], routerAddresses: [], contractAddresses: [],
          walletAddresses: [ALICE, BOB],
          endpointRoleCoverage: { requested: 2, persisted: 2, unpersisted: 0, probes: 0 },
        }),
      },
      evidence: { matchesCheckpoint: async () => true, readRange: async () => captured },
      endpointRoles: { hydrate: async () => ({
        probes: 0, resolved: 0, persisted: 0,
        contractAddresses: [], walletAddresses: [],
      }) },
      raw: createRobinhoodTokenTransferRepository({ database: db }),
      projection: createRobinhoodWalletTransferProjectionRepository({ database: db }),
    };

    const result = await runRobinhoodWalletTransferBackfillCommit(dependencies, {
      now: '2099-08-14T18:00:00Z',
    });
    const raw = await db.query(
      'SELECT block_number::text FROM robinhood_token_transfer_events WHERE token_address = $1',
      [TOKEN]
    );
    const edge = await db.query(
      `SELECT transfer_count::text FROM robinhood_wallet_transfer_edges
        WHERE classification_version = $1 AND token_address = $2`, [VERSION, TOKEN]
    );
    const daily = await db.query(
      `SELECT COUNT(*)::integer AS count FROM robinhood_wallet_transfer_daily_summaries
        WHERE projection_version = $1 AND token_address = $2`, [VERSION, TOKEN]
    );
    const cursor = await db.query(
      `SELECT origin_block::text, next_block::text, safe_head::text, lifecycle_state,
              summarized_through_day::text
         FROM robinhood_wallet_transfer_cursors
        WHERE projection_version = $1 AND stream = 'seed'`, [VERSION]
    );

    assert.equal(result.status, 'complete');
    assert.equal(result.rawInserted, 1);
    assert.deepEqual(raw.rows, [{ block_number: '200' }]);
    assert.deepEqual(edge.rows, [{ transfer_count: '2' }]);
    assert.deepEqual(daily.rows, [{ count: 2 }]);
    assert.deepEqual(cursor.rows, [{
      origin_block: '90', next_block: '201', safe_head: '200',
      lifecycle_state: 'complete', summarized_through_day: '2099-08-13',
    }]);
  });
});
