process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const { createRobinhoodPossibleBundleSnapshotRepository } = require(
  '../src/models/robinhood-possible-bundle-snapshot'
);
const { materializePossibleBundles } = require(
  '../src/services/robinhood-possible-bundle-materializer'
);
const stage167 = require('../src/utils/db-init-stage167');
const stage168 = require('../src/utils/db-init-stage168');
const stage174 = require('../src/utils/db-init-stage174');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const TOKEN = `0x${'9'.repeat(40)}`;
const A = `0x${'1'.repeat(40)}`;
const B = `0x${'2'.repeat(40)}`;
const HASH_A = `0x${'a'.repeat(64)}`;
const HASH_B = `0x${'b'.repeat(64)}`;
const HASH_C = `0x${'c'.repeat(64)}`;
const TX = `0x${'d'.repeat(64)}`;

async function cleanup() {
  await db.query('DELETE FROM robinhood_possible_bundle_members');
  await db.query('DELETE FROM robinhood_possible_bundle_groups');
  await db.query('DELETE FROM robinhood_possible_bundle_states');
  await db.query('DELETE FROM robinhood_bundle_funding_backfill_ranges');
  await db.query('DELETE FROM robinhood_bundle_funding_backfill_candidates');
  await db.query('DELETE FROM robinhood_bundle_funding_backfill_runs');
}

async function createRun(block, hash) {
  const result = await db.query(`INSERT INTO robinhood_bundle_funding_backfill_runs (
    evidence_version, source_from_block, source_through_block, source_through_hash,
    lookback_blocks, batch_blocks, concurrency, candidate_count, range_count,
    blocks_total, status, started_at, finished_at
  ) VALUES ('rh_native_funding_v2', 0, $1, $2, 1000, 50, 2, 2, 0, 0,
    'completed', NOW(), NOW()) RETURNING id::text`, [block, hash]);
  return result.rows[0].id;
}

function snapshot(runId, throughBlockNumber, throughBlockHash, grouped = true) {
  const candidates = [A, B].map((walletAddress, index) => ({
    tokenAddress: TOKEN, walletAddress, launchBlock: '100',
    firstBuyBlock: String(101 + index), firstBuyTransactionIndex: '0',
  }));
  return materializePossibleBundles({
    tokenAddress: TOKEN, candidates,
    evidence: grouped ? [{ tokenAddress: TOKEN, candidateWallet: B, hop: 1,
      fromAddress: A, toAddress: B, valueWei: '25', blockNumber: '99',
      transactionIndex: '0', transactionHash: TX }] : [],
    evidenceVersion: 'rh_native_funding_v2', sourceKind: 'seed', sourceRunId: runId,
    lookbackBlocks: '1000', minimumValueWei: '10', throughBlockNumber,
    throughBlockHash, barrierAddresses: [],
  });
}

function failBeforeCommitDatabase() {
  return {
    async getClient() {
      const client = await db.getClient();
      return {
        release: () => client.release(),
        query(sql, params) {
          if (sql === 'COMMIT') throw new Error('forced commit failure');
          return client.query(sql, params);
        },
      };
    },
  };
}

describe('Robinhood possible-bundle snapshot writer', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage167.init({ closePool: false });
    await stage168.init({ closePool: false });
    await stage174.init({ closePool: false });
    await cleanup();
  });
  after(async () => { await cleanup(); await db.pool.end(); });

  it('atomically replaces groups and rolls back an interrupted replacement', async () => {
    const firstRun = await createRun('200', HASH_A);
    const first = snapshot(firstRun, '200', HASH_A);
    const writer = createRobinhoodPossibleBundleSnapshotRepository({
      database: db, now: () => '2026-08-27T01:00:00Z',
    });
    assert.deepEqual(await writer.replaceSnapshot(first), {
      status: 'published', groups: 1, members: 2,
    });
    assert.equal((await db.query(
      'SELECT COUNT(*)::integer count FROM robinhood_possible_bundle_members'
    )).rows[0].count, 2);

    const secondRun = await createRun('201', HASH_B);
    const empty = snapshot(secondRun, '201', HASH_B, false);
    const interrupted = createRobinhoodPossibleBundleSnapshotRepository({
      database: failBeforeCommitDatabase(), now: () => '2026-08-27T02:00:00Z',
    });
    await assert.rejects(interrupted.replaceSnapshot(empty), /forced commit failure/);
    assert.deepEqual((await db.query(`SELECT source_run_id::text, status_reason
      FROM robinhood_possible_bundle_states WHERE token_address = $1`, [TOKEN])).rows[0], {
      source_run_id: firstRun, status_reason: 'groups_found',
    });
    assert.equal((await db.query(
      'SELECT COUNT(*)::integer count FROM robinhood_possible_bundle_groups'
    )).rows[0].count, 1);

    assert.deepEqual(await writer.replaceSnapshot(empty), {
      status: 'published', groups: 0, members: 0,
    });
    assert.equal((await db.query(
      'SELECT COUNT(*)::integer count FROM robinhood_possible_bundle_groups'
    )).rows[0].count, 0);
  });

  it('ignores an older run and rejects an equal-height fork or invalid shape', async () => {
    await cleanup();
    const currentRun = await createRun('200', HASH_A);
    const writer = createRobinhoodPossibleBundleSnapshotRepository({ database: db });
    const current = snapshot(currentRun, '200', HASH_A);
    await writer.replaceSnapshot(current);
    const olderRun = await createRun('199', HASH_B);
    assert.deepEqual(await writer.replaceSnapshot(snapshot(olderRun, '199', HASH_B)), {
      status: 'ignored', reason: 'frontier_behind',
    });
    const forkRun = await createRun('200', HASH_C);
    await assert.rejects(writer.replaceSnapshot(snapshot(forkRun, '200', HASH_C)),
      /frontier fork/);
    await assert.rejects(writer.replaceSnapshot({ ...current,
      state: { ...current.state, minimumValueWei: '11' } }),
    /policy drift requires a new rule version/);
    await assert.rejects(writer.replaceSnapshot({ ...current,
      groups: [{ ...current.groups[0], memberCount: 3 }] }), /member count is inconsistent/);
  });
});
