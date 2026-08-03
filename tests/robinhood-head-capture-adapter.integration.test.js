process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, beforeEach, describe, it } = require('node:test');

const db = require('../src/models/db');
const {
  createRobinhoodHeadCaptureAdapter,
} = require('../src/services/robinhood-head-capture-adapter');
const stage103 = require('../src/utils/db-init-stage103');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const HASH_A = `0x${'a'.repeat(64)}`;
const HASH_B = `0x${'b'.repeat(64)}`;
const ADDRESS = `0x${'c'.repeat(40)}`;
const TOPIC = `0x${'d'.repeat(64)}`;

const baseRepositoryStub = {
  listActivePools: async () => [{ market_key: 'robinhood:uniswap-v3:test' }],
  listCurrentV4LiquidityRanges: async () => null,
};

function buildEntry(logIndex, evidence) {
  return {
    log: {
      transactionHash: logIndex ? HASH_B : HASH_A,
      logIndex,
      blockNumber: 500 + logIndex,
      blockHash: HASH_B,
      transactionIndex: 0,
      address: ADDRESS,
      topics: [TOPIC],
      data: '0x',
    },
    capture: {
      protocol: 'uniswap-v3',
      marketKey: 'robinhood:uniswap-v3:test',
      evidenceVersion: 1,
      evidence,
    },
  };
}

function buildRange(nextBlock) {
  return {
    nextBlock,
    safeHead: nextBlock,
    checkpoint: { number: nextBlock - 1, hash: HASH_A, timestampMs: 1750000000000 },
  };
}

async function clearTables() {
  await db.query('DELETE FROM robinhood_head_captures');
  await db.query('DELETE FROM robinhood_head_capture_cursors');
}

describe('Robinhood head capture adapter integration', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage103.init({ closePool: false });
  });

  beforeEach(clearTables);

  after(async () => {
    await clearTables().catch(() => {});
    await db.pool.end().catch(() => {});
  });

  it('commits capture entries to the queue and advances the capture cursor', async () => {
    const adapter = createRobinhoodHeadCaptureAdapter({ baseRepository: baseRepositoryStub });

    const result = await adapter.commitMarketRange({
      entries: [buildEntry(0, { v3: { tokenBalanceRaw: '1' } }), buildEntry(1, { v3: { tokenBalanceRaw: '2' } })],
      cursor: buildRange(510),
    });
    assert.equal(result.insertedCaptures, 2);

    const cursor = await adapter.loadCursor('market');
    assert.equal(cursor.next_block, '510');
    assert.equal(cursor.checkpoint_block, '509');

    const rows = await db.query(
      `SELECT evidence FROM robinhood_head_captures WHERE transaction_hash = $1`,
      [HASH_A]
    );
    assert.deepEqual(rows.rows[0].evidence, { v3: { tokenBalanceRaw: '1' } });
  });

  it('skips entries without evidence but still advances the cursor', async () => {
    const adapter = createRobinhoodHeadCaptureAdapter({ baseRepository: baseRepositoryStub });
    const withoutEvidence = { log: buildEntry(0, {}).log, capture: { protocol: 'uniswap-v3', evidenceVersion: 1, evidence: null } };

    const result = await adapter.commitMarketRange({
      entries: [withoutEvidence],
      cursor: buildRange(520),
    });
    assert.equal(result.insertedCaptures, 0);

    const cursor = await adapter.loadCursor('market');
    assert.equal(cursor.next_block, '520');
  });

  it('returns null before a stream cursor exists', async () => {
    const adapter = createRobinhoodHeadCaptureAdapter({ baseRepository: baseRepositoryStub });
    assert.equal(await adapter.loadCursor('discovery'), null);
  });

  it('delegates pool-registry reads to the base repository', async () => {
    const adapter = createRobinhoodHeadCaptureAdapter({ baseRepository: baseRepositoryStub });
    const pools = await adapter.listActivePools();
    assert.equal(pools[0].market_key, 'robinhood:uniswap-v3:test');
    assert.equal(await adapter.listCurrentV4LiquidityRanges('0xpid'), null);
  });
});
