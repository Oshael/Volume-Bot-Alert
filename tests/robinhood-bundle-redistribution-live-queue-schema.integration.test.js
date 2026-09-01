process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const {
  createRobinhoodBundleRedistributionLiveQueueRepository,
} = require('../src/models/robinhood-bundle-redistribution-live-queue');
const { EVIDENCE_VERSION, POLICY, RULE_VERSION } = require(
  '../src/services/robinhood-bundle-redistribution-policy'
);
const stage187 = require('../src/utils/db-init-stage187');
const stage188 = require('../src/utils/db-init-stage188');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const TOKEN = `0x${'1'.repeat(40)}`;
const TOKEN_TWO = `0x${'2'.repeat(40)}`;
const HASH = `0x${'a'.repeat(64)}`;

async function cleanup() {
  await db.query('DELETE FROM robinhood_bundle_redistribution_queue');
  await db.query('DELETE FROM robinhood_bundle_redistribution_activations');
  await db.query('DELETE FROM robinhood_bundle_redistribution_states');
}

describe('Robinhood BUNDLED redistribution live queue schema', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await db.query(`DROP TABLE IF EXISTS robinhood_bundle_redistribution_queue,
      robinhood_bundle_redistribution_activations CASCADE`);
    await stage187.init({ closePool: false });
    await stage188.init({ closePool: false });
    await cleanup();
  });
  after(async () => { await cleanup(); await db.pool.end(); });

  it('admits only post-activation transfers and requeues only admitted token sells', async () => {
    const client = await db.getClient();
    try {
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

      const queue = createRobinhoodBundleRedistributionLiveQueueRepository({ database: db });
      const [task] = await queue.claimBatch({ owner: 'shadow-test', limit: 1 });
      const stored = await queue.replaceSnapshotAndComplete({ ...task, owner: 'shadow-test',
        snapshot: { state: { tokenAddress: TOKEN_TWO, ruleVersion: RULE_VERSION,
          evidenceVersion: EVIDENCE_VERSION, status: 'ready', statusReason: 'no_groups',
          sourceKind: 'live', sourceVersion: task.requestedVersion,
          throughBlockNumber: '102', throughBlockHash: HASH, policyJson: POLICY },
        groups: [] } });
      assert.equal(stored.completed, true);
      assert.deepEqual((await client.query(`SELECT status, completed_version::text
        FROM robinhood_bundle_redistribution_queue`)).rows[0], {
        status: 'complete', completed_version: '3',
      });
      assert.equal((await client.query(`SELECT source_kind
        FROM robinhood_bundle_redistribution_states`)).rows[0].source_kind, 'live');

      await assert.rejects(client.query(`UPDATE robinhood_bundle_redistribution_activations
        SET activation_block = 99`), /activation boundary is immutable/);
    } finally {
      await client.query('DROP TABLE IF EXISTS redistribution_sell_probe');
      await client.query('DROP TABLE IF EXISTS redistribution_transfer_probe');
      client.release();
    }
  });
});
