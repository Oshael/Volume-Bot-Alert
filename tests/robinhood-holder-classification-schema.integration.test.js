process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const {
  createRobinhoodHolderClassificationRepository,
} = require('../src/models/robinhood-holder-classification');
const stage143 = require('../src/utils/db-init-stage143');
const stage175 = require('../src/utils/db-init-stage175');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const TOKEN = `0x${'7'.repeat(40)}`;
const WALLET = `0x${'8'.repeat(40)}`;
const BLOCK_HASH = `0x${'9'.repeat(64)}`;
const FORK_HASH = `0x${'a'.repeat(64)}`;
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
    await stage175.init({ closePool: false });
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

  it('accepts the token-scoped BUNDLED public contract', async () => {
    await cleanup();
    await insertClassification(classification({
      tag: 'bundled', confidence: 'heuristic',
      reasonCode: 'connected_funding_launch_cluster',
    }));
    await db.query(`INSERT INTO robinhood_holder_classification_states (
      chain, token_address, classifier, classification_version, status,
      status_reason, through_block_number, through_block_hash, observed_at
    ) VALUES ('robinhood', $1, 'bundled', $2, 'ready', 'materialized', 100, $3, NOW())`,
    [TOKEN, VERSION, BLOCK_HASH]);
    assert.equal((await db.query(`SELECT COUNT(*)::integer count
      FROM robinhood_holder_classifications WHERE token_address = $1 AND tag = 'bundled'`,
    [TOKEN])).rows[0].count, 1);
    await cleanup();
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

  it('publishes snapshots atomically without regressing their frontier', async () => {
    await cleanup();
    const repository = createRobinhoodHolderClassificationRepository({ database: db });
    const input = {
      tokenAddress: TOKEN, classifier: 'sniper', status: 'ready',
      statusReason: 'materialized', throughBlockNumber: '200',
      throughBlockHash: BLOCK_HASH, observedAt: '2026-08-21T12:00:00Z',
      records: [{
        walletAddress: WALLET, confidence: 'high', reasonCode: 'early_launch_buy',
        evidence: { deltaBlocks: 1 },
      }],
    };

    assert.deepEqual(await repository.replaceClassifierSnapshot(input), {
      status: 'published', records: 1,
    });
    assert.deepEqual(await repository.replaceClassifierSnapshot({
      ...input, observedAt: '2026-08-21T12:05:00Z',
    }), { status: 'unchanged', records: 1 });
    await assert.rejects(repository.replaceClassifierSnapshot({
      ...input, records: [{
        ...input.records[0], evidence: { deltaBlocks: 2 },
      }],
    }), /Conflicting ready snapshot/);
    assert.deepEqual(await repository.replaceClassifierSnapshot({
      ...input, throughBlockNumber: '199',
    }), { status: 'stale_ignored', records: 1 });

    const stored = await repository.loadClassifierSnapshot({
      tokenAddress: TOKEN, classifier: 'sniper',
    });
    assert.equal(stored.state.throughBlockNumber, '200');
    assert.equal(stored.records.length, 1);
    assert.deepEqual(stored.records[0].evidence, { deltaBlocks: 1 });

    assert.deepEqual(await repository.replaceClassifierSnapshot({
      ...input, records: [{
        ...input.records[0], evidence: { deltaBlocks: 2 },
      }],
    }, { allowSameFrontierReplacement: true }), { status: 'published', records: 1 });
    assert.deepEqual((await repository.loadClassifierSnapshot({
      tokenAddress: TOKEN, classifier: 'sniper',
    })).records[0].evidence, { deltaBlocks: 2 });

    const reorged = {
      tokenAddress: TOKEN, classifier: 'sniper', status: 'reorged',
      statusReason: 'frontier_fork', throughBlockNumber: '200',
      throughBlockHash: FORK_HASH, observedAt: '2026-08-21T12:10:00Z', records: [],
    };
    await assert.rejects(repository.replaceClassifierSnapshot(reorged), /fork/);
    assert.deepEqual(await repository.replaceClassifierSnapshot(
      reorged, { allowForkReplacement: true }
    ), { status: 'state_updated', records: 0 });
    const quarantined = await repository.loadClassifierSnapshot({
      tokenAddress: TOKEN, classifier: 'sniper',
    });
    assert.equal(quarantined.state.status, 'reorged');
    assert.equal(quarantined.records.length, 1);

    assert.deepEqual(await repository.replaceClassifierSnapshot({
      ...input, throughBlockHash: FORK_HASH, observedAt: '2026-08-21T12:11:00Z',
      records: [{ ...input.records[0], evidence: { deltaBlocks: 2 } }],
    }), { status: 'published', records: 1 });
  });
});
