const assert = require('node:assert/strict');
const { after, describe, it } = require('node:test');

const db = require('../src/models/db');
const {
  createRobinhoodHolderGlobalBackfillRepository,
} = require('../src/models/robinhood-holder-global-backfill');
const { createRobinhoodHolderBootstrapRepository } = require('../src/models/robinhood-holder-bootstrap');
const { createRobinhoodHolderHandoffRepository } = require('../src/models/robinhood-holder-handoff');
const { createRobinhoodHolderLedgerRepository } = require('../src/models/robinhood-holder-ledger');
const {
  createRobinhoodHolderGlobalBackfillAttach,
} = require('../src/services/robinhood-holder-global-backfill-attach');

const TOKEN = `0x${'1'.repeat(40)}`;
const ALICE = `0x${'2'.repeat(40)}`;
const BOB = `0x${'3'.repeat(40)}`;
const HASH_A = `0x${'a'.repeat(64)}`;
const HASH_B = `0x${'b'.repeat(64)}`;
const HASH_C = `0x${'c'.repeat(64)}`;

after(() => db.pool.end());

describe('Robinhood holder global backfill live attach', () => {
  it('fences stale capture, journals from the barrier and materializes without a gap', async () => {
    const client = await db.getClient();
    try {
      for (const table of [
        'robinhood_holder_global_backfill_runs',
        'robinhood_holder_global_backfill_tokens', 'robinhood_holder_cursors',
        'robinhood_holder_token_states', 'robinhood_holder_transfer_journal',
      ]) {
        await client.query(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
      }
      await client.query(`CREATE TEMP TABLE token_catalog (
        chain varchar(16), address varchar(42), first_seen_at timestamptz
      )`);
      await client.query(`CREATE TEMP TABLE robinhood_token_attributions (
        chain varchar(16), token_address varchar(42), source varchar(32),
        attribution_block bigint
      )`);
      const database = {
        query: client.query.bind(client),
        getClient: async () => ({ query: client.query.bind(client), release() {} }),
      };
      const global = createRobinhoodHolderGlobalBackfillRepository({ database });
      const bootstrap = createRobinhoodHolderBootstrapRepository({ database });
      const ledger = createRobinhoodHolderLedgerRepository({ database });
      const handoff = createRobinhoodHolderHandoffRepository({ database });
      const inserted = await client.query(
        `INSERT INTO robinhood_holder_global_backfill_runs (
           status, catalog_cutoff, next_block, checkpoint_block, checkpoint_hash,
           cohort_token_count
         ) VALUES ('scanning', '2026-08-10T00:00:00Z', 100, 99, $1, 1)
         RETURNING id`, [HASH_A]
      );
      const runId = String(inserted.rows[0].id);
      await client.query(
        `INSERT INTO robinhood_holder_global_backfill_tokens
           (run_id, token_address, holder_count) VALUES ($1, $2, 1)`, [runId, TOKEN]
      );
      await client.query(
        `INSERT INTO token_catalog VALUES ('robinhood', $1, '2026-08-09T00:00:00Z')`, [TOKEN]
      );
      await client.query(
        `INSERT INTO robinhood_token_attributions VALUES ('robinhood', $1, 'rpc_direct', 10)`,
        [TOKEN]
      );
      await client.query(
        `INSERT INTO robinhood_holder_cursors (
           next_block, safe_head, checkpoint_block, checkpoint_hash,
           journal_floor_block, version
         ) VALUES (105, 110, 104, $1, 90, 7)`, [HASH_B]
      );

      assert.deepEqual(await ledger.listTrackedTokenAddresses(), []);
      await assert.rejects(
        global.attachToLive({ runId, version: 0, attachWindow: 4 }),
        { code: 'holder_global_backfill_attach_unavailable' }
      );
      const attached = await global.attachToLive({ runId, version: 0, attachWindow: 5 });
      assert.equal(attached.barrierBlock, '105');
      assert.deepEqual(attached.barrierCheckpoint, { number: '104', hash: HASH_B });
      assert.equal(attached.liveCursorVersion, 8);
      assert.deepEqual(await ledger.listTrackedTokenAddresses(), [TOKEN]);
      assert.deepEqual(await bootstrap.seedColdTokens({
        admittedBefore: '2026-08-10T00:00:00Z', limit: 10,
      }), []);

      const capturedRange = {
        transfers: [{
          blockNumber: '105', blockHash: HASH_C,
          transactionHash: `0x${'4'.repeat(64)}`, transactionIndex: 0, logIndex: 0,
          tokenAddress: TOKEN, fromWallet: ALICE, toWallet: BOB, amountRaw: '4',
        }],
        cursor: {
          rangeStart: '105', nextBlock: '106', safeHead: '110',
          checkpoint: { number: '105', hash: HASH_C },
        },
      };
      await assert.rejects(
        ledger.appendCapturedRange({
          ...capturedRange, cursor: { ...capturedRange.cursor, expectedVersion: 7 },
        }),
        { code: 'holder_cursor_stale' }
      );
      assert.equal((await client.query('SELECT 1 FROM robinhood_holder_transfer_journal')).rowCount, 0);
      await ledger.appendCapturedRange({
        ...capturedRange, cursor: { ...capturedRange.cursor, expectedVersion: 8 },
      });
      await client.query(
        `UPDATE robinhood_holder_global_backfill_runs
            SET next_block = 105, checkpoint_block = 104, checkpoint_hash = $2,
                version = version + 1
          WHERE id = $1`, [runId, HASH_B]
      );

      let canonical = false;
      let finalizedThrough = '104';
      const attach = createRobinhoodHolderGlobalBackfillAttach({
        repository: global,
        reader: {
          matchesCheckpoint: async () => canonical,
          getSafeHead: async (confirmations) => {
            assert.equal(confirmations, 2000);
            return { safeHead: finalizedThrough };
          },
        },
      });
      await assert.rejects(attach.materializeOnce({ finalityBlocks: 1999 }), /at least 2000/);
      assert.deepEqual(await attach.materializeOnce(), {
        status: 'checkpoint-diverged', runId,
      });
      canonical = true;
      finalizedThrough = '103';
      assert.deepEqual(await attach.materializeOnce(), {
        status: 'waiting-finality', runId,
      });
      finalizedThrough = '104';
      assert.deepEqual(await attach.materializeOnce({ limit: 10 }), {
        status: 'materializing', runId, materializedTokens: 1,
        remainingTokens: 0, version: '3',
      });
      assert.deepEqual(await attach.materializeOnce(), { status: 'idle' });
      const state = await client.query(
        `SELECT holder_count, ledger_status, deployment_block, backfill_next_block,
                live_through_block, live_through_hash
           FROM robinhood_holder_token_states WHERE token_address = $1`, [TOKEN]
      );
      assert.deepEqual({
        ...state.rows[0], holder_count: String(state.rows[0].holder_count),
        deployment_block: String(state.rows[0].deployment_block),
        backfill_next_block: String(state.rows[0].backfill_next_block),
        live_through_block: String(state.rows[0].live_through_block),
      }, {
        holder_count: '1', ledger_status: 'backfilling', deployment_block: '0',
        backfill_next_block: '105', live_through_block: '104', live_through_hash: HASH_B,
      });
      assert.equal((await client.query(
        'SELECT 1 FROM robinhood_holder_transfer_journal WHERE applied = false'
      )).rowCount, 1);
      const candidate = await handoff.getNextCandidate();
      assert.equal(candidate.tokenAddress, TOKEN);
      const promoted = await handoff.promoteAtLiveBarrier({
        tokenAddress: TOKEN, verifiedCheckpoint: candidate.checkpoint,
      });
      assert.equal(promoted.status, 'shadow');
      assert.equal(promoted.discardedOverlapEvents, 0);
      assert.equal((await client.query(
        'SELECT 1 FROM robinhood_holder_transfer_journal WHERE applied = false'
      )).rowCount, 1);
    } finally {
      client.release();
    }
  });
});
