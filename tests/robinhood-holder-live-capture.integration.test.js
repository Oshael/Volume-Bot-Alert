process.env.NODE_ENV = 'test';
const assert = require('node:assert/strict');
const { after, it } = require('node:test');
const db = require('../src/models/db');
const { assertUsingTestDatabase } = require('./helpers/test-db');
const { createRobinhoodHolderBootstrapRepository } = require('../src/models/robinhood-holder-bootstrap');
const { createRobinhoodHolderLedgerRepository } = require('../src/models/robinhood-holder-ledger');
const { createRobinhoodHolderLiveCapture } = require('../src/services/robinhood-holder-live-capture');

const OLD = `0x${'1'.repeat(40)}`;
const NEW = `0x${'2'.repeat(40)}`;
const HASH = `0x${'a'.repeat(64)}`;
after(() => db.pool.end());

it('recaptures a durably admitted token after the cursor fence rejects its old scope', async () => {
  await assertUsingTestDatabase(db);
  const client = await db.getClient();
  const tables = [
    'robinhood_holder_cursors', 'robinhood_holder_token_states',
    'robinhood_holder_transfer_journal', 'robinhood_holder_capture_policy',
    'robinhood_holder_global_backfill_runs', 'robinhood_holder_global_backfill_tokens',
    'token_catalog', 'robinhood_token_attributions', 'admin_blocked_tokens',
  ];
  try {
    await client.query('DISCARD TEMP');
    for (const table of tables) {
      await client.query(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
    }
    await client.query(`INSERT INTO robinhood_holder_capture_policy (
      chain, capture_mode, coverage_generation, cutover_next_block,
      cutover_checkpoint_block, cutover_checkpoint_hash
    ) VALUES ('robinhood','tracked',1,100,99,$1)`, [HASH]);
    await client.query(`INSERT INTO robinhood_holder_cursors (
      chain,stream,next_block,safe_head,checkpoint_block,checkpoint_hash,
      journal_floor_block,version
    ) VALUES ('robinhood','live',100,100,99,$1,90,0)`, [HASH]);
    await client.query(`INSERT INTO robinhood_holder_token_states (
      token_address,ledger_status,deployment_block,backfill_next_block,tail_capture_from_block
    ) VALUES ($1,'backfilling',90,90,100)`, [OLD]);
    await client.query(`INSERT INTO token_catalog (chain,address,first_seen_at)
      VALUES ('robinhood',$1,'2026-10-05T10:00:00Z')`, [NEW]);
    await client.query(`INSERT INTO robinhood_token_attributions (
      chain,token_address,source,attribution_block,attribution_tx_hash,attribution_factory_address
    ) VALUES ('robinhood',$1,'rpc_trace',100,$2,$3)`, [NEW, HASH, OLD]);
    const database = { query: client.query.bind(client), getClient: async () => ({
      query: client.query.bind(client), release() {},
    }) };
    const repository = createRobinhoodHolderLedgerRepository({ database });
    const bootstrap = createRobinhoodHolderBootstrapRepository({ database });
    const scopes = [];
    let commits = 0;
    let staleCommits = 0;
    const ledger = { ...repository, appendCapturedRange: async (input) => {
      commits += 1;
      try { return await repository.appendCapturedRange(input); }
      catch (error) {
        assert.equal(error.code, 'holder_cursor_stale');
        staleCommits += 1;
        assert.equal((await client.query('SELECT COUNT(*)::int n FROM robinhood_holder_transfer_journal')).rows[0].n, 0);
        const current = await repository.getCursor();
        assert.equal(current.nextBlock, '100');
        assert.equal(current.version, 1);
        throw error;
      }
    } };
    const reader = {
      getSafeHead: async () => ({ safeHead: '100' }),
      matchesCheckpoint: async () => true,
      readGlobalRange: async (input) => {
        assert.equal(input.captureAllTransfers, false);
        scopes.push(input.tokenAddresses);
        if (scopes.length === 1) {
          const admitted = await bootstrap.seedNewTokens({ admittedAfter: '2026-10-05T00:00:00Z' });
          assert.deepEqual(admitted.map((row) => row.tokenAddress), [NEW]);
        }
        return { fromBlock: input.fromBlock, toBlock: input.toBlock, nextBlock: '101',
          checkpoint: { number: '100', hash: HASH }, scopeTokens: input.tokenAddresses.length,
          transfers: input.tokenAddresses.map((tokenAddress, logIndex) => ({
            tokenAddress, blockNumber: '100', blockHash: HASH, transactionHash: HASH,
            transactionIndex: 0, logIndex, fromWallet: `0x${'0'.repeat(40)}`,
            toWallet: `0x${'3'.repeat(40)}`, amountRaw: '1',
          })), telemetry: {} };
      },
    };
    const result = await createRobinhoodHolderLiveCapture({
      ledger, reader, allowTrackedCapture: true,
    }).captureOnce();
    assert.deepEqual(scopes, [[OLD], [OLD, NEW]]);
    assert.equal(commits, 2);
    assert.equal(staleCommits, 1);
    assert.equal(result.cursorConflicts, 1);
    assert.equal(result.cursorRetries, 1);
    assert.equal(result.insertedTransfers, 2);
    assert.equal((await repository.getCursor()).nextBlock, '101');
    assert.equal((await repository.getCursor()).version, 2);
    assert.deepEqual((await client.query(`SELECT token_address,block_number::text
      FROM robinhood_holder_transfer_journal ORDER BY token_address`)).rows, [
      { token_address: OLD, block_number: '100' },
      { token_address: NEW, block_number: '100' },
    ]);
  } finally {
    await client.query('ROLLBACK');
    await client.query('DISCARD TEMP');
    client.release();
  }
});
