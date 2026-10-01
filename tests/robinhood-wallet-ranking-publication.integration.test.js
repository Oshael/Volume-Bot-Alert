process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { before, after, it } = require('node:test');
const db = require('../src/models/db');
const stage260 = require('../src/utils/db-init-stage260');
const { assertUsingTestDatabase } = require('./helpers/test-db');
const { createRobinhoodWalletRankingPublicationRepository: repository } = require(
  '../src/models/robinhood-wallet-ranking-publication'
);

const VERSION = 'unified_transfer_v1';
const AS_OF = '2026-10-01T10:00:00.000Z';
const HASH = `0x${'a'.repeat(64)}`;
const REVISIONS = { positions: '1', transfers: '1', swaps: '1', prices: '1', reorg: '1' };
const IDENTITY = { projectionVersion: VERSION, window: 'ALL' };

function input(overrides = {}) {
  return { projectionVersion: VERSION, expectedGeneration: '0', checkpointBlock: '100',
    checkpointHash: HASH, sourceRevisions: REVISIONS,
    result: { window: 'ALL', asOf: AS_OF, candidateUniverseComplete: true,
      candidateWalletCount: 1, excludedWalletCount: 0, coverage: 'complete', reasons: [],
      ranked: [{ rank: 1, walletAddress: `0x${'1'.repeat(40)}`,
        gainUsd: '0.000000000000000001', openPositionCount: 2 }] }, ...overrides };
}

function scoped(client) {
  return repository({ database: {
    queryWithStatementTimeout: (sql, params) => client.query(sql, params),
  } });
}

before(async () => {
  await assertUsingTestDatabase(db);
  await stage260.init({ closePool: false });
  await stage260.init({ closePool: false });
});
after(async () => db.pool.end());

async function fixture(run) {
  const client = await db.getClient();
  const schema = `rh_ranking_${randomUUID().replaceAll('-', '')}`;
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    for (const sql of stage260.STATEMENTS) await client.query(sql);
    await client.query(`CREATE TABLE robinhood_wallet_ranking_revisions (
      source text PRIMARY KEY, version bigint NOT NULL)`);
    for (const [source, version] of Object.entries(REVISIONS)) {
      await client.query('INSERT INTO robinhood_wallet_ranking_revisions VALUES ($1,$2)', [source, version]);
    }
    await client.query(`CREATE TABLE robinhood_wallet_position_cursors (
      chain text, projection_version text, stream text, lifecycle_state text,
      checkpoint_block bigint, checkpoint_hash text, next_block bigint,
      safe_head bigint, next_block_time timestamptz)`);
    await client.query(`INSERT INTO robinhood_wallet_position_cursors VALUES
      ('robinhood',$1,'live','running',100,$2,101,100,$3)`, [VERSION, HASH, AS_OF]);
    await client.query(`CREATE TABLE robinhood_chain_blocks (
      chain text, block_number bigint, block_hash text, canonical boolean,
      block_timestamp timestamptz)`);
    await client.query(`INSERT INTO robinhood_chain_blocks VALUES
      ('robinhood',100,$1,true,$2)`, [HASH, AS_OF]);
    await run({ client, schema, repo: scoped(client) });
  } finally {
    await client.query('ROLLBACK');
    await client.query('SET search_path TO public');
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    client.release();
  }
}

it('persists exact results, skips duplicates and allows only one concurrent replacement', async () => {
  await fixture(async ({ client, schema, repo }) => {
    const first = input();
    assert.deepEqual(await repo.getRevisions(), REVISIONS);
    assert.equal(await repo.getCurrent(IDENTITY), null);
    assert.deepEqual(await repo.publish(first), { published: true, generation: '1' });
    assert.deepEqual((await scoped(client).getCurrent(IDENTITY)).result, first.result);
    assert.equal((await repo.getCurrent(IDENTITY)).isFresh, true);
    for (const expectedGeneration of ['0', '1']) {
      assert.equal((await repo.publish({ ...first, expectedGeneration })).published, false);
    }
    await client.query("UPDATE robinhood_wallet_ranking_revisions SET version=2 WHERE source='prices'");
    const second = input({ expectedGeneration: '1', sourceRevisions: { ...REVISIONS, prices: '2' } });
    const other = await db.getClient();
    try {
      await other.query(`SET search_path TO ${schema}`);
      const results = await Promise.all([repo.publish(second), scoped(other).publish(second)]);
      assert.equal(results.filter((result) => result.published).length, 1);
      assert.equal((await repo.getCurrent(IDENTITY)).generation, '2');
      assert.equal((await repo.publish({ ...first, expectedGeneration: '2' })).published, false);
    } finally {
      await other.query('SET search_path TO public');
      other.release();
    }
  });
});

