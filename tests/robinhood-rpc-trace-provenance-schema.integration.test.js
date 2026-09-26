process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const stage110 = require('../src/utils/db-init-stage110');
const stage113 = require('../src/utils/db-init-stage113');
const stage114 = require('../src/utils/db-init-stage114');
const stage116 = require('../src/utils/db-init-stage116');
const stage163 = require('../src/utils/db-init-stage163');
const stage164 = require('../src/utils/db-init-stage164');
const stage165 = require('../src/utils/db-init-stage165');
const stage183 = require('../src/utils/db-init-stage183');
const { TRANSFER_TOPIC, ZERO_TOPIC } = require('../src/services/evm-erc20-supply-delta');
const {
  createRobinhoodTokenDeploymentOutboxRepository,
} = require('../src/models/robinhood-token-deployment-outbox');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const TOKEN = `0x${'6'.repeat(40)}`;
const CREATOR = `0x${'7'.repeat(40)}`;
const FACTORY = `0x${'8'.repeat(40)}`;
const HASH = `0x${'9'.repeat(64)}`;
const INTERNAL_TOKEN = `0x${'a'.repeat(40)}`;
const CODE_TOKEN = `0x${'b'.repeat(40)}`;
const APPLIED_MINT_TOKEN = `0x${'c'.repeat(40)}`;
const APPLIED_MINT_HASH = `0x${'e'.repeat(64)}`;

