process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, beforeEach, describe, it } = require('node:test');

const db = require('../src/models/db');
const {
  createRobinhoodBundleRedistributionLiveQueueRepository,
} = require('../src/models/robinhood-bundle-redistribution-live-queue');
const { __private: { frozenLineage } } = require('../src/models/robinhood-bundle-redistribution-live-source');
const { EVIDENCE_VERSION, POLICY, RULE_VERSION } = require(
  '../src/services/robinhood-bundle-redistribution-policy'
);
const stage187 = require('../src/utils/db-init-stage187');
const stage188 = require('../src/utils/db-init-stage188');
const stage241 = require('../src/utils/db-init-stage241');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const TOKEN = `0x${'1'.repeat(40)}`;
const TOKEN_TWO = `0x${'2'.repeat(40)}`;
const HASH = `0x${'a'.repeat(64)}`;
const FRONTIER_HASH = `0x${'b'.repeat(64)}`;
const NEXT_HASH = `0x${'c'.repeat(64)}`;
const PARENT_HASH = `0x${'d'.repeat(64)}`;
const DIGEST = `0x${'e'.repeat(64)}`;

async function insertBlock(number, hash) {
  await db.query(`INSERT INTO robinhood_chain_blocks(
    chain, block_number, block_hash, parent_hash, capture_digest,
    block_timestamp, finality, canonical, head_observed_at, receipts_available_at
  ) VALUES ('robinhood', $1, $2, $3, $4, NOW(), 'finalized', TRUE, NOW(), NOW())`,
  [number, hash, PARENT_HASH, DIGEST]);
}

async function cleanup() {
  await db.query('DELETE FROM robinhood_bundle_redistribution_queue');
  await db.query('DELETE FROM robinhood_bundle_redistribution_activations');
  await db.query('DELETE FROM robinhood_bundle_redistribution_states');
  await db.query('DELETE FROM robinhood_holder_token_states WHERE token_address IN ($1, $2)',
    [TOKEN, TOKEN_TWO]);
  await db.query(`DELETE FROM robinhood_chain_block_anchors
    WHERE block_number BETWEEN 101 AND 103`);
  await db.query(`DELETE FROM robinhood_chain_blocks
    WHERE chain='robinhood' AND block_number BETWEEN 101 AND 103`);
}

async function activateQueue() {
  await insertBlock(101, HASH);
  await insertBlock(102, FRONTIER_HASH);
  await insertBlock(103, NEXT_HASH);
  await db.query(`INSERT INTO robinhood_bundle_redistribution_activations (
    status, activation_at, activation_block
  ) VALUES ('planned', NOW(), 100)`);
  await db.query(`UPDATE robinhood_bundle_redistribution_activations SET
    status='active', activation_checkpoint_block=101,
    activation_checkpoint_hash=$1, activated_at=NOW()`, [HASH]);
}

async function enqueue(tokenAddress, eventBlock, holderBlock, holderHash) {
  await db.query(`SELECT request_robinhood_bundle_redistribution(
    'robinhood', $1, $2, TRUE
  )`, [tokenAddress, eventBlock]);
  if (holderBlock != null) {
    await db.query(`INSERT INTO robinhood_holder_token_states (
      chain, token_address, holder_count, ledger_status, live_through_block, live_through_hash
    ) VALUES ('robinhood', $1, 0, 'live', $2, $3)`, [tokenAddress, holderBlock, holderHash]);
  }
}

async function queuedState(tokenAddress) {
  return (await db.query(`SELECT status, attempt_count, requested_version::text,
    lease_owner, lease_until, next_attempt_at, last_error_code
    FROM robinhood_bundle_redistribution_queue WHERE token_address=$1`, [tokenAddress])).rows[0];
}

