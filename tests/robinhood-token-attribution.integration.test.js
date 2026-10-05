process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const {
  createRobinhoodTokenAttributionRepository,
} = require('../src/models/robinhood-token-attribution');
const { createRobinhoodCanonicalDirectCreatorSource } = require(
  '../src/models/robinhood-canonical-direct-creator-source'
);
const { assertUsingTestDatabase } = require('./helpers/test-db');

const TOKEN = `0x${'a'.repeat(40)}`;
const CREATOR = `0x${'b'.repeat(40)}`;
const TRANSACTION_HASH = `0x${'c'.repeat(64)}`;

before(() => assertUsingTestDatabase(db));
after(() => db.pool.end());

describe('Robinhood token attribution persistence', () => {
  it('upgrades a Blockscout hint to verified direct or trace provenance atomically', async () => {
    const client = await db.getClient();
    try {
      await client.query(`CREATE TEMP TABLE robinhood_chain_capture_cursor (
        chain varchar(16) PRIMARY KEY, recovery_state text NOT NULL
      )`);
      await client.query(
        `INSERT INTO robinhood_chain_capture_cursor VALUES ('robinhood', 'running')`
      );
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

      const direct = {
        tokenAddress: TOKEN, creatorAddress: CREATOR,
        transactionHash: TRANSACTION_HASH, blockNumber: '123',
        source: 'rpc_direct', factoryAddress: null,
      };
      assert.deepEqual(await repository.recordVerifiedDirectDeployments([
        direct, { ...direct },
      ]), { attributed: 1 });
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
      const traceEvidence = {
        tokenAddress: TOKEN, creatorAddress: CREATOR,
        transactionHash: TRANSACTION_HASH, blockNumber: '124',
        source: 'rpc_trace', factoryAddress,
      };
      assert.deepEqual(await repository.recordVerifiedDirectDeployments([
        traceEvidence, { ...traceEvidence, blockNumber: '122', factoryAddress: CREATOR },
      ]), { attributed: 1 });
      const traced = await client.query(
        `SELECT source, attribution_block::text, attribution_factory_address
           FROM robinhood_token_attributions WHERE token_address = $1`, [TOKEN]
      );
      assert.deepEqual(traced.rows[0], {
        source: 'rpc_trace', attribution_block: '124',
        attribution_factory_address: factoryAddress,
      });
      const launchpadEvidence = {
        tokenAddress: TOKEN, creatorAddress: CREATOR,
        transactionHash: TRANSACTION_HASH, blockNumber: '125',
        source: 'launchpad_event', factoryAddress,
      };
      assert.deepEqual(await repository.recordVerifiedDirectDeployments([
        launchpadEvidence, { ...direct, blockNumber: '126' },
        { ...launchpadEvidence },
      ]), { attributed: 1 });
      const launchpad = await client.query(
        `SELECT source, attribution_block::text, attribution_factory_address
           FROM robinhood_token_attributions WHERE token_address = $1`, [TOKEN]
      );
      assert.deepEqual(launchpad.rows[0], {
        source: 'launchpad_event', attribution_block: '125',
        attribution_factory_address: factoryAddress,
      });
    } finally {
      await client.query('DROP TABLE IF EXISTS robinhood_token_attributions').catch(() => {});
      await client.query('DROP TABLE IF EXISTS robinhood_chain_capture_cursor').catch(() => {});
      client.release();
    }
  });

  it('skips repeated failed creations and advances the canonical creator page atomically', async () => {
    const client = await db.getClient();
    const tables = [
      'robinhood_chain_capture_cursor', 'robinhood_chain_blocks',
      'robinhood_chain_transactions', 'robinhood_chain_events',
      'robinhood_direct_creator_cursors', 'robinhood_token_attributions',
    ];
    try {
      await client.query(`CREATE TEMP TABLE robinhood_chain_capture_cursor (
        chain text PRIMARY KEY, recovery_state text, node_head bigint, checkpoint_block bigint
      );
      CREATE TEMP TABLE robinhood_chain_blocks (
        chain text, block_number bigint, block_hash text, block_timestamp timestamptz,
        canonical boolean, PRIMARY KEY (chain, block_hash)
      );
      CREATE TEMP TABLE robinhood_chain_transactions (
        chain text, block_hash text, transaction_hash text, transaction_index integer,
        from_address text, to_address text, contract_address text, receipt_succeeded boolean
      );
      CREATE TEMP TABLE robinhood_chain_events (
        chain text, block_number bigint, block_hash text, transaction_hash text,
        transaction_index integer, log_index integer, address text, topics text[],
        topic0 text, data text
      );
      CREATE TEMP TABLE robinhood_direct_creator_cursors (
        chain text, stream text, next_block bigint, safe_head bigint,
        checkpoint_block bigint, checkpoint_hash text, checkpoint_timestamp timestamptz,
        updated_at timestamptz DEFAULT NOW()
      );
      CREATE TEMP TABLE robinhood_token_attributions (
        chain text, token_address text, creator_address text, source text,
        attribution_block bigint, attribution_tx_hash text, attribution_factory_address text,
        last_attempted_at timestamptz, last_resolved_at timestamptz, last_error text,
        updated_at timestamptz DEFAULT NOW(), PRIMARY KEY (chain, token_address)
      )`);
      await client.query(`INSERT INTO robinhood_chain_capture_cursor
        VALUES ('robinhood','running',104,104);
        INSERT INTO robinhood_direct_creator_cursors(chain,stream,next_block,safe_head)
        VALUES ('robinhood','live',100,99)`);
      for (let index = 0; index < 5; index += 1) {
        const hash = `0x${String(index + 1).repeat(64)}`;
        await client.query(`INSERT INTO robinhood_chain_blocks
          VALUES ('robinhood',$1,$2,'2026-10-05T09:59:10Z',true)`, [100 + index, hash]);
        await client.query(`INSERT INTO robinhood_chain_transactions
          VALUES ('robinhood',$1,$2,0,$3,NULL,$4,$5)`, [
          hash, `0x${String(index + 6).repeat(64)}`, CREATOR,
          index < 4 ? TOKEN : `0x${'d'.repeat(40)}`, index === 4,
        ]);
      }
      const database = {
        getClient: async () => ({ query: client.query.bind(client), release() {} }),
      };
      const source = createRobinhoodCanonicalDirectCreatorSource({ database });
      const blocks = [...(await source.readRange(100n, 104n)).values()];
      assert.equal(blocks.slice(0, 4).flatMap((block) => block.deployments).length, 0);
      assert.equal(blocks[4].deployments.length, 1);
      blocks[4].deployments.push({ ...blocks[4].deployments[0] });
      const repository = createRobinhoodTokenAttributionRepository({ database });
      const result = await repository.recordCreatorRange({ blocks, safeHead: '104' });
      assert.equal(result.attributed, 1);
      const persisted = await client.query(`SELECT cursor.next_block::text,
        cursor.checkpoint_block::text, attribution.token_address, attribution.attribution_block::text
        FROM robinhood_direct_creator_cursors cursor
        JOIN robinhood_token_attributions attribution USING(chain)`);
      assert.deepEqual(persisted.rows, [{
        next_block: '105', checkpoint_block: '104', token_address: `0x${'d'.repeat(40)}`,
        attribution_block: '104',
      }]);
      await client.query(`UPDATE robinhood_direct_creator_cursors SET next_block=100`);
      await assert.rejects(repository.recordCreatorRange({
        blocks: blocks.map((block, index) => index === 4
          ? { ...block, blockHash: `0x${'f'.repeat(64)}` } : block), safeHead: '104',
      }), (error) => error.code === 'creator_recovery_fence_conflict');
      const afterFailure = await client.query(`SELECT next_block::text
        FROM robinhood_direct_creator_cursors`);
      assert.equal(afterFailure.rows[0].next_block, '100');
    } finally {
      for (const table of tables) {
        await client.query(`DROP TABLE IF EXISTS pg_temp.${table}`).catch(() => {});
      }
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
