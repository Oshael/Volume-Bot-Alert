process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const {
  createRobinhoodHolderSniperCalibrationSource, __private,
} = require('../src/models/robinhood-holder-sniper-calibration-source');
const {
  __private: launchPrivate,
} = require('../src/models/robinhood-holder-launch-source');
const stage63 = require('../src/utils/db-init-stage63');
const stage90 = require('../src/utils/db-init-stage90');
const stage110 = require('../src/utils/db-init-stage110');
const stage116 = require('../src/utils/db-init-stage116');
const stage139 = require('../src/utils/db-init-stage139');
const stage145 = require('../src/utils/db-init-stage145');
const stage149 = require('../src/utils/db-init-stage149');
const stage155 = require('../src/utils/db-init-stage155');
const stage156 = require('../src/utils/db-init-stage156');
const stage157 = require('../src/utils/db-init-stage157');
const stage167 = require('../src/utils/db-init-stage167');
const stage168 = require('../src/utils/db-init-stage168');
const stage172 = require('../src/utils/db-init-stage172');
const stage173 = require('../src/utils/db-init-stage173');
const stage174 = require('../src/utils/db-init-stage174');
const {
  createRobinhoodBundleFundingLiveQueueRepository,
} = require('../src/models/robinhood-bundle-funding-live-queue');
const {
  createRobinhoodBundleFundingLiveSource,
} = require('../src/models/robinhood-bundle-funding-live-source');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const WALLET = `0x${'d'.repeat(40)}`;
const TOKEN = `0x${'e'.repeat(40)}`;