describe('Robinhood BUNDLED redistribution live queue schema', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await db.query(`DROP TABLE IF EXISTS robinhood_bundle_redistribution_queue,
      robinhood_bundle_redistribution_activations CASCADE`);
    await stage187.init({ closePool: false });
    await stage188.init({ closePool: false });
    await stage241.init({ closePool: false });
    await cleanup();
  });
  beforeEach(cleanup);
  after(async () => { await cleanup(); await db.pool.end(); });

  it('admits only post-activation transfers and requeues only admitted token sells', async () => {
    const client = await db.getClient();
    try {
      await insertBlock(101, HASH);
      await insertBlock(102, FRONTIER_HASH);
      await insertBlock(103, NEXT_HASH);
      await client.query(`INSERT INTO robinhood_bundle_redistribution_activations (
        status, activation_at, activation_block
      ) VALUES ('planned', NOW(), 100)`);
      assert.equal((await client.query(
        'SELECT COUNT(*)::integer count FROM robinhood_bundle_redistribution_queue'
      )).rows[0].count, 0);

      await client.query(`CREATE TEMP TABLE redistribution_transfer_probe (
        chain TEXT, classification_version TEXT, token_address TEXT,
        first_wallet_transfer_block BIGINT, first_wallet_transfer_log_index INTEGER,
        first_wallet_transfer_transaction_hash TEXT, first_wallet_transfer_amount_raw NUMERIC
      )`);
      await client.query(`CREATE TRIGGER redistribution_transfer_probe_insert
        AFTER INSERT OR DELETE ON redistribution_transfer_probe FOR EACH ROW
        EXECUTE FUNCTION enqueue_robinhood_bundle_redistribution_transfer()`);
      await client.query(`CREATE TRIGGER redistribution_transfer_probe_update
        AFTER UPDATE OF first_wallet_transfer_block ON redistribution_transfer_probe
        FOR EACH ROW EXECUTE FUNCTION enqueue_robinhood_bundle_redistribution_transfer()`);
      await client.query(`INSERT INTO redistribution_transfer_probe VALUES
        ('robinhood', 'rh_transfer_v1', $1, 100, 0, $3, 1),
        ('robinhood', 'rh_transfer_v1', $2, 101, 0, $3, 1)`,
      [TOKEN, TOKEN_TWO, HASH]);

      let queued = (await client.query(`SELECT token_address, observation_from_block::text,
          event_through_block::text, requested_version::text
        FROM robinhood_bundle_redistribution_queue`)).rows;
      assert.deepEqual(queued, [{ token_address: TOKEN_TWO, observation_from_block: '101',
        event_through_block: '101', requested_version: '1' }]);
      await client.query(`UPDATE robinhood_bundle_redistribution_activations SET
        status = 'active', activation_checkpoint_block = 101,
        activation_checkpoint_hash = $1, activated_at = NOW()`, [HASH]);

      await client.query(`INSERT INTO robinhood_holder_token_states(
        chain, token_address, holder_count, ledger_status,
        live_through_block, live_through_hash
      ) VALUES ('robinhood', $1, 0, 'live', 102, $2)`, [TOKEN_TWO, FRONTIER_HASH]);

      await client.query(`CREATE TEMP TABLE redistribution_sell_probe (
        chain TEXT, token_address TEXT, side TEXT, block_number BIGINT
      )`);
      await client.query(`CREATE TRIGGER redistribution_sell_probe_insert
        AFTER INSERT OR DELETE ON redistribution_sell_probe FOR EACH ROW
        EXECUTE FUNCTION enqueue_robinhood_bundle_redistribution_sell()`);
      await client.query(`INSERT INTO redistribution_sell_probe VALUES
        ('robinhood', $1, 'sell', 102), ('robinhood', $2, 'sell', 102)`,
      [TOKEN, TOKEN_TWO]);
      queued = (await client.query(`SELECT token_address, event_through_block::text,
          requested_version::text FROM robinhood_bundle_redistribution_queue`)).rows;
      assert.deepEqual(queued, [{ token_address: TOKEN_TWO,
        event_through_block: '102', requested_version: '2' }]);

      await client.query('DELETE FROM redistribution_sell_probe WHERE token_address = $1',
        [TOKEN_TWO]);
      assert.equal((await client.query(`SELECT requested_version::text
        FROM robinhood_bundle_redistribution_queue`)).rows[0].requested_version, '3');
      await client.query(`DELETE FROM robinhood_chain_block_anchors
        WHERE chain='robinhood' AND block_number=102`);

      const queue = createRobinhoodBundleRedistributionLiveQueueRepository({
        database: db, projectionFence: async () => {},
      });
      const [staleTask] = await queue.claimBatch({ owner: 'shadow-test', limit: 1 });
      assert.deepEqual({ block: staleTask.sourceThroughBlock, hash: staleTask.sourceThroughHash,
        version: staleTask.sourceRequestedVersion }, {
        block: '102', hash: FRONTIER_HASH, version: '3',
      });

      await client.query(`INSERT INTO redistribution_sell_probe VALUES
        ('robinhood', $1, 'sell', 103)`, [TOKEN_TWO]);
      assert.deepEqual((await client.query(`SELECT status, requested_version::text,
          source_requested_version::text
        FROM robinhood_bundle_redistribution_queue`)).rows[0], {
        status: 'pending', requested_version: '4', source_requested_version: null,
      });
      assert.equal((await queue.replaceSnapshotAndComplete({ ...staleTask, owner: 'shadow-test',
        snapshot: { state: { tokenAddress: TOKEN_TWO, ruleVersion: RULE_VERSION,
          evidenceVersion: EVIDENCE_VERSION, status: 'ready', statusReason: 'no_groups',
          sourceKind: 'live', sourceVersion: staleTask.requestedVersion,
          throughBlockNumber: '102', throughBlockHash: FRONTIER_HASH, policyJson: POLICY },
        groups: [] } })).completed, false);

      assert.deepEqual(await queue.claimBatch({ owner: 'shadow-test', limit: 1 }), []);
      assert.equal((await queuedState(TOKEN_TWO)).attempt_count, 1);
      await client.query(`UPDATE robinhood_holder_token_states SET
        live_through_block=103, live_through_hash=$2
        WHERE chain='robinhood' AND token_address=$1`, [TOKEN_TWO, NEXT_HASH]);
      await client.query(`UPDATE robinhood_bundle_redistribution_queue
        SET next_attempt_at=NOW() WHERE token_address=$1`, [TOKEN_TWO]);
      const [retried] = await queue.claimBatch({ owner: 'shadow-test', limit: 1 });
      assert.equal(retried.sourceThroughBlock, '103');
      assert.equal(retried.sourceRequestedVersion, '4');
      assert.equal(retried.attemptCount, 2);

      const stored = await queue.replaceSnapshotAndComplete({ ...retried, owner: 'shadow-test',
        snapshot: { state: { tokenAddress: TOKEN_TWO, ruleVersion: RULE_VERSION,
          evidenceVersion: EVIDENCE_VERSION, status: 'ready', statusReason: 'no_groups',
          sourceKind: 'live', sourceVersion: retried.requestedVersion,
          throughBlockNumber: '103', throughBlockHash: NEXT_HASH, policyJson: POLICY },
        groups: [] } });
      assert.equal(stored.completed, true);
      assert.deepEqual((await client.query(`SELECT status, completed_version::text
        FROM robinhood_bundle_redistribution_queue`)).rows[0], {
        status: 'complete', completed_version: '4',
      });
      assert.equal((await client.query(`SELECT source_kind
        FROM robinhood_bundle_redistribution_states`)).rows[0].source_kind, 'live');

      await client.query(`INSERT INTO redistribution_sell_probe VALUES
        ('robinhood', $1, 'sell', 103)`, [TOKEN_TWO]);
      const concurrent = await Promise.all([
        queue.claimBatch({ owner: 'claim-a', limit: 1 }),
        queue.claimBatch({ owner: 'claim-b', limit: 1 }),
      ]);
      assert.equal(concurrent[0].length + concurrent[1].length, 1);
      assert.equal((concurrent[0][0] || concurrent[1][0]).sourceThroughBlock, '103');

      await assert.rejects(client.query(`UPDATE robinhood_bundle_redistribution_activations
        SET activation_block = 99`), /activation boundary is immutable/);
    } finally {
      await client.query('DROP TABLE IF EXISTS redistribution_sell_probe');
      await client.query('DROP TABLE IF EXISTS redistribution_transfer_probe');
      client.release();
    }
  });

  it('skips older unready tasks before LIMIT without consuming their attempt or retry schedule', async () => {
    await activateQueue();
    await enqueue(TOKEN, 103, 102, FRONTIER_HASH);
    await enqueue(TOKEN_TWO, 103, 103, NEXT_HASH);
    await db.query(`UPDATE robinhood_bundle_redistribution_queue SET next_attempt_at=
      NOW() - CASE WHEN token_address=$1 THEN INTERVAL '2 minutes' ELSE INTERVAL '1 minute' END`,
    [TOKEN]);
    const beforeClaim = await queuedState(TOKEN);
    const queue = createRobinhoodBundleRedistributionLiveQueueRepository({ database: db });
    const [ready] = await queue.claimBatch({ owner: 'ready-first', limit: 1 });
    assert.equal(ready.tokenAddress, TOKEN_TWO);
    assert.equal(frozenLineage(ready, TOKEN_TWO).ready, true);
    assert.deepEqual(await queuedState(TOKEN), beforeClaim);
    assert.deepEqual(await queue.claimBatch({ owner: 'not-ready', limit: 1 }), []);
    assert.deepEqual(await queuedState(TOKEN), beforeClaim);

    await db.query(`UPDATE robinhood_holder_token_states SET
      live_through_block=103, live_through_hash=$2 WHERE token_address=$1`, [TOKEN, NEXT_HASH]);
    const [caughtUp] = await queue.claimBatch({ owner: 'holder-ready', limit: 1 });
    assert.equal(caughtUp.tokenAddress, TOKEN);
    assert.equal(caughtUp.attemptCount, 1);
    assert.equal(caughtUp.sourceThroughBlock, '103');
    assert.equal(frozenLineage(caughtUp, TOKEN).ready, true);
  });

  it('preserves a frozen frontier across retries and expired leases until a new event', async () => {
    await activateQueue();
    await enqueue(TOKEN, 102, 102, FRONTIER_HASH);
    const queue = createRobinhoodBundleRedistributionLiveQueueRepository({ database: db });
    const [original] = await queue.claimBatch({ owner: 'original', limit: 1 });
    await db.query(`UPDATE robinhood_holder_token_states SET
      ledger_status='backfilling', live_through_block=103, live_through_hash=$2
      WHERE token_address=$1`, [TOKEN, NEXT_HASH]);
    assert.equal(await queue.retry({ ...original, owner: 'original', retryMs: 1000,
      error: { code: 'source_not_ready', message: 'retry' } }), true);
    await db.query('UPDATE robinhood_bundle_redistribution_queue SET next_attempt_at=NOW()');
    const [retried] = await queue.claimBatch({ owner: 'retry', limit: 1 });
    assert.equal(retried.sourceThroughBlock, '102');
    assert.equal(retried.sourceThroughHash, FRONTIER_HASH);
    assert.equal(retried.sourceThroughTime, original.sourceThroughTime);
    assert.equal(retried.attemptCount, 2);

    await db.query(`UPDATE robinhood_bundle_redistribution_queue
      SET lease_until=NOW()-INTERVAL '1 second'`);
    const [reclaimed] = await queue.claimBatch({ owner: 'reclaim', limit: 1 });
    assert.equal(reclaimed.sourceThroughBlock, '102');
    assert.equal(reclaimed.attemptCount, 3);
    assert.equal(await queue.retry({ ...retried, owner: 'retry' }), false);

    await db.query(`UPDATE robinhood_holder_token_states SET ledger_status='live'
      WHERE token_address=$1`, [TOKEN]);
    await db.query(`SELECT request_robinhood_bundle_redistribution('robinhood',$1,103,FALSE)`, [TOKEN]);
    const [newVersion] = await queue.claimBatch({ owner: 'new-event', limit: 1 });
    assert.equal(newVersion.requestedVersion, '2');
    assert.equal(newVersion.sourceRequestedVersion, '2');
    assert.equal(newVersion.sourceThroughBlock, '103');
  });

  it('rejects a mismatched canonical hash and accepts a matching raw or retained durable anchor', async () => {
    await activateQueue();
    await enqueue(TOKEN, 103, 103, NEXT_HASH);
    await db.query('DELETE FROM robinhood_chain_block_anchors WHERE block_number=103');
    await db.query('UPDATE robinhood_chain_blocks SET block_hash=$1 WHERE block_number=103', [PARENT_HASH]);
    const queue = createRobinhoodBundleRedistributionLiveQueueRepository({ database: db });
    const pending = await queuedState(TOKEN);
    assert.deepEqual(await queue.claimBatch({ owner: 'fork', limit: 1 }), []);
    assert.deepEqual(await queuedState(TOKEN), pending);

    await db.query('UPDATE robinhood_chain_blocks SET block_hash=$1 WHERE block_number=103', [NEXT_HASH]);
    const [raw] = await queue.claimBatch({ owner: 'matching-raw', limit: 1 });
    assert.equal(raw.sourceThroughHash, NEXT_HASH);
    assert.equal(frozenLineage(raw, TOKEN).ready, true);
    assert.equal((await db.query(`SELECT COUNT(*)::integer count
      FROM robinhood_chain_block_anchors WHERE block_number=103 AND block_hash=$1`,
    [NEXT_HASH])).rows[0].count, 1);

    await db.query('DELETE FROM robinhood_chain_blocks WHERE block_number=103');
    await db.query(`SELECT request_robinhood_bundle_redistribution('robinhood',$1,103,FALSE)`, [TOKEN]);
    const [durable] = await queue.claimBatch({ owner: 'retained-anchor', limit: 1 });
    assert.equal(durable.sourceThroughBlock, '103');
    assert.equal(durable.sourceThroughHash, NEXT_HASH);
    assert.equal(durable.sourceThroughTime, raw.sourceThroughTime);
    assert.equal(durable.sourceRequestedVersion, '2');
  });

  it('keeps missing and non-live holders unclaimed and waits for an absent frontier anchor', async () => {
    await activateQueue();
    await enqueue(TOKEN, 102);
    await enqueue(TOKEN_TWO, 103, 103, NEXT_HASH);
    await db.query(`UPDATE robinhood_holder_token_states SET ledger_status='backfilling'
      WHERE token_address=$1`, [TOKEN_TWO]);
    const queue = createRobinhoodBundleRedistributionLiveQueueRepository({ database: db });
    assert.deepEqual(await queue.claimBatch({ owner: 'unready', limit: 10 }), []);
    assert.equal((await queuedState(TOKEN)).attempt_count, 0);
    assert.equal((await queuedState(TOKEN_TWO)).attempt_count, 0);

    await db.query(`UPDATE robinhood_bundle_redistribution_queue SET status='leased',
      lease_owner='expired', lease_until=NOW()-INTERVAL '1 second', attempt_count=4
      WHERE token_address=$1`, [TOKEN]);
    const expiredUnready = await queuedState(TOKEN);
    await db.query('DELETE FROM robinhood_chain_block_anchors WHERE block_number=103');
    await db.query('DELETE FROM robinhood_chain_blocks WHERE block_number=103');
    await db.query(`UPDATE robinhood_holder_token_states SET ledger_status='live'
      WHERE token_address=$1`, [TOKEN_TWO]);
    assert.deepEqual(await queue.claimBatch({ owner: 'anchor-not-ready', limit: 10 }), []);
    assert.deepEqual(await queuedState(TOKEN), expiredUnready);
    assert.equal((await queuedState(TOKEN_TWO)).attempt_count, 0);
  });
});
