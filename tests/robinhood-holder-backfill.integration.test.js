const assert = require('node:assert/strict');
const { after, describe, it } = require('node:test');

const db = require('../src/models/db');
const {
  createRobinhoodHolderBackfillRepository,
} = require('../src/models/robinhood-holder-backfill');
const {
  __private: { requeueCandidate },
} = require('../src/utils/robinhood-holder-drift-recovery');
const {
  runCheckpointRepair, __private: { resetCandidate },
} = require('../src/utils/repair-robinhood-holder-backfill-checkpoints');
const {
  runWideTailRequeue, __private: { requeueCandidate: requeueWideTail },
} = require('../src/utils/requeue-robinhood-holder-wide-tails');
const {
  runHolderQuarantine,
} = require('../src/utils/quarantine-robinhood-holder-token');

const TOKEN = `0x${'1'.repeat(40)}`;
const DRIFT_TOKEN = `0x${'2'.repeat(40)}`;
const PRIORITY_TOKEN = `0x${'5'.repeat(40)}`;
const REPAIR_TOKEN = `0x${'6'.repeat(40)}`;
const SHADOW_TOKEN = `0x${'7'.repeat(40)}`;
const QUARANTINE_TOKEN = `0x${'9'.repeat(40)}`;
const ALICE = `0x${'3'.repeat(40)}`;
const BOB = `0x${'4'.repeat(40)}`;
const ZERO = `0x${'0'.repeat(40)}`;
const HASH_A = `0x${'a'.repeat(64)}`;
const HASH_B = `0x${'b'.repeat(64)}`;
const HASH_C = `0x${'c'.repeat(64)}`;
const HASH_D = `0x${'d'.repeat(64)}`;
const HASH_E = `0x${'e'.repeat(64)}`;

after(() => db.pool.end());

function transfer(tokenAddress, overrides = {}) {
  return {
    blockNumber: '100', blockHash: HASH_A, transactionHash: HASH_A,
    transactionIndex: 0, logIndex: 0, tokenAddress,
    fromWallet: ZERO, toWallet: ALICE, amountRaw: '10', ...overrides,
  };
}

