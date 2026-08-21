process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const stage143 = require('../src/utils/db-init-stage143');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const TOKEN = `0x${'7'.repeat(40)}`;
const WALLET = `0x${'8'.repeat(40)}`;
const BLOCK_HASH = `0x${'9'.repeat(64)}`;
const VERSION = 'rh_holder_v1';

async function cleanup() {
  await db.query(
    'DELETE FROM robinhood_holder_classifications WHERE token_address = $1', [TOKEN]
  );
  await db.query(
    'DELETE FROM robinhood_holder_classification_states WHERE token_address = $1', [TOKEN]
  );
}

function classification(overrides = {}) {
  return {
    tag: 'sniper', confidence: 'high', reasonCode: 'early_launch_buy',
    evidence: { deltaBlocks: 1, deltaSeconds: 12 }, ...overrides,
  };
}

async function insertClassification(input = classification()) {
  return db.query(
    `INSERT INTO robinhood_holder_classifications (
       chain, token_address, wallet_address, tag, classification_version,
       confidence, reason_code, evidence_json, through_block_number,
       through_block_hash, observed_at, expires_at
     ) VALUES ('robinhood', $1, $2, $3, $4, $5, $6, $7::jsonb, 100, $8, NOW(), $9)`,
    [
      TOKEN, WALLET, input.tag, VERSION, input.confidence, input.reasonCode,
      JSON.stringify(input.evidence), BLOCK_HASH, input.expiresAt ?? null,
    ]
  );
}

describe('Robinhood holder classification schema integration', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage143.init({ closePool: false });
    await stage143.init({ closePool: false });
    await cleanup();
  });

  after(async () => {
    await cleanup();
    await db.pool.end();
  });

  it('stores versioned classification evidence and ready frontier state', async () => {
    await insertClassification();
    await db.query(
      `INSERT INTO robinhood_holder_classification_states (
         chain, token_address, classifier, classification_version, status,
         status_reason, through_block_number, through_block_hash, observed_at
       ) VALUES ('robinhood', $1, 'sniper', $2, 'ready',
         'materialized', 100, $3, NOW())`,
      [TOKEN, VERSION, BLOCK_HASH]
    );
    const stored = await db.query(
      `SELECT tag, confidence, reason_code, evidence_json, through_block_number::text
         FROM robinhood_holder_classifications WHERE token_address = $1`,
      [TOKEN]
    );

    assert.deepEqual(stored.rows, [{
      tag: 'sniper', confidence: 'high', reason_code: 'early_launch_buy',
      evidence_json: { deltaBlocks: 1, deltaSeconds: 12 }, through_block_number: '100',
    }]);
  });

  it('rejects false tags, empty evidence and incoherent frontier state', async () => {
    await assert.rejects(insertClassification(classification({
      reasonCode: 'known_cex_address',
    })), /rh_holder_classifications_reason_check/);
    await assert.rejects(insertClassification(classification({
      evidence: {},
    })), /rh_holder_classifications_evidence_check/);
    await assert.rejects(
      db.query(
        `INSERT INTO robinhood_holder_classification_states (
           chain, token_address, classifier, classification_version, status,
           status_reason, through_block_number, through_block_hash, observed_at
         ) VALUES ('robinhood', $1, 'fresh', $2, 'ready',
           'materialized', NULL, NULL, NOW())`,
        [TOKEN, VERSION]
      ),
      /rh_holder_classification_states_status_frontier_check/
    );
    await assert.rejects(
      db.query(
        `INSERT INTO robinhood_holder_classification_states (
           chain, token_address, classifier, classification_version, status,
           status_reason, through_block_number, through_block_hash, observed_at
         ) VALUES ('robinhood', $1, 'fresh', $2, 'pending',
           'awaiting_history', 100, NULL, NOW())`,
        [TOKEN, VERSION]
      ),
      /rh_holder_classification_states_frontier_pair_check/
    );
  });
});
