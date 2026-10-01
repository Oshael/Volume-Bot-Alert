process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, describe, it } = require('node:test');
const db = require('../src/models/db');
const { assertUsingTestDatabase } = require('./helpers/test-db');
const stage261 = require('../src/utils/db-init-stage261');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');
const { persistGlobalScanProof } = require('../src/models/robinhood-wallet-transfer-global-scan-proof');
const {
  createRobinhoodWalletRankingTransferScanCoverageRepository,
} = require('../src/models/robinhood-wallet-ranking-transfer-scan-coverage');

const TOKENS = 'abcde'.split('').map((digit) => `0x${digit.repeat(40)}`);
const [COMPLETE, GAP, SEED_ONLY, ORPHAN, MISSING] = TOKENS;
const HASH_A = `0x${'1'.repeat(64)}`;
const HASH_B = `0x${'2'.repeat(64)}`;
const HASH_C = `0x${'3'.repeat(64)}`;
const HASH_D = `0x${'4'.repeat(64)}`;
const WINDOW_START = '2026-09-26T12:00:00.000Z';
const AS_OF = '2026-09-27T12:00:00.000Z';

function input(tokenAddresses = TOKENS) {
  return { tokenAddresses, fromBlock: '100', throughBlock: '109',
    windowStart: WINDOW_START, asOf: AS_OF };
}

