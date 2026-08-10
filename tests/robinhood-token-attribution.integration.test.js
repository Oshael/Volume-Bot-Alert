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
  it('upgrades a Blockscout hint to verified direct provenance atomically', async () => {
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
    } finally { client.release(); }
  });
});
