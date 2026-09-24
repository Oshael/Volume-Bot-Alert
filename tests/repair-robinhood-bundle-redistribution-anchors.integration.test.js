'use strict';

process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');
const db = require('../src/models/db');
const {
  persistCandidate, persistObservation,
} = require('../src/utils/repair-robinhood-bundle-redistribution-anchors');
const { EVIDENCE_VERSION, RULE_VERSION } = require('../src/utils/db-init-stage188');
const stage187 = require('../src/utils/db-init-stage187');
const stage188 = require('../src/utils/db-init-stage188');
const stage241 = require('../src/utils/db-init-stage241');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const TOKEN = `0x${'7'.repeat(40)}`;
const OBSERVATION_TOKEN = `0x${'8'.repeat(40)}`;
const OBSERVATION_BLOCK = 99_124_700;
const SOURCE_BLOCK = 99_124_701;
const OBSERVATION_HASH = `0x${'6'.repeat(64)}`;
const SOURCE_HASH = `0x${'5'.repeat(64)}`;
const OBSERVATION_TIME = '2026-09-20T12:00:00.000Z';
const SOURCE_TIME = '2026-09-20T12:10:00.000Z';

async function cleanup() {
  await db.query(`DELETE FROM robinhood_bundle_redistribution_queue
    WHERE chain='robinhood' AND token_address IN ($1, $2)`, [TOKEN, OBSERVATION_TOKEN]);
  await db.query(`DELETE FROM robinhood_chain_block_anchors
    WHERE chain='robinhood' AND block_number IN ($1, $2)`,
  [OBSERVATION_BLOCK, SOURCE_BLOCK]);
}

describe('Robinhood redistribution anchor repair persistence', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage187.init({ closePool: false });
    await stage188.init({ closePool: false });
    await stage241.init({ closePool: false });
    await cleanup();
    await db.query(`INSERT INTO robinhood_bundle_redistribution_activations(
      chain, rule_version, evidence_version, status, activation_at, activation_block
    ) VALUES ('robinhood', $1, $2, 'planned', NOW(), $3)
    ON CONFLICT (chain, rule_version) DO NOTHING`,
    [RULE_VERSION, EVIDENCE_VERSION, OBSERVATION_BLOCK - 1]);
  });
  after(async () => { await cleanup(); await db.pool.end(); });

  it('atomically anchors and reopens only the exact pending queue version', async () => {
    await db.query(`INSERT INTO robinhood_bundle_redistribution_queue(
      chain, token_address, rule_version, evidence_version,
      observation_from_block, event_through_block,
      last_error_code, last_error_message
    ) VALUES ('robinhood', $1, $2, $3, $4, $5,
      'redistribution_anchor_missing', 'legacy anchor missing')`,
    [TOKEN, RULE_VERSION, EVIDENCE_VERSION, OBSERVATION_BLOCK, SOURCE_BLOCK]);
    const candidate = { tokenAddress: TOKEN, requestedVersion: '1',
      eventThroughBlock: String(SOURCE_BLOCK) };
    const anchors = {
      observation: { blockNumber: String(OBSERVATION_BLOCK), blockHash: OBSERVATION_HASH,
        blockTime: OBSERVATION_TIME, source: 'archive' },
      source: { blockNumber: String(SOURCE_BLOCK), blockHash: SOURCE_HASH,
        blockTime: SOURCE_TIME, source: 'archive' },
    };
    assert.equal(await persistCandidate(db, candidate, anchors), true);
    assert.equal(await persistCandidate(db, candidate, anchors), true);
    assert.equal(await persistCandidate(db, { ...candidate, requestedVersion: '2' }, anchors), false);
    assert.deepEqual((await db.query(`SELECT observation_from_hash,
        source_through_block::text, source_through_hash, source_requested_version::text,
        last_error_code
      FROM robinhood_bundle_redistribution_queue WHERE token_address=$1`, [TOKEN])).rows[0], {
      observation_from_hash: OBSERVATION_HASH, source_through_block: String(SOURCE_BLOCK),
      source_through_hash: SOURCE_HASH, source_requested_version: '1', last_error_code: null,
    });
    await assert.rejects(persistCandidate(db, candidate, {
      ...anchors, source: { ...anchors.source, blockTime: '2026-09-20T12:11:00.000Z' },
    }), /timestamp diverged/);
  });

  it('anchors observation without changing source lineage or retry state', async () => {
    await db.query(`INSERT INTO robinhood_bundle_redistribution_queue(
      chain, token_address, rule_version, evidence_version,
      observation_from_block, event_through_block,
      last_error_code, last_error_message
    ) VALUES ('robinhood', $1, $2, $3, $4, $5,
      'redistribution_anchor_missing', 'holder frontier pending')`,
    [OBSERVATION_TOKEN, RULE_VERSION, EVIDENCE_VERSION,
      OBSERVATION_BLOCK, SOURCE_BLOCK]);
    const candidate = { tokenAddress: OBSERVATION_TOKEN, requestedVersion: '1',
      observation: { blockNumber: String(OBSERVATION_BLOCK), blockHash: null } };
    const observation = { blockNumber: String(OBSERVATION_BLOCK),
      blockHash: OBSERVATION_HASH, blockTime: OBSERVATION_TIME, source: 'archive' };
    assert.equal(await persistObservation(db, candidate, observation), true);
    assert.equal(await persistObservation(db, candidate, observation), false);
    assert.equal(await persistObservation(db, { ...candidate, requestedVersion: '2' },
      observation), false);
    assert.deepEqual((await db.query(`SELECT observation_from_hash,
        observation_from_time, source_through_block, source_requested_version,
        last_error_code
      FROM robinhood_bundle_redistribution_queue WHERE token_address=$1`,
    [OBSERVATION_TOKEN])).rows[0], {
      observation_from_hash: OBSERVATION_HASH,
      observation_from_time: new Date(OBSERVATION_TIME),
      source_through_block: null, source_requested_version: null,
      last_error_code: 'redistribution_anchor_missing',
    });
  });
});