describe('Robinhood holder backfill persistence', () => {
  it('commits a range atomically, rejects restart gaps and isolates drift', async () => {
    const client = await db.getClient();
    try {
      await client.query(`CREATE TEMP TABLE robinhood_holder_balances
        (LIKE public.robinhood_holder_balances INCLUDING ALL)`);
      await client.query(`CREATE TEMP TABLE robinhood_holder_token_states
        (LIKE public.robinhood_holder_token_states INCLUDING ALL)`);
      await client.query(`CREATE TEMP TABLE robinhood_holder_transfer_journal
        (LIKE public.robinhood_holder_transfer_journal INCLUDING ALL)`);
      await client.query(`CREATE TEMP TABLE robinhood_holder_cursors
        (LIKE public.robinhood_holder_cursors INCLUDING ALL)`);
      await client.query(`CREATE TEMP TABLE robinhood_holder_global_backfill_runs
        (LIKE public.robinhood_holder_global_backfill_runs INCLUDING ALL)`);
      await client.query(`CREATE TEMP TABLE robinhood_holder_global_backfill_tokens
        (LIKE public.robinhood_holder_global_backfill_tokens INCLUDING ALL)`);
      await client.query(`CREATE TEMP TABLE worker_leases
        (LIKE public.worker_leases INCLUDING ALL)`);
      await client.query(
        `INSERT INTO robinhood_holder_cursors (
           next_block, safe_head, journal_floor_block
         ) VALUES (100, 99, 90)`
      );
      await client.query(
        `INSERT INTO robinhood_holder_token_states (
           token_address, ledger_status, deployment_block, backfill_next_block
         ) VALUES ($1, 'backfilling', 100, 100), ($2, 'backfilling', 200, 200)`,
        [TOKEN, DRIFT_TOKEN]
      );
      const database = {
        query: client.query.bind(client),
        getClient: async () => ({ query: client.query.bind(client), release() {} }),
      };
      const repository = createRobinhoodHolderBackfillRepository({ database });
      const range = {
        tokenAddress: TOKEN, fromBlock: 100, toBlock: 101,
        checkpoint: { number: 101, hash: HASH_B },
        transfers: [
          transfer(TOKEN, {
            blockNumber: 101, blockHash: HASH_B, transactionHash: HASH_B,
            transactionIndex: 0, logIndex: 2, fromWallet: ALICE,
            toWallet: ZERO, amountRaw: '6',
          }),
          transfer(TOKEN),
          transfer(TOKEN, {
            transactionHash: `0x${'c'.repeat(64)}`, transactionIndex: 1, logIndex: 1,
            fromWallet: ALICE, toWallet: BOB, amountRaw: '4',
          }),
        ],
      };
      assert.deepEqual(await repository.commitRange(range), {
        status: 'committed', tokenAddress: TOKEN, transfers: 3, touchedWallets: 2,
        holderDelta: 1, holderCount: '1', backfillNextBlock: '102',
        liveThroughBlock: '101', liveThroughHash: HASH_B, version: 1,
      });
      await assert.rejects(
        repository.commitRange(range),
        (error) => error.code === 'holder_backfill_cursor_stale'
      );
      assert.equal((await repository.commitRange({
        tokenAddress: TOKEN, fromBlock: 102, toBlock: 102,
        checkpoint: { number: 102, hash: HASH_C }, transfers: [],
      })).backfillNextBlock, '103');
      const driftRange = {
        tokenAddress: DRIFT_TOKEN, fromBlock: 200, toBlock: 200,
        checkpoint: { number: 200, hash: HASH_B },
        transfers: [transfer(DRIFT_TOKEN, {
          blockNumber: 200, blockHash: HASH_B, fromWallet: ALICE,
          toWallet: BOB, amountRaw: '1',
        })],
      };
      const suspected = await repository.commitRange(driftRange);
      assert.equal(suspected.status, 'drift-suspected');
      assert.equal(suspected.reason, 'holder_negative_balance');
      assert.equal(suspected.failedBlock, '200');
      assert.match(suspected.fingerprint, new RegExp(HASH_B));
      const pendingState = await client.query(
        `SELECT ledger_status FROM robinhood_holder_token_states WHERE token_address = $1`,
        [DRIFT_TOKEN]
      );
      assert.equal(pendingState.rows[0].ledger_status, 'backfilling');
      const drifted = await repository.commitRange({ ...driftRange, confirmDrift: true });
      assert.deepEqual(drifted, {
        status: 'drifted', tokenAddress: DRIFT_TOKEN, reason: 'holder_negative_balance',
      });
      const balances = await client.query(
        `SELECT token_address, wallet_address, balance_raw
           FROM robinhood_holder_balances ORDER BY token_address, wallet_address`
      );
      assert.deepEqual(balances.rows.map((row) => [
        row.token_address, row.wallet_address, String(row.balance_raw),
      ]), [[TOKEN, BOB, '4']]);
      const states = await client.query(
        `SELECT token_address, holder_count, ledger_status, backfill_next_block,
                live_through_block FROM robinhood_holder_token_states ORDER BY token_address`
      );
      assert.deepEqual(states.rows.map((row) => ({
        token: row.token_address, count: String(row.holder_count), status: row.ledger_status,
        next: String(row.backfill_next_block), live: row.live_through_block == null
          ? null : String(row.live_through_block),
      })), [
        { token: TOKEN, count: '1', status: 'backfilling', next: '103', live: '102' },
        { token: DRIFT_TOKEN, count: '0', status: 'drifted', next: '200', live: null },
      ]);
      assert.equal(await repository.getNextToken({ throughBlock: '102' }), null);
      assert.deepEqual(await repository.getNextToken({ throughBlock: '103' }), {
        tokenAddress: TOKEN, deploymentBlock: '100', backfillNextBlock: '103',
        liveThroughBlock: '102', liveThroughHash: HASH_C, version: 2,
      });
      await client.query(
        `INSERT INTO robinhood_holder_token_states (
           token_address, ledger_status, deployment_block, backfill_next_block
         ) VALUES ($1, 'backfilling', 150, 150)`, [PRIORITY_TOKEN]
      );
      assert.deepEqual(await repository.getNextToken({ throughBlock: '200' }), {
        tokenAddress: TOKEN, deploymentBlock: '100', backfillNextBlock: '103',
        liveThroughBlock: '102', liveThroughHash: HASH_C, version: 2,
      });
      assert.deepEqual(await repository.getNextToken({
        throughBlock: '200', excludeTokenAddresses: [TOKEN],
      }), {
        tokenAddress: PRIORITY_TOKEN, deploymentBlock: '150', backfillNextBlock: '150',
        liveThroughBlock: null, liveThroughHash: null, version: 0,
      });
      const partition = await client.query(
        `SELECT mod(
           hashtextextended($1, 0) & 9223372036854775807,
           2::bigint
         )::int AS shard`,
        [PRIORITY_TOKEN]
      );
      const priorityShard = partition.rows[0].shard;
      assert.deepEqual(await repository.getNextToken({
        throughBlock: '200', excludeTokenAddresses: [TOKEN],
        shardCount: 2, shardIndex: priorityShard,
      }), {
        tokenAddress: PRIORITY_TOKEN, deploymentBlock: '150', backfillNextBlock: '150',
        liveThroughBlock: null, liveThroughHash: null, version: 0,
      });
      assert.equal(await repository.getNextToken({
        throughBlock: '200', excludeTokenAddresses: [TOKEN],
        shardCount: 2, shardIndex: 1 - priorityShard,
      }), null);
      await client.query(
        `UPDATE robinhood_holder_cursors
            SET next_block = 104, safe_head = 103, journal_floor_block = 100`
      );
      assert.equal(await repository.getNextToken({ throughBlock: '103' }), null);
      assert.deepEqual(await repository.markResyncing({
        tokenAddress: TOKEN, backfillNextBlock: '103',
      }), { status: 'resyncing', tokenAddress: TOKEN });
      assert.equal(await repository.getNextToken({ throughBlock: '103' }), null);
      assert.equal(await requeueCandidate(client, {
        tokenAddress: DRIFT_TOKEN, version: '1', backfillNextBlock: '200',
      }), true);
      assert.equal(await requeueCandidate(client, {
        tokenAddress: DRIFT_TOKEN, version: '1', backfillNextBlock: '200',
      }), false);
      const recovered = await client.query(
        `SELECT ledger_status, version FROM robinhood_holder_token_states
          WHERE token_address = $1`, [DRIFT_TOKEN]
      );
      assert.deepEqual(recovered.rows[0], { ledger_status: 'backfilling', version: '2' });

      await client.query(
        `INSERT INTO robinhood_holder_token_states (
           token_address, holder_count, ledger_status, deployment_block,
           backfill_next_block, live_through_block, live_through_hash
         ) VALUES ($1, 1, 'backfilling', 100, 150, 200, $2)`, [REPAIR_TOKEN, HASH_A]
      );
      await client.query(
        `INSERT INTO robinhood_holder_balances (
           token_address, wallet_address, balance_raw, last_block_number,
           last_transaction_hash, last_log_index
         ) VALUES ($1, $2, 1, 200, $3, 0)`, [REPAIR_TOKEN, ALICE, HASH_A]
      );
      await client.query(
        `INSERT INTO robinhood_holder_transfer_journal (
           block_number, block_hash, transaction_hash, transaction_index, log_index,
           token_address, from_wallet, to_wallet, amount_raw
         ) VALUES (201, $1, $2, 0, 0, $3, $4, $5, 1)`,
        [HASH_A, HASH_B, REPAIR_TOKEN, ALICE, BOB]
      );
      const preview = await runCheckpointRepair({ database });
      assert.equal(preview.mode, 'dry-run');
      assert.deepEqual(preview.candidates.map(({ tokenAddress }) => tokenAddress), [REPAIR_TOKEN]);
      await client.query(
        `UPDATE robinhood_holder_token_states SET version = version + 1
          WHERE token_address = $1`, [REPAIR_TOKEN]
      );
      assert.equal(await resetCandidate(database, preview.candidates[0]), null);
      const repair = await runCheckpointRepair({ database, confirm: true });
      assert.equal(repair.repaired[0].restartBlock, '100');
      assert.equal(repair.repaired[0].deletedBalances, 1);
      assert.equal(repair.repaired[0].deletedJournalEvents, 1);
      const reset = await client.query(
        `SELECT holder_count, backfill_next_block, live_through_block, version
           FROM robinhood_holder_token_states WHERE token_address = $1`, [REPAIR_TOKEN]
      );
      assert.deepEqual({
        holderCount: String(reset.rows[0].holder_count),
        nextBlock: String(reset.rows[0].backfill_next_block),
        liveThroughBlock: reset.rows[0].live_through_block,
        version: String(reset.rows[0].version),
      }, { holderCount: '0', nextBlock: '100', liveThroughBlock: null, version: '2' });

      await client.query(
        `INSERT INTO robinhood_holder_token_states (
           token_address, holder_count, ledger_status, deployment_block,
           backfill_next_block, live_through_block, live_through_hash
         ) VALUES ($1, 1, 'shadow', 100, 201, 200, $2)`, [SHADOW_TOKEN, HASH_A]
      );
      await client.query(
        `INSERT INTO robinhood_holder_balances (
           token_address, wallet_address, balance_raw, last_block_number,
           last_transaction_hash, last_log_index
         ) VALUES ($1, $2, 1, 200, $3, 0)`, [SHADOW_TOKEN, ALICE, HASH_A]
      );
      await client.query(
        `INSERT INTO robinhood_holder_transfer_journal (
           block_number, block_hash, transaction_hash, transaction_index, log_index,
           token_address, from_wallet, to_wallet, amount_raw
         ) VALUES (500, $1, $2, 0, 0, $3, $4, $5, 1)`,
        [HASH_D, HASH_D, SHADOW_TOKEN, ALICE, BOB]
      );
      const tailPreview = await runWideTailRequeue({ database, receiptBlockLimit: 250 });
      assert.deepEqual(tailPreview.candidates.map(({ tokenAddress }) => tokenAddress), [
        SHADOW_TOKEN,
      ]);
      await client.query(
        `UPDATE robinhood_holder_token_states SET version = version + 1
          WHERE token_address = $1`, [SHADOW_TOKEN]
      );
      assert.equal(await requeueWideTail(database, tailPreview.candidates[0], 250), null);
      const tailRequeue = await runWideTailRequeue({
        database, receiptBlockLimit: 250, confirm: true,
      });
      assert.equal(tailRequeue.requeued[0].backfillNextBlock, '201');
      const preserved = await client.query(
        `SELECT state.ledger_status, state.holder_count, state.backfill_next_block,
                state.live_through_block, state.version,
                (SELECT COUNT(*) FROM robinhood_holder_balances balances
                  WHERE balances.token_address = state.token_address)::int AS balances,
                (SELECT COUNT(*) FROM robinhood_holder_transfer_journal journal
                  WHERE journal.token_address = state.token_address)::int AS journal_events
           FROM robinhood_holder_token_states state WHERE state.token_address = $1`,
        [SHADOW_TOKEN]
      );
      assert.deepEqual({
        status: preserved.rows[0].ledger_status,
        holderCount: String(preserved.rows[0].holder_count),
        nextBlock: String(preserved.rows[0].backfill_next_block),
        liveThroughBlock: String(preserved.rows[0].live_through_block),
        version: String(preserved.rows[0].version),
        balances: Number(preserved.rows[0].balances),
        journalEvents: Number(preserved.rows[0].journal_events),
      }, {
        status: 'backfilling', holderCount: '1', nextBlock: '201',
        liveThroughBlock: '200', version: '2', balances: 1, journalEvents: 1,
      });

      await client.query(
        `INSERT INTO robinhood_holder_token_states (
           token_address, holder_count, ledger_status, deployment_block,
           backfill_next_block, live_through_block, live_through_hash
         ) VALUES ($1, 1, 'backfilling', 100, 150, 149, $2)`,
        [QUARANTINE_TOKEN, HASH_E]
      );
      await client.query(
        `INSERT INTO robinhood_holder_balances (
           token_address, wallet_address, balance_raw, last_block_number,
           last_transaction_hash, last_log_index
         ) VALUES ($1, $2, 1, 149, $3, 0)`, [QUARANTINE_TOKEN, ALICE, HASH_E]
      );
      await client.query(
        `INSERT INTO robinhood_holder_transfer_journal (
           block_number, block_hash, transaction_hash, transaction_index, log_index,
           token_address, from_wallet, to_wallet, amount_raw
         ) VALUES (500, $1, $1, 0, 0, $2, $3, $4, 1)`,
        [HASH_E, QUARANTINE_TOKEN, ALICE, BOB]
      );
      await client.query(
        `INSERT INTO robinhood_holder_global_backfill_runs (
           id, status, catalog_cutoff, next_block
         ) VALUES (9001, 'scanning', NOW(), 100)`
      );
      await client.query(
        `INSERT INTO robinhood_holder_global_backfill_tokens (run_id, token_address)
         VALUES (9001, $1)`, [QUARANTINE_TOKEN]
      );
      const quarantinePreview = await runHolderQuarantine({
        database, tokenAddress: QUARANTINE_TOKEN,
      });
      assert.deepEqual({
        mode: quarantinePreview.mode,
        eligible: quarantinePreview.candidate.eligible,
        balances: quarantinePreview.candidate.balanceRows,
        pending: quarantinePreview.candidate.pendingEvents,
        applied: quarantinePreview.candidate.appliedEvents,
        activeCampaigns: quarantinePreview.candidate.activeCampaigns,
      }, {
        mode: 'dry-run', eligible: true, balances: 1, pending: 1, applied: 0,
        activeCampaigns: 1,
      });
      await client.query(
        `INSERT INTO worker_leases (lease_key, owner_id, lease_until)
         VALUES ('robinhood-holder-live-apply-worker', 'test-owner',
                 NOW() + INTERVAL '1 minute')`
      );
      await assert.rejects(
        runHolderQuarantine({
          database, tokenAddress: QUARANTINE_TOKEN, confirm: true,
        }),
        (error) => error.code === 'holder_quarantine_writer_active'
      );
      await client.query(`DELETE FROM worker_leases
        WHERE lease_key = 'robinhood-holder-live-apply-worker'`);
      const quarantine = await runHolderQuarantine({
        database, tokenAddress: QUARANTINE_TOKEN, confirm: true,
      });
      assert.deepEqual(quarantine.quarantined, {
        tokenAddress: QUARANTINE_TOKEN, ledgerStatus: 'drifted', restartBlock: '100',
        version: '1', deletedBalances: 1, deletedJournalEvents: 1,
        excludedCampaignTokens: 1,
      });
      const quarantined = await client.query(
        `SELECT state.ledger_status, state.holder_count, state.backfill_next_block,
                state.live_through_block,
                (SELECT COUNT(*) FROM robinhood_holder_balances balances
                  WHERE balances.token_address = state.token_address)::int AS balances,
                (SELECT COUNT(*) FROM robinhood_holder_transfer_journal journal
                  WHERE journal.token_address = state.token_address)::int AS journal_events
           FROM robinhood_holder_token_states state WHERE state.token_address = $1`,
        [QUARANTINE_TOKEN]
      );
      assert.deepEqual({
        status: quarantined.rows[0].ledger_status,
        holderCount: String(quarantined.rows[0].holder_count),
        nextBlock: String(quarantined.rows[0].backfill_next_block),
        liveThroughBlock: quarantined.rows[0].live_through_block,
        balances: Number(quarantined.rows[0].balances),
        journalEvents: Number(quarantined.rows[0].journal_events),
      }, {
        status: 'drifted', holderCount: '0', nextBlock: '100', liveThroughBlock: null,
        balances: 0, journalEvents: 0,
      });
      const excludedCampaign = await client.query(
        `SELECT status, holder_count, exclusion_reason
           FROM robinhood_holder_global_backfill_tokens
          WHERE run_id = 9001 AND token_address = $1`, [QUARANTINE_TOKEN]
      );
      assert.deepEqual(excludedCampaign.rows[0], {
        status: 'excluded', holder_count: '0',
        exclusion_reason: 'operator_quarantine_pathological_volume',
      });
    } finally {
      client.release();
    }
  });
});
