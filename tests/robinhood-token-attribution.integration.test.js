const assert = require('node:assert/strict');
const { after, describe, it } = require('node:test');

const db = require('../src/models/db');
const {
  createRobinhoodTokenAttributionRepository,
} = require('../src/models/robinhood-token-attribution');

const TOKEN = `0x${'a'.repeat(40)}`;
const CREATOR = `0x${'b'.repeat(40)}`;
const TRANSACTION_HASH = `0x${'c'.repeat(64)}`;

after(() => db.pool.end());

describe('Robinhood token attribution persistence', () => {
  it('upgrades a Blockscout hint to verified direct or trace provenance atomically', async () => {
    const client = await db.getClient();
    try {
      await client.query(`CREATE TEMP TABLE robinhood_token_attributions (
        chain varchar(16) NOT NULL DEFAULT 'robinhood',
        token_address varchar(42) NOT NULL,
        creator_address varchar(42),
        source varchar(32) NOT NULL,
        attribution_block bigint,
        attribution_tx_hash varchar(66),
        attribution_factory_address varchar(42),
        last_attempted_at timestamptz NOT NULL DEFAULT NOW(),
        last_resolved_at timestamptz,
        last_error varchar(500),
        created_at timestamptz NOT NULL DEFAULT NOW(),
        updated_at timestamptz NOT NULL DEFAULT NOW(),
        PRIMARY KEY (chain, token_address)
      )`);
      await client.query(
        `INSERT INTO robinhood_token_attributions (
           token_address, creator_address, source, last_resolved_at
         ) VALUES ($1, $2, 'blockscout', NOW())`,
        [TOKEN, CREATOR]
      );
      const repository = createRobinhoodTokenAttributionRepository({
        database: {
          getClient: async () => ({
            query: client.query.bind(client),
            release() {},
          }),
        },
      });

      assert.deepEqual(await repository.recordVerifiedDirectDeployments([{
        tokenAddress: TOKEN, creatorAddress: CREATOR,
        transactionHash: TRANSACTION_HASH, blockNumber: '123',
        source: 'rpc_direct', factoryAddress: null,
      }]), { attributed: 1 });
      const { rows } = await client.query(
        `SELECT source, attribution_block, attribution_tx_hash,
                attribution_factory_address, last_error
           FROM robinhood_token_attributions WHERE token_address = $1`,
        [TOKEN]
      );
      assert.deepEqual(rows, [{
        source: 'rpc_direct', attribution_block: '123',
        attribution_tx_hash: TRANSACTION_HASH,
        attribution_factory_address: null, last_error: null,
      }]);
      const factoryAddress = `0x${'d'.repeat(40)}`;
      assert.deepEqual(await repository.recordVerifiedDirectDeployments([{
        tokenAddress: TOKEN, creatorAddress: CREATOR,
        transactionHash: TRANSACTION_HASH, blockNumber: '124',
        source: 'rpc_trace', factoryAddress,
      }]), { attributed: 1 });
      const traced = await client.query(
        `SELECT source, attribution_block::text, attribution_factory_address
           FROM robinhood_token_attributions WHERE token_address = $1`, [TOKEN]
      );
      assert.deepEqual(traced.rows[0], {
        source: 'rpc_trace', attribution_block: '124',
        attribution_factory_address: factoryAddress,
      });
    } finally {
      await client.query('DROP TABLE IF EXISTS robinhood_token_attributions').catch(() => {});
      client.release();
    }
  });

  it('retries only eligible cold hints and checkpoints a verification failure', async () => {
    const client = await db.getClient();
    try {
      await client.query(`CREATE TEMP TABLE token_catalog (
        chain varchar(16) NOT NULL, address varchar(42) NOT NULL,
        first_seen_at timestamptz NOT NULL, PRIMARY KEY (chain, address)
      )`);
      await client.query(`CREATE TEMP TABLE robinhood_token_attributions (
        chain varchar(16) NOT NULL DEFAULT 'robinhood',
        token_address varchar(42) NOT NULL, creator_address varchar(42),
        source varchar(32) NOT NULL, attribution_block bigint,
        last_attempted_at timestamptz NOT NULL, last_error varchar(500),
        updated_at timestamptz NOT NULL DEFAULT NOW(),
        PRIMARY KEY (chain, token_address)
      )`);
      await client.query(`CREATE TEMP TABLE robinhood_holder_token_states (
        chain varchar(16) NOT NULL, token_address varchar(42) NOT NULL,
        PRIMARY KEY (chain, token_address)
      )`);
      const recentToken = `0x${'d'.repeat(40)}`;
      await client.query(
        `INSERT INTO token_catalog VALUES
           ('robinhood', $1, '2026-08-01T00:00:00Z'),
           ('robinhood', $2, '2026-08-02T00:00:00Z')`,
        [TOKEN, recentToken]
      );
      await client.query(
        `INSERT INTO robinhood_token_attributions (
           token_address, creator_address, source, last_attempted_at
         ) VALUES
           ($1, $3, 'blockscout', '2026-08-01T00:00:00Z'),
           ($2, $3, 'blockscout', '2026-08-09T00:00:00Z')`,
        [TOKEN, recentToken, CREATOR]
      );
      const repository = createRobinhoodTokenAttributionRepository({
        database: { query: client.query.bind(client) },
      });
      const selection = {
        admittedBefore: '2026-08-10T00:00:00Z',
        retryBefore: '2026-08-03T00:00:00Z', limit: 10,
      };

      assert.deepEqual(await repository.listHolderDirectVerificationCandidates(selection), [{
        tokenAddress: TOKEN, creatorAddress: CREATOR,
      }]);
      assert.deepEqual(await repository.recordDirectVerificationFailure({
        tokenAddress: TOKEN, error: 'holder_deployment_evidence_invalid',
      }), { recorded: true });
      assert.deepEqual(await repository.listHolderDirectVerificationCandidates(selection), []);
      const { rows } = await client.query(
        `SELECT creator_address, last_error FROM robinhood_token_attributions
          WHERE token_address = $1`, [TOKEN]
      );
      assert.deepEqual(rows, [{
        creator_address: CREATOR, last_error: 'holder_deployment_evidence_invalid',
      }]);
    } finally {
      await client.query(
        'DROP TABLE IF EXISTS robinhood_holder_token_states, robinhood_token_attributions, token_catalog'
      ).catch(() => {});
      client.release();
    }
  });
});
