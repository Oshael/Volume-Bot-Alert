process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const {
  SHADOW_VERSION,
  createRobinhoodWalletTransferTokenRepairRepository,
} = require('../src/models/robinhood-wallet-transfer-token-repair');
const stage129 = require('../src/utils/db-init-stage129');
const stage130 = require('../src/utils/db-init-stage130');
const stage131 = require('../src/utils/db-init-stage131');
const stage153 = require('../src/utils/db-init-stage153');
const stage154 = require('../src/utils/db-init-stage154');
const stage158 = require('../src/utils/db-init-stage158');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const TOKEN = `0x${'8'.repeat(40)}`;
const FROM = `0x${'6'.repeat(40)}`;
const TO = `0x${'7'.repeat(40)}`;
const HASH = `0x${'a'.repeat(64)}`;

function event(block, suffix) {
  return {
    tokenAddress: TOKEN, fromWallet: FROM, toWallet: TO,
    blockNumber: String(block), transactionIndex: 0, logIndex: 1,
    blockTime: `2026-08-24T00:0${suffix}:00.000Z`,
    transactionHash: `0x${String(suffix).repeat(64)}`,
    amountRaw: '10', transferKind: 'wallet_transfer',
    classificationVersion: 'rh_transfer_v1',
  };
}

async function cleanup() {
  await db.query(
    'DELETE FROM robinhood_wallet_relationship_evidence WHERE algorithm_version = $1 AND token_address = $2',
    [SHADOW_VERSION, TOKEN]
  );
  await db.query(
    'DELETE FROM robinhood_wallet_transfer_daily_summaries WHERE projection_version = $1 AND token_address = $2',
    [SHADOW_VERSION, TOKEN]
  );
  await db.query(
    'DELETE FROM robinhood_wallet_transfer_edges WHERE classification_version = $1 AND token_address = $2',
    [SHADOW_VERSION, TOKEN]
  );
  await db.query(
    'DELETE FROM robinhood_wallet_transfer_token_coverage WHERE token_address = $1', [TOKEN]
  );
}

describe('Robinhood wallet-transfer token repair persistence', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    for (const stage of [stage129, stage130, stage131, stage153, stage154, stage158]) {
      await stage.init({ closePool: false });
    }
    await cleanup();
  });

  after(async () => {
    await cleanup();
    await db.pool.end();
  });

  it('resumes ranges into shadow and completes only after the frozen frontier', async () => {
    await db.query(
      `INSERT INTO robinhood_wallet_transfer_token_coverage (
         token_address, source_from_block, next_block,
         source_through_block, source_through_hash
       ) VALUES ($1, 100, 100, 101, $2)`,
      [TOKEN, HASH]
    );
    const repository = createRobinhoodWalletTransferTokenRepairRepository();
    const first = await repository.claim({ owner: 'integration-owner' });
    assert.equal(first.nextBlock, '100');
    const projected = await repository.commitShadowRange({
      tokenAddress: TOKEN, owner: 'integration-owner',
      fromBlock: '100', toBlock: '100', events: [event(100, 1)],
    });
    assert.equal(projected.complete, false);
    const second = await repository.claim({ owner: 'integration-owner' });
    assert.equal(second.nextBlock, '101');
    const completed = await repository.commitShadowRange({
      tokenAddress: TOKEN, owner: 'integration-owner',
      fromBlock: '101', toBlock: '101', events: [event(101, 2)],
    });
    assert.equal(completed.complete, true);
    const result = await db.query(
      `SELECT edge.transfer_count::text, edge.first_block::text, edge.last_block::text,
              coverage.status, coverage.next_block::text
         FROM robinhood_wallet_transfer_edges edge
         JOIN robinhood_wallet_transfer_token_coverage coverage
           ON coverage.token_address = edge.token_address
        WHERE edge.classification_version = $1 AND edge.token_address = $2`,
      [SHADOW_VERSION, TOKEN]
    );
    assert.deepEqual(result.rows[0], {
      transfer_count: '2', first_block: '100', last_block: '101',
      status: 'complete', next_block: '102',
    });
  });
});
