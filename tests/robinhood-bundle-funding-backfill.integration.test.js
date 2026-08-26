process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');
const db = require('../src/models/db');
const { createRobinhoodBundleFundingBackfillRepository } = require(
  '../src/models/robinhood-bundle-funding-backfill'
);
const stage167 = require('../src/utils/db-init-stage167');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const HASH = `0x${'a'.repeat(64)}`;
const TOKEN = `0x${'1'.repeat(40)}`;
const FROM = `0x${'2'.repeat(40)}`;
const TO = `0x${'3'.repeat(40)}`;

async function cleanup() {
  await db.query('DELETE FROM robinhood_native_funding_events');
  await db.query('DELETE FROM robinhood_native_funding_edges');
  await db.query('DELETE FROM robinhood_bundle_funding_backfill_ranges');
  await db.query('DELETE FROM robinhood_bundle_funding_backfill_candidates');
  await db.query('DELETE FROM robinhood_bundle_funding_backfill_runs');
}

function evidence(block, value, suffix) {
  const transactionHash = `0x${suffix.repeat(64)}`;
  const blockTime = `2026-08-26T12:${block === 100 ? '00' : '01'}:00.000Z`;
  return {
    raw: { blockNumber: String(block), blockHash: HASH, blockTime,
      transactionHash, transactionIndex: '0', fromAddress: FROM,
      toAddress: TO, valueWei: String(value) },
    edge: { fromAddress: FROM, toAddress: TO, firstBlockNumber: String(block),
      firstBlockHash: HASH, firstBlockTime: blockTime, firstTransactionHash: transactionHash,
      firstTransactionIndex: '0', lastBlockNumber: String(block), lastBlockHash: HASH,
      lastBlockTime: blockTime, lastTransactionHash: transactionHash,
      lastTransactionIndex: '0', transferCount: '1', totalValueWei: String(value) },
  };
}

describe('Robinhood bundle funding backfill repository', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage167.init({ closePool: false });
    await cleanup();
  });
  after(async () => { await cleanup(); await db.pool.end(); });

  it('freezes, leases, and atomically commits out-of-order ranges', async () => {
    const repository = createRobinhoodBundleFundingBackfillRepository({ database: db });
    const candidates = [TO, FROM].map((walletAddress, index) => ({
      tokenAddress: TOKEN, walletAddress, launchBlock: '100',
      firstBuyBlock: String(101 + index), firstBuyTransactionIndex: '0',
    }));
    const campaign = {
      plan: { ruleVersion: 'rh_possible_bundle_v1', sourceFromBlock: '0',
        sourceThroughBlock: '200', lookbackBlocks: '1000', blocksToScan: '4',
        candidates, ranges: [{ fromBlock: '100', toBlock: '102' },
          { fromBlock: '200', toBlock: '200' }] },
      preflight: { approved: true, checkpointCanonical: true, sourceThroughBlock: '200',
        sourceThroughHash: HASH, batchBlocks: 50, concurrency: 2 },
    };
    const run = await repository.createRun(campaign);
    assert.equal(run.candidateCount, 2);
    const first = await repository.claimRange({ runId: run.id, owner: 'first' });
    const second = await repository.claimRange({ runId: run.id, owner: 'second' });
    assert.equal(first.candidates.length, 2);
    assert.equal(second.rangeIndex, 1);
    await assert.rejects(repository.completeRange({ runId: run.id, rangeIndex: 0,
      owner: 'wrong', completedThroughHash: HASH }), /lease was lost/);
    for (const [range, ownerName, item] of [
      [second, 'second', evidence(200, 20, 'c')],
      [first, 'first', evidence(100, 10, 'b')],
    ]) await repository.completeRange({ runId: run.id, rangeIndex: range.rangeIndex,
      owner: ownerName, completedThroughHash: HASH, nativeTransfersScanned: 1,
      rawEvents: [item.raw], edges: [item.edge] });
    assert.deepEqual((await db.query(`SELECT transfer_count::text, total_value_wei::text,
      first_block_number::text, last_block_number::text
      FROM robinhood_native_funding_edges`)).rows[0], {
      transfer_count: '2', total_value_wei: '30',
      first_block_number: '100', last_block_number: '200',
    });
    assert.equal((await db.query('SELECT COUNT(*)::integer count FROM robinhood_native_funding_events'))
      .rows[0].count, 2);
    assert.deepEqual(await repository.getProgress(run.id), {
      status: 'completed', total: 2, pending: 0, leased: 0, completed: 2, failed: 0,
    });
    const failedRun = await repository.createRun(campaign);
    for (const ownerName of ['failure-1', 'failure-2']) {
      const range = await repository.claimRange({ runId: failedRun.id, owner: ownerName });
      assert.equal(await repository.retryRange({ runId: failedRun.id,
        rangeIndex: range.rangeIndex, owner: ownerName, maxAttempts: 1,
        error: Object.assign(new Error('archive unavailable'), { code: 'rpc_failed' }) }), 'failed');
    }
    assert.equal((await repository.getRun(failedRun.id)).status, 'failed');
  });
});
