'use strict';

process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');
const db = require('../src/models/db');
const { createRobinhoodPersistenceRepository, __private } = require('../src/models/robinhood-persistence');
const { upsertPool } = require('../src/models/robinhood-pool-registry-write');
const { __private: { createRepository: createArchiveRepository } } = require('../src/utils/reconstruct-robinhood-v3-archive');
const { CANONICAL_CONTRACTS } = require('../src/services/robinhood-market-policy');
const { ROBINHOOD_TOKENIZED_ASSETS } = require('../src/services/robinhood-market-policy');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const TOKEN = `0x${'2'.repeat(40)}`;
const STOCK = ROBINHOOD_TOKENIZED_ASSETS.NVDA;
let client;
let repository;

function discovery(protocol, identity = '4') {
  const address = `0x${identity.repeat(40)}`;
  const poolId = `0x${identity.repeat(64)}`;
  return {
    tracked: true, chain: 'robinhood', protocol,
    kind: { 'uniswap-v2': 'pair-created', 'uniswap-v3': 'pool-created', 'uniswap-v4': 'initialize' }[protocol],
    marketKey: `robinhood:${protocol}:${protocol === 'uniswap-v4' ? poolId : address}`,
    pairAddress: address, poolAddress: address, poolId,
    factoryAddress: `0x${'1'.repeat(40)}`,
    poolManagerAddress: `0x${'1'.repeat(40)}`,
    tokenAddress: TOKEN, quoteAddress: STOCK,
    currency0: TOKEN, currency1: STOCK, quoteIndex: 1, quoteKind: 'erc20',
    blockNumber: '100', blockHash: `0x${'a'.repeat(64)}`,
    transactionHash: `0x${'b'.repeat(64)}`, logIndex: '7',
    timestampMs: '1783900800000',
  };
}

async function readPool(event) {
  const { rows } = await client.query(`SELECT token_address, quote_address, active,
    metadata, discovery_block::text, created_at FROM robinhood_pool_registry
    WHERE protocol=$1 AND market_key=$2`, [event.protocol, event.marketKey]);
  return rows[0];
}

describe('Robinhood historical pool recovery', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    client = await db.getClient();
    await client.query(`CREATE TEMP TABLE robinhood_pool_registry
      (LIKE public.robinhood_pool_registry INCLUDING ALL)`);
    repository = createRobinhoodPersistenceRepository({ database: {
      getClient: async () => ({ query: client.query.bind(client), release() {} }),
    } });
  });

  after(async () => {
    client?.release(true);
    await db.pool.end();
  });

  it('preserves active state and extra metadata while repairing orientation on V2/V3/V4', async () => {
    for (const [index, protocol] of ['uniswap-v2', 'uniswap-v3', 'uniswap-v4'].entries()) {
      const event = discovery(protocol);
      await repository.upsertRecoveredPools([event]);
      const inserted = await readPool(event);
      assert.equal(inserted.active, true);
      const active = index % 2 === 0;
      const metadata = { quoteIndex: 0, noxa: { launchSource: 'noxa-fun' }, dynamicFee: true, audit: 'keep' };
      await client.query(`UPDATE robinhood_pool_registry SET active=$3, metadata=$4::jsonb,
        token_address=$5, quote_address=$6 WHERE protocol=$1 AND market_key=$2`,
      [protocol, event.marketKey, active, JSON.stringify(metadata), STOCK, TOKEN]);

      await repository.upsertRecoveredPools([event]);
      const repaired = await readPool(event);
      assert.deepEqual(repaired, {
        token_address: TOKEN, quote_address: STOCK, active, discovery_block: '100',
        created_at: inserted.created_at,
        metadata: { ...metadata, quoteIndex: 1, quoteKind: 'erc20' },
      });
      await repository.upsertRecoveredPools([event]);
      assert.deepEqual(await readPool(event), repaired);
    }
  });

  it('rolls back the entire recovered batch on a conflicting pool identity', async () => {
    const event = discovery('uniswap-v2', '5');
    const collision = { ...event, marketKey: `${event.marketKey}:conflict` };
    await assert.rejects(repository.upsertRecoveredPools([event, collision]),
      (error) => error.code === '23505');
    assert.equal(await readPool(event), undefined);
    assert.equal((await client.query('SELECT COUNT(*)::int AS count FROM robinhood_pool_registry')).rows[0].count, 3);
  });

  it('retains the existing live discovery replacement and reactivation contract', async () => {
    const event = discovery('uniswap-v3');
    await upsertPool(client, __private.normalizePool(event));
    const row = await readPool(event);
    assert.equal(row.active, true);
    assert.deepEqual(row.metadata, {
      quoteIndex: 1, quoteKind: 'erc20', dynamicFee: null, pairIndex: null,
    });
  });

  it('selects Stock pools across protocols and distinguishes markers, observations and captures in PostgreSQL', async () => {
    const reference = { ...discovery('uniswap-v3', '6'), quoteAddress: CANONICAL_CONTRACTS.USDG,
      currency1: CANONICAL_CONTRACTS.USDG };
    await repository.upsertRecoveredPools([reference]);
    await client.query("UPDATE robinhood_pool_registry SET active=false WHERE protocol='uniswap-v3'");
    const archive = createArchiveRepository(client, 'stock-quote');
    const pools = await archive.listPools();
    assert.deepEqual(pools.map((pool) => pool.protocol).sort(), ['uniswap-v2', 'uniswap-v3', 'uniswap-v4']);
    await client.query(`CREATE TEMP TABLE robinhood_processed_logs
      (chain text, transaction_hash text, log_index bigint);
      CREATE TEMP TABLE robinhood_market_observations
      (chain text, transaction_hash text, log_index bigint, status text);
      CREATE TEMP TABLE robinhood_head_captures
      (chain text, transaction_hash text, log_index bigint)`);
    const rows = [1, 2, 3].map((index) => ({ transaction_hash: `0x${String(index).repeat(64)}`, log_index: '1' }));
    await client.query("INSERT INTO robinhood_processed_logs VALUES ('robinhood',$1,1)", [rows[0].transaction_hash]);
    await client.query("INSERT INTO robinhood_market_observations VALUES ('robinhood',$1,1,'rejected')", [rows[1].transaction_hash]);
    await client.query("INSERT INTO robinhood_head_captures VALUES ('robinhood',$1,1)", [rows[2].transaction_hash]);
    assert.deepEqual([...(await archive.classify(rows)).values()], [
      { processed: true, captured: false, observed: false },
      { processed: false, captured: false, observed: true },
      { processed: false, captured: true, observed: false },
    ]);
  });
});
