process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, beforeEach, describe, it } = require('node:test');

const db = require('../src/models/db');
const {
  createRobinhoodHolderDevHoldMaterializer,
} = require('../src/services/robinhood-holder-dev-hold-materializer');
const { createRobinhoodHolderDevHoldSource } = require('../src/models/robinhood-holder-dev-hold-source');
const stage110 = require('../src/utils/db-init-stage110');
const stage113 = require('../src/utils/db-init-stage113');
const stage114 = require('../src/utils/db-init-stage114');
const stage116 = require('../src/utils/db-init-stage116');
const stage144 = require('../src/utils/db-init-stage144');
const stage183 = require('../src/utils/db-init-stage183');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const TOKEN = `0x${'8'.repeat(40)}`;
const NO_CREATOR = `0x${'9'.repeat(40)}`;
const CREATOR = `0x${'a'.repeat(40)}`;
const OTHER = `0x${'b'.repeat(40)}`;
const HASH = `0x${'c'.repeat(64)}`;
const TX = `0x${'d'.repeat(64)}`;
const FORK = `0x${'e'.repeat(64)}`;

function materializer(options = {}) {
  return createRobinhoodHolderDevHoldMaterializer({
    database: db, now: () => '2026-08-23T12:00:00Z',
    projectionFence: async () => {}, ...options,
  });
}

async function invalidateCreator() {
  await db.query(`UPDATE robinhood_token_attributions SET creator_address=NULL,
    source='rpc_code_transition',attribution_block=50,last_resolved_at=NULL,
    updated_at='2026-08-22T12:00:00.123456Z' WHERE token_address=$1`, [TOKEN]);
}

async function storedMetric() {
  return (await db.query(`SELECT status,status_reason,value_numerator_raw::text,
    value_denominator_raw::text,through_block_number::text,through_block_hash
    FROM robinhood_holder_distribution_metrics WHERE chain='robinhood' AND token_address=$1
      AND metric='dev_hold' AND classification_version='rh_holder_v1'`, [TOKEN])).rows[0];
}

async function cleanup() {
  const tokens = [TOKEN, NO_CREATOR];
  await db.query('DELETE FROM robinhood_holder_distribution_metrics WHERE token_address = ANY($1)', [tokens]);
  await db.query('DELETE FROM robinhood_holder_balances WHERE token_address = ANY($1)', [tokens]);
  await db.query('DELETE FROM robinhood_holder_token_states WHERE token_address = ANY($1)', [tokens]);
  await db.query('DELETE FROM robinhood_token_attributions WHERE token_address = ANY($1)', [tokens]);
}

