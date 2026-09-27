process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const db = require('../src/models/db');
const { assertUsingTestDatabase } = require('./helpers/test-db');
const {
  createRobinhoodWalletRankingTransferClassificationRepository,
} = require('../src/models/robinhood-wallet-ranking-transfer-classification');

const TOKEN = `0x${'a'.repeat(40)}`;
const OTHER_TOKEN = `0x${'b'.repeat(40)}`;
const WALLET_A = `0x${'1'.repeat(40)}`;
const WALLET_B = `0x${'2'.repeat(40)}`;
const WALLET_C = `0x${'3'.repeat(40)}`;
const START = '2026-09-26T12:00:00.000Z';
const END = '2026-09-27T12:00:00.000Z';

describe('Robinhood ranking transfer classification audit', () => {
  it('flags unresolved and mismatched raw transfers per wallet/token and window', async () => {
    await assertUsingTestDatabase(db);
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      await client.query(`CREATE TEMP TABLE robinhood_token_transfer_events (
        chain varchar, token_address varchar, from_wallet varchar, to_wallet varchar,
        block_time timestamptz, amount_raw numeric, transfer_kind varchar,
        classification_version varchar
      ) ON COMMIT DROP`);
      await client.query(`INSERT INTO robinhood_token_transfer_events VALUES
        ('robinhood', $1, $2, $4, '2026-09-27T00:00:00Z', 1,
         'unknown', 'rh_transfer_v1'),
        ('robinhood', $1, $2, $4, '2026-09-27T01:00:00Z', 2,
         'wallet_transfer', 'rh_transfer_v0'),
        ('robinhood', $1, $3, $4, '2026-09-27T02:00:00Z', 3,
         'wallet_transfer', 'rh_transfer_v1'),
        ('robinhood', $5, $2, $4, '2026-09-27T03:00:00Z', 4,
         'unclassified', NULL),
        ('robinhood', $1, $2, $4, '2026-09-26T11:59:00Z', 5,
         'unclassified', NULL)`, [TOKEN, WALLET_A, WALLET_B, WALLET_C, OTHER_TOKEN]);
      const repository = createRobinhoodWalletRankingTransferClassificationRepository({
        database: { queryWithStatementTimeout: (sql, params) => client.query(sql, params) },
      });
      const input = { pairs: [
        { tokenAddress: TOKEN, walletAddress: WALLET_A },
        { tokenAddress: TOKEN, walletAddress: WALLET_B },
      ], windowStart: START, asOf: END, classificationVersion: 'rh_transfer_v1' };
      const [a, b] = await repository.inspectWindow(input);
      assert.deepEqual(a.reasons, [
        'transfer_classification_unresolved', 'transfer_classification_version_mismatch',
      ]);
      assert.equal(a.rawRowsClassified, false);
      assert.equal(a.sourceCoverageVerified, false);
      assert.equal(b.rawRowsClassified, true);

      await client.query(`DELETE FROM robinhood_token_transfer_events
        WHERE token_address=$1 AND transfer_kind='unknown'`, [TOKEN]);
      const [stale] = await repository.inspectWindow(input);
      assert.deepEqual(stale.reasons, ['transfer_classification_version_mismatch']);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('rejects unbounded pairs, duplicate pairs and oversized windows', async () => {
    const repository = createRobinhoodWalletRankingTransferClassificationRepository({
      database: { queryWithStatementTimeout() { throw new Error('unexpected query'); } },
    });
    const pair = { tokenAddress: TOKEN, walletAddress: WALLET_A };
    const input = { pairs: [pair], windowStart: START, asOf: END,
      classificationVersion: 'rh_transfer_v1' };
    await assert.rejects(repository.inspectWindow({ ...input, pairs: Array(21).fill(pair) }),
      /at most 20/);
    await assert.rejects(repository.inspectWindow({ ...input, pairs: [pair, pair] }),
      /duplicate wallet\/token pair/);
    await assert.rejects(repository.inspectWindow({ ...input, windowStart: '2026-08-01' }),
      /at most 30 days/);
  });
});