describe('Robinhood SNIPER population calibration source integration', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    for (const stage of [
      stage63, stage90, stage110, stage116, stage139, stage145, stage149, stage155,
      stage156, stage157,
      stage167, stage168, stage172, stage173, stage174,
    ]) {
      await stage.init({ closePool: false });
    }
    await db.query('DELETE FROM robinhood_possible_bundle_members');
    await db.query('DELETE FROM robinhood_possible_bundle_groups');
    await db.query('DELETE FROM robinhood_possible_bundle_states');
    await db.query('DELETE FROM robinhood_token_launch_anchors');
    await db.query('DELETE FROM robinhood_bundle_funding_live_queue');
  });

  after(async () => {
    await db.query('DELETE FROM robinhood_possible_bundle_members');
    await db.query('DELETE FROM robinhood_possible_bundle_groups');
    await db.query('DELETE FROM robinhood_possible_bundle_states');
    await db.query('DELETE FROM robinhood_bundle_funding_live_evidence');
    await db.query('DELETE FROM robinhood_bundle_funding_live_queue');
    await db.query('DELETE FROM robinhood_token_launch_anchors');
    await db.pool.end();
  });

  it('executes the read-only population recurrence query against PostgreSQL', async () => {
    const source = createRobinhoodHolderSniperCalibrationSource({ database: db });
    const rows = await source.loadPopulationRecurrence([WALLET], {
      historicalFromBlock: '48954', completeThroughBlock: '48954',
    }, { minimumNotionalUsd: '50', maxBuyerRank: 5 });

    assert.deepEqual(rows, []);
    assert.deepEqual((await db.query(__private.ANCHORS_SQL, [
      [], [], [], 'robinhood',
    ])).rows, []);
    assert.deepEqual((await db.query(__private.CACHED_ANCHORS_SQL, [
      [], [], [], 'robinhood',
    ])).rows, []);
  });

  it('persists and reads a proven launch anchor by token and pool frontier', async () => {
    await db.query(__private.UPSERT_ANCHORS_SQL, [
      'robinhood', [TOKEN], ['90'], ['100'], ['2026-08-21T12:00:00Z'],
      ['250'], 'rh_launch_anchor_v1',
    ]);
    assert.deepEqual((await db.query(__private.CACHED_ANCHORS_SQL, [
      [TOKEN], ['90'], ['250'], 'robinhood',
    ])).rows, [{ token_address: TOKEN, launch_block: '100' }]);
    assert.deepEqual((await db.query(__private.CACHED_ANCHORS_SQL, [
      [TOKEN], ['91'], ['250'], 'robinhood',
    ])).rows, []);
    const queue = createRobinhoodBundleFundingLiveQueueRepository({ database: db });
    const task = await queue.claim({ owner: 'integration', leaseMs: 60_000 });
    assert.deepEqual({ tokenAddress: task.tokenAddress, requestedVersion: task.requestedVersion,
      anchorBlock: task.anchorBlock }, {
      tokenAddress: TOKEN, requestedVersion: '1', anchorBlock: '100',
    });
    await db.query(`UPDATE robinhood_token_launch_anchors
      SET source_through_block = 251 WHERE token_address = $1`, [TOKEN]);
    assert.equal(await queue.complete({ ...task, owner: 'integration' }), false);
    const latest = await queue.claim({ owner: 'integration', leaseMs: 60_000 });
    assert.equal(latest.requestedVersion, '2');
    const snapshot = { state: { tokenAddress: TOKEN,
      ruleVersion: 'rh_possible_bundle_v1', evidenceVersion: 'rh_native_funding_v2',
      status: 'ready', statusReason: 'no_groups', sourceKind: 'live',
      sourceRunId: null, sourceVersion: latest.requestedVersion,
      lookbackBlocks: latest.lookbackBlocks, minimumValueWei: '25000000000000000',
      throughBlockNumber: latest.sourceThroughBlock, throughBlockHash: `0x${'b'.repeat(64)}` },
    groups: [], members: [] };
    assert.deepEqual(await queue.replaceEvidenceAndComplete({
      ...latest, owner: 'integration', evidence: [{ candidateWallet: WALLET, hop: 1,
        blockNumber: '99', blockHash: `0x${'b'.repeat(64)}`,
        blockTime: '2026-08-21T11:59:00Z', transactionHash: `0x${'c'.repeat(64)}`,
        transactionIndex: '0', fromAddress: TOKEN, toAddress: WALLET, valueWei: '1' }], snapshot,
    }), { completed: true, snapshot: { status: 'published', groups: 0, members: 0 } });
    assert.equal((await db.query(`SELECT status FROM robinhood_bundle_funding_live_queue
      WHERE token_address = $1`, [TOKEN])).rows[0].status, 'complete');
    assert.equal((await db.query(`SELECT COUNT(*)::integer count
      FROM robinhood_bundle_funding_live_evidence WHERE token_address = $1`, [TOKEN])).rows[0].count, 1);
    assert.deepEqual((await db.query(`SELECT source_kind, source_version::text
      FROM robinhood_possible_bundle_states WHERE token_address = $1`, [TOKEN])).rows[0], {
      source_kind: 'live', source_version: '2',
    });
    await db.query(`UPDATE robinhood_token_launch_anchors
      SET source_through_block = 252 WHERE token_address = $1`, [TOKEN]);
    const historical = await queue.claim({ owner: 'archive-gate', leaseMs: 60_000 });
    const queueState = (await db.query(`SELECT status, requested_version::text,
        completed_version::text, last_error_code, anchor_block::text, source_through_block::text
      FROM robinhood_bundle_funding_live_queue WHERE token_address = $1`, [TOKEN])).rows[0];
    assert.ok(historical, JSON.stringify(queueState));
    assert.equal(await queue.preserveEvidenceAndComplete({
      ...historical, owner: 'archive-gate', message: 'before journal',
    }), true);
    await db.query(`UPDATE robinhood_token_launch_anchors
      SET source_through_block = 253 WHERE token_address = $1`, [TOKEN]);
    assert.deepEqual((await db.query(`SELECT status, requested_version::text,
        source_through_block::text, last_error_code
      FROM robinhood_bundle_funding_live_queue WHERE token_address = $1`, [TOKEN])).rows[0], {
      status: 'complete', requested_version: '3', source_through_block: '252',
      last_error_code: 'archive_required',
    });
    assert.equal((await db.query(`SELECT COUNT(*)::integer count
      FROM robinhood_bundle_funding_live_evidence WHERE token_address = $1`, [TOKEN])).rows[0].count, 1);
    assert.deepEqual(await createRobinhoodBundleFundingLiveSource({ database: db })
      .loadBarrierAddresses([], []), []);
  });

  it('atomically enriches a block cache with typed canonical evidence', async () => {
    const tx = `0x${'a'.repeat(64)}`;
    const hash = `0x${'b'.repeat(64)}`;
    await db.query(launchPrivate.UPSERT_ANCHOR_EVIDENCE_SQL, [
      'robinhood', TOKEN, '90', '100', '2026-08-21T12:00:00Z', '250',
      'rh_launch_anchor_v1', WALLET, tx, '1', '2', hash, 'buy', '50.25',
    ]);
    const { rows } = await db.query(
      `SELECT launch_block_time, anchor_wallet_address, anchor_transaction_hash,
              anchor_transaction_index, anchor_action_index, anchor_block_hash,
              anchor_side, anchor_volume_usd::text
         FROM robinhood_token_launch_anchors
        WHERE chain = 'robinhood' AND token_address = $1`,
      [TOKEN]
    );
    assert.deepEqual({
      ...rows[0], launch_block_time: rows[0].launch_block_time.toISOString(),
    }, {
      launch_block_time: '2026-08-21T12:00:00.000Z',
      anchor_wallet_address: WALLET,
      anchor_transaction_hash: tx,
      anchor_transaction_index: 1,
      anchor_action_index: '2',
      anchor_block_hash: hash,
      anchor_side: 'buy',
      anchor_volume_usd: '50.25',
    });

    await db.query(__private.UPSERT_ANCHORS_SQL, [
      'robinhood', [TOKEN], ['90'], ['101'], ['2026-08-21T12:01:00Z'],
      ['250'], 'rh_launch_anchor_v1',
    ]);
    assert.deepEqual((await db.query(
      `SELECT launch_block::text, anchor_transaction_hash
         FROM robinhood_token_launch_anchors WHERE token_address = $1`,
      [TOKEN]
    )).rows[0], { launch_block: '101', anchor_transaction_hash: null });
  });
});