describe('Robinhood RPC trace provenance schema integration', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage110.init({ closePool: false });
    await stage113.init({ closePool: false });
    await stage114.init({ closePool: false });
    await stage116.init({ closePool: false });
    await stage163.init({ closePool: false });
    await stage164.init({ closePool: false });
    await stage165.init({ closePool: false });
    await stage183.init({ closePool: false });
    await db.query(
      'DELETE FROM robinhood_token_attributions WHERE token_address = ANY($1::varchar[])',
      [[TOKEN, INTERNAL_TOKEN, CODE_TOKEN]]
    );
  });

  after(async () => {
    await db.query(
      'DELETE FROM robinhood_token_attributions WHERE token_address = ANY($1::varchar[])',
      [[TOKEN, INTERNAL_TOKEN, CODE_TOKEN]]
    );
    await db.pool.end();
  });

  it('accepts traced factory evidence and rejects it without the factory', async () => {
    await db.query(
      `INSERT INTO robinhood_token_attributions (
         token_address, creator_address, source, attribution_block,
         attribution_tx_hash, attribution_factory_address, last_resolved_at
       ) VALUES ($1, $2, 'rpc_trace', 100, $3, $4, NOW())`,
      [TOKEN, CREATOR, HASH, FACTORY]
    );
    const result = await db.query(
      `SELECT source, attribution_factory_address
         FROM robinhood_token_attributions WHERE token_address = $1`, [TOKEN]
    );
    assert.deepEqual(result.rows[0], {
      source: 'rpc_trace', attribution_factory_address: FACTORY,
    });
    await assert.rejects(
      db.query(
        `UPDATE robinhood_token_attributions
            SET attribution_factory_address = NULL WHERE token_address = $1`, [TOKEN]
      ),
      /robinhood_token_attributions_provenance_check/
    );
  });

  it('accepts Blockscout internal creation only with exact factory provenance', async () => {
    await db.query(
      `INSERT INTO robinhood_token_attributions (
         token_address, creator_address, source, attribution_block,
         attribution_tx_hash, attribution_factory_address, last_resolved_at
       ) VALUES ($1, $2, 'blockscout_internal', 101, $3, $4, NOW())`,
      [INTERNAL_TOKEN, CREATOR, HASH, FACTORY]
    );
    await assert.rejects(
      db.query(
        `UPDATE robinhood_token_attributions
            SET attribution_factory_address = NULL WHERE token_address = $1`, [INTERNAL_TOKEN]
      ),
      /robinhood_token_attributions_provenance_check/
    );
  });

  it('accepts exact code-transition evidence without creator provenance', async () => {
    await db.query(
      `INSERT INTO robinhood_token_attributions (
         token_address, source, attribution_block
       ) VALUES ($1, 'rpc_code_transition', 102)`, [CODE_TOKEN]
    );
    const result = await db.query(
      'SELECT source, attribution_block FROM robinhood_token_attributions WHERE token_address = $1',
      [CODE_TOKEN]
    );
    assert.equal(result.rows[0].source, 'rpc_code_transition');
  });

  it('atomically enqueues newly admitted Robinhood tokens', async () => {
    const address = `0x${'d'.repeat(40)}`;
    await db.query('DELETE FROM token_catalog WHERE chain = $1 AND address = $2', ['robinhood', address]);
    await db.query(
      `INSERT INTO token_catalog (chain, address, source) VALUES ('robinhood', $1, 'test')`, [address]
    );
    const result = await db.query(
      'SELECT status FROM robinhood_token_deployment_outbox WHERE token_address = $1', [address]
    );
    assert.equal(result.rows[0].status, 'pending');
    await db.query('DELETE FROM token_catalog WHERE chain = $1 AND address = $2', ['robinhood', address]);
    await db.query('DELETE FROM robinhood_token_deployment_outbox WHERE token_address = $1', [address]);
  });

  it('reads a canonical mint only from the bounded event partition', async () => {
    const client = await db.getClient();
    try {
      await client.query(`CREATE TEMP TABLE robinhood_chain_events (
        chain text, block_number bigint, block_hash text, transaction_hash text,
        transaction_index integer, log_index integer, address text, topic0 text,
        topics jsonb
      ) PARTITION BY RANGE (block_number)`);
      await client.query(`CREATE TEMP TABLE mint_events_old PARTITION OF robinhood_chain_events
        FOR VALUES FROM (0) TO (250000)`);
      await client.query(`CREATE TEMP TABLE mint_events_recent PARTITION OF robinhood_chain_events
        FOR VALUES FROM (250000) TO (500000)`);
      await client.query(`CREATE TEMP TABLE robinhood_chain_blocks (
        chain text, block_hash text, canonical boolean)`);
      await client.query(`CREATE TEMP TABLE robinhood_chain_capture_cursor (
        chain text, node_head bigint, checkpoint_block bigint)`);
      await client.query(`INSERT INTO robinhood_chain_capture_cursor VALUES
        ('robinhood', 300000, 300000)`);
      await client.query(`INSERT INTO robinhood_chain_blocks VALUES
        ('robinhood', $1, true), ('robinhood', $2, true)`,
      [HASH, `0x${'f'.repeat(64)}`]);
      await client.query(`INSERT INTO robinhood_chain_events VALUES
        ('robinhood', 100, $1, $2, 0, 0, $3, $4, $5::jsonb),
        ('robinhood', 299950, $6, $7, 0, 0, $3, $4, $5::jsonb)`,
      [`0x${'f'.repeat(64)}`, `0x${'d'.repeat(64)}`, APPLIED_MINT_TOKEN,
        TRANSFER_TOPIC, JSON.stringify([TRANSFER_TOPIC, ZERO_TOPIC]), HASH, APPLIED_MINT_HASH]);
      let eventQuery;
      const repository = createRobinhoodTokenDeploymentOutboxRepository({
        database: { query: (sql, params) => {
          if (sql.includes('FROM robinhood_chain_events event')) eventQuery = { sql, params };
          return client.query(sql, params);
        } },
      });
      assert.deepEqual(await repository.findMintHint(APPLIED_MINT_TOKEN), {
        tokenAddress: APPLIED_MINT_TOKEN,
        blockNumber: '299950',
        blockHash: HASH,
        transactionHash: APPLIED_MINT_HASH,
      });
      const plan = await client.query(`EXPLAIN (FORMAT JSON) ${eventQuery.sql}`,
        eventQuery.params);
      const planText = JSON.stringify(plan.rows[0]['QUERY PLAN']);
      assert.match(planText, /mint_events_recent/);
      assert.doesNotMatch(planText, /mint_events_old/);
    } finally {
      for (const name of ['robinhood_chain_events', 'robinhood_chain_blocks',
        'robinhood_chain_capture_cursor']) {
        await client.query(`DROP TABLE IF EXISTS pg_temp.${name} CASCADE`);
      }
      client.release();
    }
  });
});