it('rejects future revisions and invalid checkpoints but can finish a snapshot while LIVE advances', async () => {
  await fixture(async ({ client, repo }) => {
    const first = input();
    await repo.publish(first);
    await assert.rejects(client.query(`UPDATE robinhood_wallet_ranking_publications
      SET payload=jsonb_set(payload,'{candidateUniverseComplete}','false')`), { code: '23514' });
    await client.query("UPDATE robinhood_wallet_ranking_revisions SET version=2 WHERE source='prices'");
    assert.equal((await repo.publish({ ...first, expectedGeneration: '1' })).published, false);
    assert.equal((await repo.getCurrent(IDENTITY)).isFresh, false);
    assert.equal((await repo.publish(input({ expectedGeneration: '1',
      sourceRevisions: { ...REVISIONS, prices: '3' } }))).published, false);
    const next = input({ expectedGeneration: '1', sourceRevisions: { ...REVISIONS, prices: '2' } });
    for (const change of ['safe_head=99', 'next_block=102',
      "next_block_time='2026-10-01T10:00:01Z'"]) {
      await client.query(`UPDATE robinhood_wallet_position_cursors SET ${change}`);
      assert.equal((await repo.publish(next)).published, false);
      await client.query(`UPDATE robinhood_wallet_position_cursors
        SET safe_head=100,next_block=101,next_block_time=$1`, [AS_OF]);
    }
    const hash = `0x${'c'.repeat(64)}`;
    await client.query(`INSERT INTO robinhood_chain_blocks VALUES
      ('robinhood',101,$1,true,'2026-10-01T10:00:01Z')`, [hash]);
    await client.query(`UPDATE robinhood_wallet_position_cursors SET checkpoint_block=101,
      checkpoint_hash=$1,next_block=102,safe_head=101,next_block_time='2026-10-01T10:00:01Z'`, [hash]);
    assert.equal((await repo.publish(input({ result: { ...first.result, window: '24h' } }))).published, true);
    assert.equal((await repo.getCurrent({ ...IDENTITY, window: '24h' })).isFresh, false);
    await client.query('UPDATE robinhood_chain_blocks SET canonical=false');
    assert.equal(await repo.getCurrent(IDENTITY), null);
    assert.equal((await repo.publish(next)).published, false);
  });
});

it('hides a reorg-invalidated generation and permits a proven rewind in a new reorg epoch', async () => {
  await fixture(async ({ client, repo }) => {
    await repo.publish(input());
    const time = '2026-10-01T09:59:00.000Z';
    const hash = `0x${'b'.repeat(64)}`;
    await client.query(`INSERT INTO robinhood_chain_blocks VALUES
      ('robinhood',99,$1,true,$2)`, [hash, time]);
    await client.query(`UPDATE robinhood_wallet_position_cursors
      SET checkpoint_block=99,checkpoint_hash=$1,next_block=100,next_block_time=$2`, [hash, time]);
    const rewind = input({ expectedGeneration: '1', checkpointBlock: '99', checkpointHash: hash,
      result: { ...input().result, asOf: time } });
    assert.equal((await repo.publish(rewind)).published, false);
    await client.query("UPDATE robinhood_wallet_ranking_revisions SET version=2 WHERE source='reorg'");
    assert.equal(await repo.getCurrent(IDENTITY), null);
    rewind.sourceRevisions = { ...REVISIONS, reorg: '2' };
    assert.deepEqual(await repo.publish(rewind), { published: true, generation: '2' });
    assert.equal((await repo.getCurrent(IDENTITY)).asOf, time);
  });
});

it('rejects incomplete universes, unsafe values and unbounded payloads before writing', async () => {
  const repo = repository({ database: {
    queryWithStatementTimeout() { throw new Error('unexpected query'); },
  } });
  const first = input();
  for (const invalid of [
    { result: { ...first.result, candidateUniverseComplete: false } },
    { result: { ...first.result, ranked: Array(101).fill(first.result.ranked[0]) } },
    { result: { ...first.result, ranked: [{ ...first.result.ranked[0], gainUsd: 1.1 }] } },
    { result: { ...first.result, asOf: 'invalid' } },
    { result: { ...first.result, extra: 'x'.repeat(65536) } },
    { sourceRevisions: { positions: '1' } }, { expectedGeneration: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    await assert.rejects(repo.publish({ ...first, ...invalid }),
      /complete candidate|ranked row|asOf|64 KiB|all five|expectedGeneration/);
  }
});

it('preserves partial wallet quality without accepting a truncated candidate universe', async () => {
  await fixture(async ({ repo }) => {
    const partial = input({ result: { ...input().result, candidateWalletCount: 2,
      excludedWalletCount: 1, coverage: 'partial', reasons: ['transfer_cost_unknown'] } });
    assert.equal((await repo.publish(partial)).published, true);
    assert.deepEqual((await repo.getCurrent(IDENTITY)).result, partial.result);
  });
});

it('rolls back a publication with its transaction instead of exposing a half-published result', async () => {
  await fixture(async ({ client, repo }) => {
    await client.query('BEGIN');
    assert.equal((await repo.publish(input())).published, true);
    await client.query('ROLLBACK');
    assert.equal(await repo.getCurrent(IDENTITY), null);
  });
});