async function withDatabase(work) {
  await assertUsingTestDatabase(db);
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE TEMP TABLE robinhood_wallet_transfer_scan_scopes (
      scan_scope_id bigint GENERATED ALWAYS AS IDENTITY,
      chain text, projection_version text, stream text, from_block bigint,
      through_block bigint, checkpoint_hash text, token_addresses text[], token_scope_hash text,
      scope_id bigint, scope_version bigint
    ) ON COMMIT DROP`);
    await client.query(`CREATE TEMP TABLE robinhood_wallet_transfer_token_scopes (
      chain text, scope_hash text, token_addresses text[]
    ) ON COMMIT DROP`);
    await client.query(`CREATE TEMP TABLE robinhood_chain_blocks (
      chain text, block_number bigint, block_hash text, canonical boolean
    ) ON COMMIT DROP`);
    await client.query(`CREATE TEMP TABLE robinhood_wallet_transfer_scope_heads (
      scope_id bigint PRIMARY KEY, chain text, projection_version text, stream text,
      state text, baseline_next_block bigint, current_version bigint
    ) ON COMMIT DROP`);
    await client.query(`CREATE TEMP TABLE robinhood_wallet_transfer_scope_versions (
      scope_id bigint, scope_version bigint, PRIMARY KEY (scope_id, scope_version)
    ) ON COMMIT DROP`);
    await client.query(`CREATE TEMP TABLE robinhood_wallet_transfer_scope_members (
      scope_id bigint, token_address text, valid_from_version bigint, valid_to_version bigint,
      PRIMARY KEY (scope_id, token_address, valid_from_version)
    ) ON COMMIT DROP`);
    await client.query(`CREATE TEMP TABLE robinhood_wallet_transfer_cursors (
      chain varchar(16),projection_version varchar(64),stream varchar(16),next_block bigint,
      next_transaction_index integer DEFAULT 0,next_log_index integer DEFAULT 0,
      version bigint,lifecycle_state text,PRIMARY KEY(chain,projection_version,stream)
    ) ON COMMIT DROP`);
    await client.query(stage261.STATEMENTS[0].replace('CREATE TABLE IF NOT EXISTS', 'CREATE TEMP TABLE'));
    await client.query(stage261.STATEMENTS[1]);
    await work(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

async function versionedFixture(client) {
  await client.query(`INSERT INTO robinhood_wallet_transfer_scope_heads VALUES
    (1,'robinhood','rh_transfer_v1','live','ready',100,2)`);
  await client.query(`INSERT INTO robinhood_wallet_transfer_scope_versions VALUES (1,0),(1,1),(1,2)`);
  await client.query(`INSERT INTO robinhood_chain_blocks VALUES
    ('robinhood',104,$1,true),('robinhood',109,$2,true),('robinhood',114,$3,true)`, [HASH_A, HASH_B, HASH_C]);
  await client.query(`INSERT INTO robinhood_wallet_transfer_scan_scopes
    (chain,projection_version,stream,from_block,through_block,checkpoint_hash,scope_id,scope_version)
    VALUES ('robinhood','rh_transfer_v1','live',100,104,$1,1,0),
      ('robinhood','rh_transfer_v1','live',105,109,$2,1,1),
      ('robinhood','rh_transfer_v1','live',110,114,$3,1,2)`, [HASH_A, HASH_B, HASH_C]);
}

function repositoryFor(client, rawTransferAvailable = true) {
  return createRobinhoodWalletRankingTransferScanCoverageRepository({
    database: { queryWithStatementTimeout: (sql, params) => client.query(sql, params) },
    availabilityRepository: { inspectWindow: async () => ({ rawTransferAvailable, partitions: [] }) },
  });
}

async function globalFixture(client, checkpointHash = HASH_B) {
  await client.query(`INSERT INTO robinhood_wallet_transfer_cursors
    (chain,projection_version,stream,next_block,version,lifecycle_state)
    VALUES ('robinhood','rh_transfer_v1','live',105,2,'running')`);
  await client.query(`INSERT INTO robinhood_chain_blocks VALUES
    ('robinhood',104,$1,true),('robinhood',109,$2,true)`, [HASH_A, checkpointHash]);
  await client.query(`INSERT INTO robinhood_wallet_transfer_scan_scopes
    (chain,projection_version,stream,from_block,through_block,checkpoint_hash,token_addresses)
    VALUES ('robinhood','rh_transfer_v1','live',100,104,$1,$2)`, [HASH_A, [COMPLETE, GAP, MISSING]]);
  return { batch: { projectionVersion: 'rh_transfer_v1', stream: 'live', expectedVersion: '2',
    nextBlock: '110', checkpointBlock: '109', checkpointHash },
  capture: { source: 'canonical-journal', complete: true, selectedLogsValidated: true,
    fromBlock: '105', throughBlock: '109', checkpointHash, observedLogs: 5,
    observedTokenAddresses: [COMPLETE, GAP], selectedTokenAddresses: [COMPLETE] } };
}
const advanceGlobal = (client) => client.query("UPDATE robinhood_wallet_transfer_cursors SET next_block=110,version=version+1");

describe('Robinhood ranking transfer scan coverage', () => {
  after(async () => db.pool.end());
  it('installs the additive global proof schema idempotently with database payload bounds', async () => {
    await withDatabase(async (client) => {
      for (const sql of stage261.STATEMENTS) {
        await client.query(sql.replace('CREATE TABLE IF NOT EXISTS', 'CREATE TEMP TABLE IF NOT EXISTS'));
      }
      const group = SCHEMA_GROUPS.find((entry) => entry.key === 'stage261-robinhood-global-transfer-scans');
      const definition = group.tables[0];
      const columns = (await client.query(`SELECT attname FROM pg_attribute
        WHERE attrelid='robinhood_wallet_transfer_global_scans'::regclass AND attnum>0 AND NOT attisdropped`)).rows;
      for (const column of definition.columns) assert.ok(columns.some((row) => row.attname === column), column);
      const constraints = (await client.query(`SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conrelid='robinhood_wallet_transfer_global_scans'::regclass`)).rows;
      for (const constraint of definition.constraints) {
        const installed = constraints.find((row) => row.conname === constraint.name)?.definition;
        assert.ok(installed && constraint.includes.every((part) => installed.includes(part)), constraint.name);
      }
      assert.ok((await client.query("SELECT to_regclass('idx_rh_transfer_global_scan_range') AS oid")).rows[0].oid);
      const { batch, capture } = await globalFixture(client);
      await persistGlobalScanProof(client, batch, capture);
      for (const mutation of ["excluded_token_addresses=ARRAY[NULL]::text[]", 'selected_contracts=3',
        'through_block=from_block+5000', "reader_version='unknown'"]) {
        await client.query('SAVEPOINT invalid_payload');
        await assert.rejects(client.query(`UPDATE robinhood_wallet_transfer_global_scans SET ${mutation}`), /constraint/);
        await client.query('ROLLBACK TO SAVEPOINT invalid_payload');
      }
    });
  });
  it('covers selected and absent tokens only after cursor confirmation, while preserving exclusions and raw gates', async () => {
    await withDatabase(async (client) => {
      const { batch, capture } = await globalFixture(client);
      await assert.rejects(persistGlobalScanProof(client, { ...batch, nextBlock: '111' }, capture), /committed batch/);
      const first = await persistGlobalScanProof(client, batch, capture);
      assert.deepEqual(await persistGlobalScanProof(client, batch, capture), first);
      await assert.rejects(persistGlobalScanProof(client, batch, { ...capture, selectedTokenAddresses: [GAP] }), /conflict/);
      const inspected = () => repositoryFor(client).inspectBlockRange(input([COMPLETE, GAP, MISSING]));
      assert.deepEqual((await inspected()).map((row) => row.scanProofReady), [false, false, false]);
      await advanceGlobal(client);
      assert.deepEqual((await inspected()).map((row) => row.scanProofReady), [true, false, true]);
      const [unavailable] = await repositoryFor(client, false).inspectBlockRange(input([MISSING]));
      assert.equal(unavailable.blockRangeCovered, true);
      assert.equal(unavailable.scanProofReady, false);
      await assert.rejects(persistGlobalScanProof(client, batch, capture), /cursor conflict/);
    });
  });
  it('rolls proof and cursor back together and requires canonical replay after a reorg', async () => {
    await withDatabase(async (client) => {
      const { batch, capture } = await globalFixture(client);
      await client.query('SAVEPOINT atomic_proof');
      await persistGlobalScanProof(client, batch, capture);
      await advanceGlobal(client);
      await client.query('ROLLBACK TO SAVEPOINT atomic_proof');
      assert.equal((await client.query('SELECT count(*)::int AS count FROM robinhood_wallet_transfer_global_scans')).rows[0].count, 0);
      await persistGlobalScanProof(client, batch, capture);
      await advanceGlobal(client);
      await client.query('UPDATE robinhood_chain_blocks SET canonical=false WHERE block_number=109');
      await client.query("UPDATE robinhood_wallet_transfer_cursors SET next_block=105,version=4");
      await assert.rejects(persistGlobalScanProof(client, { ...batch, expectedVersion: '4' }, capture), /noncanonical/);
      assert.equal((await repositoryFor(client).inspectBlockRange(input([COMPLETE])))[0].scanProofReady, false);
      await client.query(`INSERT INTO robinhood_chain_blocks VALUES ('robinhood',109,$1,true)`, [HASH_C]);
      await persistGlobalScanProof(client, { ...batch, expectedVersion: '4', checkpointHash: HASH_C }, { ...capture, checkpointHash: HASH_C });
      await advanceGlobal(client);
      assert.equal((await repositoryFor(client).inspectBlockRange(input([COMPLETE])))[0].scanProofReady, true);
    });
  });
  it('keeps global seed evidence incomplete and detects a missing range in mixed history', async () => {
    await withDatabase(async (client) => {
      const { batch, capture } = await globalFixture(client);
      await client.query(`INSERT INTO robinhood_wallet_transfer_cursors
        (chain,projection_version,stream,next_block,version,lifecycle_state)
        VALUES ('robinhood','rh_transfer_v1','seed',105,2,'running')`);
      await persistGlobalScanProof(client, { ...batch, stream: 'seed' }, capture);
      await advanceGlobal(client);
      const [seedOnly] = await repositoryFor(client).inspectBlockRange({ ...input([MISSING]), fromBlock: '105' });
      assert.deepEqual(seedOnly.coverageReasons, ['transfer_scan_seed_raw_unproven']);
      await client.query("UPDATE robinhood_wallet_transfer_cursors SET next_block=106,version=4 WHERE stream='live'");
      await persistGlobalScanProof(client, { ...batch, expectedVersion: '4' }, { ...capture, fromBlock: '106' });
      await advanceGlobal(client);
      const [gap] = await repositoryFor(client).inspectBlockRange(input([COMPLETE]));
      assert.deepEqual(gap.coverageReasons, ['transfer_scan_scope_gap']);
    });
  });
  it('requires continuous canonical live scans and available raw partitions', async () => {
    await withDatabase(async (client) => {
      await client.query(`INSERT INTO robinhood_chain_blocks VALUES
        ('robinhood', 104, $1, true), ('robinhood', 109, $2, true)`,
      [HASH_A, HASH_B]);
      await client.query(`INSERT INTO robinhood_wallet_transfer_scan_scopes (
        chain, projection_version, stream, from_block, through_block,
        checkpoint_hash, token_addresses
      ) VALUES
        ('robinhood', 'rh_transfer_v1', 'live', 100, 104, $1, ARRAY[$5, $6]),
        ('robinhood', 'rh_transfer_v1', 'live', 105, 109, $2, ARRAY[$5]),
        ('robinhood', 'rh_transfer_v1', 'seed', 100, 109, $2, ARRAY[$7]),
        ('robinhood', 'rh_transfer_v1', 'live', 100, 109, $3, ARRAY[$8]),
        ('robinhood', 'rh_transfer_v1', 'live', 105, 109, $4, ARRAY[$6])`,
      [HASH_A, HASH_B, HASH_C, HASH_D, COMPLETE, GAP, SEED_ONLY, ORPHAN]);
      // Mix legacy arrays and reusable scopes in the same canonical window.
      await client.query(`INSERT INTO robinhood_wallet_transfer_token_scopes
        VALUES ('robinhood', $1, ARRAY[$2])`, [HASH_A.slice(2), COMPLETE]);
      await client.query(`UPDATE robinhood_wallet_transfer_scan_scopes
        SET token_addresses=NULL, token_scope_hash=$1
        WHERE from_block=105 AND checkpoint_hash=$2`, [HASH_A.slice(2), HASH_B]);
      let availability = { rawTransferAvailable: true, partitions: [] };
      const repository = createRobinhoodWalletRankingTransferScanCoverageRepository({
        database: { queryWithStatementTimeout: (sql, params) => client.query(sql, params) },
        availabilityRepository: { inspectWindow: async () => availability },
      });
      const first = await repository.inspectBlockRange(input());
      assert.deepEqual(first.map((row) => [row.tokenAddress, row.scanProofReady,
        row.coverageReasons]), [
        [COMPLETE, true, []],
        [GAP, false, ['transfer_scan_scope_gap']],
        [SEED_ONLY, false, ['transfer_scan_seed_raw_unproven']],
        [ORPHAN, false, ['transfer_scan_checkpoint_unproven']],
        [MISSING, false, ['transfer_scan_scope_missing']],
      ]);
      assert.equal(first[0].windowBoundsVerified, false);
      assert.equal(first[0].sourceCoverageVerified, false);

      await client.query('UPDATE robinhood_chain_blocks SET canonical=false WHERE block_number=109');
      await client.query(`INSERT INTO robinhood_chain_blocks VALUES
        ('robinhood', 109, $1, true)`, [HASH_D]);
      await client.query(`INSERT INTO robinhood_wallet_transfer_scan_scopes (
        chain, projection_version, stream, from_block, through_block,
        checkpoint_hash, token_scope_hash
      ) VALUES ('robinhood', 'rh_transfer_v1', 'live', 105, 109, $1, $2)`,
      [HASH_D, HASH_A.slice(2)]);
      const replayed = await repository.inspectBlockRange(input([COMPLETE]));
      assert.equal(replayed[0].scanProofReady, true);

      availability = { rawTransferAvailable: false,
        partitions: [{ reasons: ['raw_transfer_partition_compacted'] }] };
      const compacted = await repository.inspectBlockRange(input([COMPLETE]));
      assert.equal(compacted[0].scanProofReady, false);
      assert.deepEqual(compacted[0].coverageReasons, ['raw_transfer_partition_compacted']);
    });
  });

  it('uses the range version for additions, removals and reentry without retroactive coverage', async () => {
    await withDatabase(async (client) => {
      await versionedFixture(client);
      await client.query(`INSERT INTO robinhood_wallet_transfer_scope_members VALUES
        (1,$1,0,NULL),(1,$2,0,1),(1,$2,2,NULL),(1,$3,1,NULL)`, [COMPLETE, GAP, SEED_ONLY]);
      const repository = repositoryFor(client);
      const whole = await repository.inspectBlockRange({ ...input(), throughBlock: '114' });
      assert.deepEqual(whole.map((row) => [row.tokenAddress, row.scanProofReady, row.coverageReasons]), [
        [COMPLETE, true, []], [GAP, false, ['transfer_scan_scope_gap']],
        [SEED_ONLY, false, ['transfer_scan_scope_gap']],
        [ORPHAN, false, ['transfer_scan_scope_missing']], [MISSING, false, ['transfer_scan_scope_missing']],
      ]);
      for (const [fromBlock, throughBlock, ready] of [
        ['100', '104', [true, true, false]],
        ['105', '109', [true, false, true]],
        ['110', '114', [true, true, true]],
      ]) {
        const rows = await repository.inspectBlockRange({ ...input([COMPLETE, GAP, SEED_ONLY]), fromBlock, throughBlock });
        assert.deepEqual(rows.map((row) => row.scanProofReady), ready);
      }
    });
  });

  it('joins all three manifest formats across a continuous window', async () => {
    await withDatabase(async (client) => {
      await versionedFixture(client);
      await client.query(`INSERT INTO robinhood_wallet_transfer_scope_members VALUES (1,$1,0,NULL)`, [COMPLETE]);
      await client.query(`UPDATE robinhood_wallet_transfer_scan_scopes
        SET scope_id=NULL,scope_version=NULL,token_addresses=ARRAY[$1] WHERE through_block=104`, [COMPLETE]);
      await client.query(`INSERT INTO robinhood_wallet_transfer_token_scopes VALUES ('robinhood',$1,ARRAY[$2])`,
      [HASH_A.slice(2), COMPLETE]);
      await client.query(`UPDATE robinhood_wallet_transfer_scan_scopes
        SET scope_id=NULL,scope_version=NULL,token_scope_hash=$1 WHERE through_block=109`, [HASH_A.slice(2)]);
      await client.query('UPDATE robinhood_wallet_transfer_scope_heads SET baseline_next_block=110');
      const [row] = await repositoryFor(client).inspectBlockRange({ ...input([COMPLETE]), throughBlock: '114' });
      assert.equal(row.scanProofReady, true);
    });
  });

  it('requires ready scope identity, committed versions and a prospective range', async () => {
    await withDatabase(async (client) => {
      await versionedFixture(client);
      await client.query(`INSERT INTO robinhood_wallet_transfer_scope_members VALUES (1,$1,0,NULL)`, [COMPLETE]);
      const repository = repositoryFor(client);
      const inspected = () => repository.inspectBlockRange({ ...input([COMPLETE]), throughBlock: '114' });
      for (const mutation of [
        "state='preparing'", "chain='other'", "projection_version='other_version'", "stream='seed'",
        'baseline_next_block=115', 'current_version=-1',
      ]) {
        await client.query('SAVEPOINT rejected_head');
        await client.query(`UPDATE robinhood_wallet_transfer_scope_heads SET ${mutation}`);
        assert.deepEqual((await inspected())[0].coverageReasons, ['transfer_scan_scope_missing'], mutation);
        await client.query('ROLLBACK TO SAVEPOINT rejected_head');
      }
      await client.query('DELETE FROM robinhood_wallet_transfer_scope_versions WHERE scope_version=1');
      assert.deepEqual((await inspected())[0].coverageReasons, ['transfer_scan_scope_gap']);
      await client.query('INSERT INTO robinhood_wallet_transfer_scope_versions VALUES (1,1)');
      await client.query('UPDATE robinhood_wallet_transfer_scope_heads SET current_version=1');
      assert.deepEqual((await inspected())[0].coverageReasons, ['transfer_scan_scope_gap']);
    });
  });

  it('keeps versioned seed-only, orphaned and unavailable raw evidence incomplete', async () => {
    await withDatabase(async (client) => {
      await versionedFixture(client);
      await client.query(`INSERT INTO robinhood_wallet_transfer_scope_members VALUES (1,$1,0,NULL)`, [COMPLETE]);
      const range = { ...input([COMPLETE]), throughBlock: '114' };
      const repository = repositoryFor(client);
      await client.query("UPDATE robinhood_wallet_transfer_scope_heads SET stream='seed'");
      await client.query("UPDATE robinhood_wallet_transfer_scan_scopes SET stream='seed'");
      assert.deepEqual((await repository.inspectBlockRange(range))[0].coverageReasons, ['transfer_scan_seed_raw_unproven']);
      await client.query("UPDATE robinhood_wallet_transfer_scope_heads SET stream='live'");
      await client.query("UPDATE robinhood_wallet_transfer_scan_scopes SET stream='live'");
      await client.query('UPDATE robinhood_chain_blocks SET canonical=false');
      assert.deepEqual((await repository.inspectBlockRange(range))[0].coverageReasons, ['transfer_scan_checkpoint_unproven']);
      await client.query('UPDATE robinhood_chain_blocks SET canonical=true');
      const [unavailable] = await repositoryFor(client, false).inspectBlockRange(range);
      assert.equal(unavailable.blockRangeCovered, true);
      assert.equal(unavailable.scanProofReady, false);
      assert.deepEqual(unavailable.coverageReasons, ['raw_transfer_availability_unverified']);
    });
  });

  it('requires a committed canonical replay to close a versioned reorg gap', async () => {
    await withDatabase(async (client) => {
      await versionedFixture(client);
      await client.query(`INSERT INTO robinhood_wallet_transfer_scope_members VALUES (1,$1,0,NULL)`, [COMPLETE]);
      const range = { ...input([COMPLETE]), throughBlock: '114' };
      const repository = repositoryFor(client);
      await client.query('UPDATE robinhood_chain_blocks SET canonical=false WHERE block_number=109');
      assert.deepEqual((await repository.inspectBlockRange(range))[0].coverageReasons, ['transfer_scan_scope_gap']);
      await client.query(`INSERT INTO robinhood_chain_blocks VALUES ('robinhood',109,$1,true)`, [HASH_D]);
      assert.equal((await repository.inspectBlockRange(range))[0].scanProofReady, false);
      await client.query(`INSERT INTO robinhood_wallet_transfer_scan_scopes
        (chain,projection_version,stream,from_block,through_block,checkpoint_hash,scope_id,scope_version)
        VALUES ('robinhood','rh_transfer_v1','live',105,109,$1,1,1)`, [HASH_D]);
      assert.equal((await repository.inspectBlockRange(range))[0].scanProofReady, true);
    });
  });

  it('rejects unbounded input before querying', async () => {
    const repository = createRobinhoodWalletRankingTransferScanCoverageRepository({
      database: { queryWithStatementTimeout() { throw new Error('unexpected query'); } },
    });
    await assert.rejects(repository.inspectBlockRange({ ...input(), throughBlock: '99' }),
      /block range is inverted/);
    await assert.rejects(repository.inspectBlockRange({ ...input(), windowStart: AS_OF }),
      /windowStart\/asOf/);
  });
});
