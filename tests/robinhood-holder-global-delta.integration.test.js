const assert = require('node:assert/strict');
const { after, describe, it } = require('node:test');

const db = require('../src/models/db');
const {
  createRobinhoodHolderGlobalDeltaRepository,
} = require('../src/models/robinhood-holder-global-delta');

const TOKENS = ['a', 'b', 'c', 'd'].map((digit) => `0x${digit.repeat(40)}`);
const WALLET = `0x${'e'.repeat(40)}`;
const HASH = `0x${'f'.repeat(64)}`;

after(() => db.pool.end());

describe('Robinhood holder global delta persistence', () => {
  it('atomically adopts partial and stateless tokens with exact deployment evidence', async () => {
    const client = await db.getClient();
    try {
      await client.query(`CREATE TEMP TABLE token_catalog (
        chain varchar(16) NOT NULL, address varchar(42) NOT NULL,
        first_seen_at timestamptz NOT NULL, PRIMARY KEY (chain, address)
      )`);
      await client.query(`CREATE TEMP TABLE robinhood_token_attributions (
        chain varchar(16) NOT NULL, token_address varchar(42) NOT NULL,
        source varchar(32) NOT NULL, attribution_block bigint,
        PRIMARY KEY (chain, token_address)
      )`);
      for (const table of [
        'robinhood_holder_token_states', 'robinhood_holder_balances',
        'robinhood_holder_transfer_journal', 'robinhood_holder_cursors',
        'robinhood_holder_global_backfill_runs', 'robinhood_holder_global_backfill_tokens',
      ]) {
        await client.query(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
      }
      await client.query(
        `INSERT INTO token_catalog VALUES
          ('robinhood', $1, '2026-08-11T00:00:00Z'),
          ('robinhood', $2, '2026-08-11T01:00:00Z'),
          ('robinhood', $3, '2026-08-13T00:00:00Z'),
          ('robinhood', $4, '2026-08-11T02:00:00Z')`, TOKENS
      );
      await client.query(
        `INSERT INTO robinhood_token_attributions VALUES
          ('robinhood', $1, 'rpc_direct', 100),
          ('robinhood', $2, 'rpc_code_transition', 200),
          ('robinhood', $3, 'rpc_direct', 300),
          ('robinhood', $4, 'rpc_direct', 400)`, TOKENS
      );
      await client.query(
        `INSERT INTO robinhood_holder_token_states (
           token_address, holder_count, ledger_status, deployment_block, backfill_next_block
         ) VALUES ($1, 1, 'backfilling', 100, 500), ($2, 1, 'live', 400, 1001)`,
        [TOKENS[0], TOKENS[3]]
      );
      await client.query(
        `INSERT INTO robinhood_holder_balances (
           token_address, wallet_address, balance_raw, last_block_number,
           last_transaction_hash, last_log_index
         ) VALUES ($1, $2, 1, 499, $3, 0)`, [TOKENS[0], WALLET, HASH]
      );
      await client.query(
        `INSERT INTO robinhood_holder_transfer_journal (
           block_number, block_hash, transaction_hash, transaction_index,
           log_index, token_address, from_wallet, to_wallet, amount_raw
         ) VALUES (600, $1, $1, 0, 0, $2, $3, $4, 1)`,
        [HASH, TOKENS[0], `0x${'0'.repeat(40)}`, WALLET]
      );
      await client.query(
        `INSERT INTO robinhood_holder_cursors (
           next_block, safe_head, checkpoint_block, checkpoint_hash
         ) VALUES (1001, 1000, 1000, $1)`, [HASH]
      );
      await client.query(
        `INSERT INTO robinhood_holder_global_backfill_runs (
           status, catalog_cutoff, completed_at
         ) VALUES ('completed', '2026-08-10T00:00:00Z', NOW())`
      );
      const database = {
        getClient: async () => ({ query: client.query.bind(client), release() {} }),
        query: client.query.bind(client),
      };
      const repository = createRobinhoodHolderGlobalDeltaRepository({ database });
      const preview = await repository.previewRun({
        catalogCutoff: '2026-08-12T00:00:00Z',
      });
      assert.deepEqual(preview, {
        candidateTokens: 2, unseededTokens: 1, adoptedBackfillingTokens: 1,
        startBlock: '100', safeHead: '1000', scanBlocks: '901',
        balanceRows: 1, journalEvents: 1,
      });
      assert.deepEqual(await repository.previewRun({
        catalogCutoff: '2026-08-12T00:00:00Z', includeUnseeded: false,
      }), {
        candidateTokens: 1, unseededTokens: 0, adoptedBackfillingTokens: 1,
        startBlock: '100', safeHead: '1000', scanBlocks: '901',
        balanceRows: 1, journalEvents: 1,
      });
      assert.deepEqual(await repository.previewRun({
        catalogCutoff: '2026-08-12T00:00:00Z',
        catalogFloor: '2026-08-11T00:30:00Z',
      }), {
        candidateTokens: 1, unseededTokens: 1, adoptedBackfillingTokens: 0,
        startBlock: '200', safeHead: '1000', scanBlocks: '801',
        balanceRows: 0, journalEvents: 0,
      });
      assert.deepEqual(await repository.previewRun({
        catalogCutoff: '2026-08-12T00:00:00Z', maximumGapBlocks: 850,
      }), {
        candidateTokens: 1, unseededTokens: 1, adoptedBackfillingTokens: 0,
        startBlock: '200', safeHead: '1000', scanBlocks: '801',
        balanceRows: 0, journalEvents: 0,
      });
      assert.deepEqual(await repository.previewRun({
        catalogCutoff: '2026-08-14T00:00:00Z',
        includeBackfilling: false, minimumGapBlocks: 750,
      }), {
        candidateTokens: 1, unseededTokens: 1, adoptedBackfillingTokens: 0,
        startBlock: '200', safeHead: '1000', scanBlocks: '801',
        balanceRows: 0, journalEvents: 0,
      });

      const created = await repository.createRun({
        catalogCutoff: '2026-08-12T00:00:00Z',
      });
      assert.equal(created.status, 'frozen');
      assert.equal(created.cohortTokens, 2);
      assert.equal(created.adoptedBackfillingTokens, 1);
      assert.equal(created.startBlock, '100');
      assert.equal(created.deletedBalances, 1);
      assert.equal(created.deletedJournalEvents, 1);
      assert.deepEqual(await client.query(
        `SELECT token_address FROM robinhood_holder_global_backfill_tokens
          WHERE run_id = $1 ORDER BY token_address`, [created.runId]
      ).then((result) => result.rows.map((row) => row.token_address)), TOKENS.slice(0, 2));
      assert.equal((await client.query(
        `SELECT COUNT(*)::int AS count FROM robinhood_holder_token_states
          WHERE token_address = $1`, [TOKENS[0]]
      )).rows[0].count, 0);
      assert.equal((await client.query(
        `SELECT version FROM robinhood_holder_cursors WHERE stream = 'live'`
      )).rows[0].version, '1');
      await assert.rejects(
        repository.createRun({ catalogCutoff: '2026-08-12T00:00:00Z' }),
        { code: 'holder_global_backfill_active_run_exists' }
      );
    } finally {
      client.release();
    }
  });
});
