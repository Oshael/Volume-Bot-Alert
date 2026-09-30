process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, describe, it } = require('node:test');
const db = require('../src/models/db');
const { assertUsingTestDatabase } = require('./helpers/test-db');
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

describe('Robinhood ranking transfer scan coverage', () => {
  after(async () => db.pool.end());
  it('requires continuous canonical live scans and available raw partitions', async () => {
    await assertUsingTestDatabase(db);
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      await client.query(`CREATE TEMP TABLE robinhood_wallet_transfer_scan_scopes (
        scan_scope_id bigint GENERATED ALWAYS AS IDENTITY,
        chain text, projection_version text, stream text, from_block bigint,
        through_block bigint, checkpoint_hash text, token_addresses text[], token_scope_hash text
      ) ON COMMIT DROP`);
      await client.query(`CREATE TEMP TABLE robinhood_wallet_transfer_token_scopes (
        chain text, scope_hash text, token_addresses text[]
      ) ON COMMIT DROP`);
      await client.query(`CREATE TEMP TABLE robinhood_chain_blocks (
        chain text, block_number bigint, block_hash text, canonical boolean
      ) ON COMMIT DROP`);
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
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
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
