process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, describe, it } = require('node:test');
const db = require('../src/models/db');
const { assertUsingTestDatabase } = require('./helpers/test-db');
const {
  createRobinhoodWalletRankingProfileRepository,
} = require('../src/models/robinhood-wallet-ranking-profile');

const WALLET = `0x${'a'.repeat(40)}`;

describe('Robinhood ranking profile enrichment', () => {
  after(async () => db.pool.end());

  it('uses only explicitly resolved Robinhood wallet bindings', async () => {
    await assertUsingTestDatabase(db);
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      await client.query(`CREATE TEMP TABLE callout_profiles (
        platform text, platform_user_id text, username text, x_username text,
        display_name text, profile_picture_url text
      ) ON COMMIT DROP`);
      await client.query(`CREATE TEMP TABLE callout_wallet_observations (
        platform text, platform_user_id text, address_normalized text,
        chain_key text, last_observed_at timestamptz
      ) ON COMMIT DROP`);
      await client.query(`INSERT INTO callout_profiles VALUES
        ('fomo', 'other-chain', 'other', null, 'Wrong Chain', null),
        ('fomo', 'robinhood', 'rh', null, 'RH Trader', 'https://img.test/rh')`);
      await client.query(`INSERT INTO callout_wallet_observations VALUES
        ('fomo', 'other-chain', $1, 'ethereum', NOW()),
        ('fomo', 'robinhood', $1, 'robinhood', NOW())`, [WALLET]);
      const repository = createRobinhoodWalletRankingProfileRepository({
        database: { queryWithStatementTimeout: (sql, params) => client.query(sql, params) },
      });
      assert.deepEqual(await repository.findByWalletAddresses([WALLET]), [{
        address: WALLET, platform: 'fomo', platformUserId: 'robinhood',
        username: 'rh', xUsername: null, displayName: 'RH Trader',
        profilePictureUrl: 'https://img.test/rh',
      }]);
      await client.query(`DELETE FROM callout_wallet_observations WHERE chain_key='robinhood'`);
      assert.deepEqual(await repository.findByWalletAddresses([WALLET]), []);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
