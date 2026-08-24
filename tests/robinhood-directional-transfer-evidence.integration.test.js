process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const {
  createRobinhoodDirectionalTransferEvidenceRepository,
} = require('../src/models/robinhood-directional-transfer-evidence');
const stage129 = require('../src/utils/db-init-stage129');
const stage130 = require('../src/utils/db-init-stage130');
const stage153 = require('../src/utils/db-init-stage153');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const VERSION = 'test_directional_evidence_writer_v1';
const TOKEN = `0x${'1'.repeat(40)}`;
const ALICE = `0x${'2'.repeat(40)}`;
const BOB = `0x${'3'.repeat(40)}`;
const HASH = `0x${'a'.repeat(64)}`;

function event(blockNumber, logIndex) {
  return {
    tokenAddress: TOKEN, fromWallet: ALICE, toWallet: BOB,
    blockNumber: String(blockNumber), logIndex, blockTime: '2026-08-23T00:00:00Z',
    transactionHash: HASH, amountRaw: String(logIndex),
  };
}

async function cleanup() {
  await db.query(
    'DELETE FROM robinhood_wallet_transfer_edges WHERE classification_version = $1', [VERSION]
  );
}

describe('Robinhood directional transfer evidence persistence', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage129.init({ closePool: false });
    await stage130.init({ closePool: false });
    await stage153.init({ closePool: false });
    await cleanup();
    await db.query(
      `INSERT INTO robinhood_wallet_transfer_edges (
         chain, classification_version, token_address, from_wallet, to_wallet,
         transfer_count, total_amount_raw, wallet_transfer_count, dex_flow_count,
         first_block, first_log_index, first_seen_at, first_transaction_hash,
         last_block, last_log_index, last_seen_at, last_transaction_hash,
         largest_amount_raw, largest_log_index, largest_transaction_hash
       ) VALUES ('robinhood', $1, $2, $3, $4, 2, 5, 2, 0,
         100, 1, '2026-08-23T00:00:00Z', $5,
         101, 2, '2026-08-23T00:00:00Z', $5, 3, 2, $5)`,
      [VERSION, TOKEN, ALICE, BOB, HASH]
    );
  });

  after(async () => {
    await cleanup();
    await db.pool.end();
  });

  it('writes the canonical first event idempotently and rolls back missing edges', async () => {
    const repository = createRobinhoodDirectionalTransferEvidenceRepository({ database: db });
    assert.deepEqual(await repository.applyEvidence({
      projectionVersion: VERSION, events: [event(101, 2)],
    }), { edgesConsidered: 1, edgesWritten: 1 });
    await assert.rejects(repository.applyEvidence({
      projectionVersion: VERSION,
      events: [event(100, 1), { ...event(100, 1), toWallet: `0x${'4'.repeat(40)}` }],
    }), (error) => error.code === 'directional_replay_edge_missing'
      && error.tokenAddresses.length === 1 && error.tokenAddresses[0] === TOKEN);
    let stored = await db.query(
      `SELECT first_wallet_transfer_block::text AS block_number
         FROM robinhood_wallet_transfer_edges WHERE classification_version = $1`, [VERSION]
    );
    assert.equal(stored.rows[0].block_number, '101');
    assert.deepEqual(await repository.applyEvidence({
      projectionVersion: VERSION, events: [event(101, 2), event(100, 1)],
    }), { edgesConsidered: 1, edgesWritten: 1 });
    assert.deepEqual(await repository.applyEvidence({
      projectionVersion: VERSION, events: [event(101, 2), event(100, 1)],
    }), { edgesConsidered: 1, edgesWritten: 0 });
    stored = await db.query(
      `SELECT first_wallet_transfer_block::text AS block_number,
              first_wallet_transfer_log_index AS log_index,
              first_wallet_transfer_amount_raw::text AS amount_raw
         FROM robinhood_wallet_transfer_edges WHERE classification_version = $1`, [VERSION]
    );
    assert.deepEqual(stored.rows[0], { block_number: '100', log_index: 1, amount_raw: '1' });
  });
});
