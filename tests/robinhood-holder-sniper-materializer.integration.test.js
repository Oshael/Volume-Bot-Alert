process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const {
  createRobinhoodHolderSniperMaterializer,
} = require('../src/services/robinhood-holder-sniper-materializer');
const stage143 = require('../src/utils/db-init-stage143');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const TOKEN = `0x${'6'.repeat(40)}`;
const WALLET = `0x${'7'.repeat(40)}`;
const HASH = `0x${'8'.repeat(64)}`;
const TX = `0x${'9'.repeat(64)}`;

async function cleanup() {
  await db.query('DELETE FROM robinhood_holder_classifications WHERE token_address = $1', [TOKEN]);
  await db.query('DELETE FROM robinhood_holder_classification_states WHERE token_address = $1', [TOKEN]);
}

function evidence() {
  const position = {
    walletAddress: WALLET, transactionHash: TX, actionIndex: '0', transactionIndex: '1',
    blockNumber: '101', blockHash: HASH, blockTime: '2026-08-21T12:00:05Z',
    volumeUsd: '25', evidenceVersion: 'rh_launch_v1',
  };
  return {
    ready: true, tokenAddress: TOKEN,
    frontier: { blockNumber: '200', blockHash: HASH },
    window: { maxBlocks: 3, maxSeconds: 90 },
    anchor: { ...position, blockNumber: '100', blockTime: '2026-08-21T12:00:00Z' },
    firstBuys: [{
      ...position, deltaBlocks: '1', deltaSeconds: 5, withinLaunchWindow: true,
    }],
    exclusions: [],
  };
}

describe('Robinhood holder SNIPER materializer integration', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage143.init({ closePool: false });
    await cleanup();
  });

  after(async () => {
    await cleanup();
    await db.pool.end();
  });

  it('atomically persists an idempotent explicit-threshold snapshot', async () => {
    const materializer = createRobinhoodHolderSniperMaterializer({
      minimumNotionalUsd: '10',
      source: { loadLaunchEvidence: async () => evidence() },
      database: db,
      now: () => '2026-08-21T13:00:00Z',
    });

    assert.deepEqual(await materializer.materializeToken(TOKEN), {
      status: 'published', records: 1,
    });
    assert.deepEqual(await materializer.materializeToken(TOKEN), {
      status: 'unchanged', records: 1,
    });
    const { rows } = await db.query(
      `SELECT confidence, reason_code, evidence_json, through_block_number::text
         FROM robinhood_holder_classifications
        WHERE token_address = $1 AND wallet_address = $2 AND tag = 'sniper'`,
      [TOKEN, WALLET]
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].confidence, 'high');
    assert.equal(rows[0].reason_code, 'early_launch_buy');
    assert.equal(rows[0].through_block_number, '200');
    assert.equal(rows[0].evidence_json.rule.minimumNotionalUsd, '10');
  });
});