describe('Robinhood DEV HOLD materializer integration', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage110.init({ closePool: false });
    await stage113.init({ closePool: false });
    await stage114.init({ closePool: false });
    await stage116.init({ closePool: false });
    await stage144.init({ closePool: false });
    await stage183.init({ closePool: false });
  });

  beforeEach(async () => {
    await cleanup();
    await db.query(
      `INSERT INTO robinhood_holder_token_states (
         token_address, holder_count, ledger_status, live_through_block, live_through_hash
       ) VALUES ($1, 2, 'live', 100, $3), ($2, 1, 'live', 100, $3)`,
      [TOKEN, NO_CREATOR, HASH]
    );
    await db.query(
      `INSERT INTO robinhood_token_attributions (
         token_address, creator_address, source, last_resolved_at
       ) VALUES ($1, $2, 'blockscout', '2026-08-21T11:00:00Z')`,
      [TOKEN, CREATOR]
    );
    await db.query(
      `INSERT INTO robinhood_holder_balances (
         token_address, wallet_address, balance_raw, last_block_number,
         last_transaction_hash, last_log_index
       ) VALUES ($1, $2, 25, 100, $4, 1), ($1, $3, 75, 100, $4, 2),
                ($5, $3, 100, 100, $4, 1)`,
      [TOKEN, CREATOR, OTHER, TX, NO_CREATOR]
    );
  });

  after(async () => {
    await cleanup();
    await db.pool.end();
  });

  it('publishes an exact ratio and never invents zero without a creator', async () => {
    const materializer = createRobinhoodHolderDevHoldMaterializer({
      database: db, now: () => '2026-08-21T12:00:00Z',
      projectionFence: async () => {},
    });

    assert.deepEqual(await materializer.materializeToken(TOKEN), { status: 'published' });
    assert.deepEqual(await materializer.materializeToken(TOKEN), { status: 'unchanged' });
    assert.deepEqual(await materializer.materializeToken(NO_CREATOR), { status: 'published' });
    const result = await db.query(
      `SELECT token_address, status, status_reason, value_numerator_raw::text,
              value_denominator_raw::text, wallet_count::text, through_block_number::text
         FROM robinhood_holder_distribution_metrics
        WHERE token_address = ANY($1) AND metric = 'dev_hold' ORDER BY token_address`,
      [[TOKEN, NO_CREATOR]]
    );
    assert.deepEqual(result.rows, [{
      token_address: TOKEN, status: 'ready', status_reason: 'materialized',
      value_numerator_raw: '25', value_denominator_raw: '100',
      wallet_count: '1', through_block_number: '100',
    }, {
      token_address: NO_CREATOR, status: 'unavailable',
      status_reason: 'creator_unavailable', value_numerator_raw: null,
      value_denominator_raw: null, wallet_count: null, through_block_number: null,
    }]);
  });

  it('invalidates legacy DEV HOLD after its creator is invalidated, without inventing a zero', async () => {
    const worker = materializer();
    await worker.materializeToken(TOKEN);
    await invalidateCreator();
    await db.query(`UPDATE robinhood_holder_token_states SET live_through_block=101,
      live_through_hash=$2 WHERE token_address=$1`, [TOKEN, FORK]);

    assert.deepEqual(await worker.materializeToken(TOKEN), { status: 'published' });
    assert.deepEqual(await storedMetric(), {
      status: 'unavailable', status_reason: 'creator_unavailable',
      value_numerator_raw: null, value_denominator_raw: null,
      through_block_number: null, through_block_hash: null,
    });
    assert.deepEqual(await worker.materializeToken(TOKEN), { status: 'unchanged' });
  });

  for (const race of ['creator restored', 'ledger advanced', 'attribution revision changed']) {
    it(`preserves the metric when ${race} after the unavailable observation`, async () => {
      await materializer().materializeToken(TOKEN);
      const previous = await storedMetric();
      await invalidateCreator();
      const candidate = await createRobinhoodHolderDevHoldSource({ database: db }).loadDevHoldEvidence(TOKEN);
      if (race === 'creator restored') {
        await db.query(`UPDATE robinhood_token_attributions SET creator_address=$2,source='blockscout',
          attribution_block=NULL,last_resolved_at=NOW(),updated_at=NOW() WHERE token_address=$1`, [TOKEN, CREATOR]);
      } else if (race === 'ledger advanced') {
        await db.query(`UPDATE robinhood_holder_token_states SET live_through_block=101,
          live_through_hash=$2 WHERE token_address=$1`, [TOKEN, FORK]);
      } else {
        await db.query(`UPDATE robinhood_token_attributions
          SET updated_at='2026-08-22T12:00:00.123457Z' WHERE token_address=$1`, [TOKEN]);
      }
      const worker = materializer({ source: { loadDevHoldEvidence: async () => candidate } });
      assert.deepEqual(await worker.materializeToken(TOKEN), {
        status: 'deferred', reason: 'dev_hold_source_changed',
      });
      assert.deepEqual(await storedMetric(), previous);
    });
  }

  it('does not republish a stale ready calculation after its creator was invalidated', async () => {
    const worker = materializer();
    await worker.materializeToken(TOKEN);
    const ready = await createRobinhoodHolderDevHoldSource({ database: db }).loadDevHoldEvidence(TOKEN);
    await invalidateCreator();
    await worker.materializeToken(TOKEN);
    const previous = await storedMetric();
    const stale = materializer({ source: { loadDevHoldEvidence: async () => ready } });
    assert.deepEqual(await stale.materializeToken(TOKEN), {
      status: 'deferred', reason: 'dev_hold_source_changed',
    });
    assert.deepEqual(await storedMetric(), previous);
  });

  for (const unsafe of ['newer metric', 'forked metric', 'different provenance']) {
    it(`does not authorize creator invalidation over a ${unsafe}`, async () => {
      await materializer().materializeToken(TOKEN);
      if (unsafe === 'newer metric') {
        await db.query(`UPDATE robinhood_holder_distribution_metrics SET through_block_number=101
          WHERE token_address=$1 AND metric='dev_hold'`, [TOKEN]);
      } else if (unsafe === 'forked metric') {
        await db.query(`UPDATE robinhood_holder_distribution_metrics SET through_block_hash=$2
          WHERE token_address=$1 AND metric='dev_hold'`, [TOKEN, FORK]);
      } else {
        await db.query(`UPDATE robinhood_holder_distribution_metrics
          SET evidence_json=jsonb_set(evidence_json,'{creator,source}','"rpc_direct"'::jsonb)
          WHERE token_address=$1 AND metric='dev_hold'`, [TOKEN]);
      }
      const previous = await storedMetric();
      await invalidateCreator();
      assert.deepEqual(await materializer().materializeToken(TOKEN), {
        status: 'deferred', reason: 'dev_hold_invalidation_unverified',
      });
      assert.deepEqual(await storedMetric(), previous);
    });
  }

  it('requires the observed canonical frontier before invalidating and rolls back on a fence failure', async () => {
    await materializer().materializeToken(TOKEN);
    const previous = await storedMetric();
    await invalidateCreator();
    const worker = materializer({ projectionFence: async (_client, frontier) => {
      assert.deepEqual(frontier, { blockNumber: '100', blockHash: HASH });
      throw Object.assign(new Error('recovery fenced'), { code: 'canonical_projection_fence_conflict' });
    } });
    await assert.rejects(worker.materializeToken(TOKEN), { code: 'canonical_projection_fence_conflict' });
    assert.deepEqual(await storedMetric(), previous);
  });
});
