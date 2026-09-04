process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, beforeEach, describe, it } = require('node:test');

const db = require('../src/models/db');
const {
  createRobinhoodChainCaptureJournal,
} = require('../src/models/robinhood-chain-capture-journal');
const {
  createRobinhoodChainDomainOutboxRepository,
} = require('../src/models/robinhood-chain-domain-outbox');
const {
  createRobinhoodCanonicalHeadCandidateRepository,
} = require('../src/models/robinhood-canonical-head-candidate');
const { createRobinhoodHeadCaptureRepository } = require('../src/models/robinhood-head-capture');
const {
  createRobinhoodCanonicalHeadCanaryAudit,
} = require('../src/services/robinhood-canonical-head-canary-audit');
const stage191 = require('../src/utils/db-init-stage191');
const stage192 = require('../src/utils/db-init-stage192');
const stage193 = require('../src/utils/db-init-stage193');
const stage194 = require('../src/utils/db-init-stage194');
const stage195 = require('../src/utils/db-init-stage195');
const stage103 = require('../src/utils/db-init-stage103');
const v2 = require('../src/services/uniswap-v2-decoder');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const PARENT = `0x${'1'.repeat(64)}`;
const HASH = `0x${'2'.repeat(64)}`;
const NEXT_HASH = `0x${'3'.repeat(64)}`;
const TX = `0x${'4'.repeat(64)}`;
const NEXT_TX = `0x${'5'.repeat(64)}`;
const ADDRESS = v2.ROBINHOOD_V2_FACTORY;
const TOPIC = v2.TOPICS.pairCreated;
const OBSERVED_AT = '2026-09-03T20:00:00.000Z';
const MAX_UINT256 = ((1n << 256n) - 1n).toString();

function capture(number = 100, hash = HASH, parentHash = PARENT) {
  return {
    block: {
      number, hash, parentHash, timestamp: OBSERVED_AT, finality: 'observed',
      headObservedAt: OBSERVED_AT, receiptsAvailableAt: OBSERVED_AT,
    },
    nodeHead: number + 2,
    finalizedHead: number - 2,
    transactions: [{
      hash: TX, index: 0, from: ADDRESS, to: null,
      succeeded: true, contractAddress: ADDRESS,
      nonce: 7, valueWei: 42,
    }],
    events: [{
      transactionHash: TX, transactionIndex: 0, logIndex: 0,
      address: ADDRESS, topics: [TOPIC], data: '0x',
    }],
  };
}

async function clearTables() {
  await db.query('DELETE FROM robinhood_canonical_head_candidates');
  await db.query('DELETE FROM robinhood_chain_v3_balance_snapshots');
  await db.query('DELETE FROM robinhood_head_captures');
  await db.query('DELETE FROM robinhood_head_capture_cursors');
  await db.query('DELETE FROM robinhood_chain_capture_cursor');
  await db.query('DELETE FROM robinhood_chain_blocks');
}

describe('Robinhood canonical chain capture journal', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage103.init({ closePool: false });
    await stage191.init({ closePool: false });
    await stage192.init({ closePool: false });
    await stage193.init({ closePool: false });
    await stage194.init({ closePool: false });
    await stage195.init({ closePool: false });
  });

  beforeEach(clearTables);

  after(async () => {
    await clearTables().catch(() => {});
    await db.pool.end().catch(() => {});
  });

  it('registers the complete journal contract in the runtime schema guard', () => {
    const group = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage191-robinhood-canonical-chain-journal'
    ));
    assert.equal(group.repair, 'node src/utils/db-init-stage191.js');
    assert.deepEqual(group.tables.map(({ table }) => table), [
      'robinhood_chain_blocks', 'robinhood_chain_transactions',
      'robinhood_chain_events', 'robinhood_chain_capture_cursor',
    ]);
    const context = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage192-robinhood-complete-transaction-context'
    ));
    assert.equal(context.repair, 'node src/utils/db-init-stage192.js');
    const outbox = SCHEMA_GROUPS.find(({ key }) => key === 'stage193-robinhood-domain-outbox');
    assert.equal(outbox.repair, 'node src/utils/db-init-stage193.js');
    const canary = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage194-robinhood-canonical-head-canary'
    ));
    assert.equal(canary.repair, 'node src/utils/db-init-stage194.js');
    const snapshots = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage195-robinhood-v3-balance-snapshots'
    ));
    assert.equal(snapshots.repair, 'node src/utils/db-init-stage195.js');
  });

  it('keeps canonical canary evidence immutable and compares it with legacy evidence', async () => {
    await createRobinhoodChainCaptureJournal().commitBlock(capture());
    const log = {
      transactionHash: TX, transactionIndex: '0', logIndex: '0', blockNumber: '100',
      blockHash: HASH, address: ADDRESS, topics: [TOPIC], data: '0x',
    };
    const canonical = {
      stream: 'market', log, protocol: 'uniswap-v2', marketKey: 'pool-a',
      evidenceVersion: 2,
      evidence: {
        source: 'canonical', quoteUsd: { priceUsd: '1', source: 'pool' },
        tokenMetadata: { totalSupplyRaw: '10', decimals: 18 },
      },
    };
    const candidates = createRobinhoodCanonicalHeadCandidateRepository();
    assert.deepEqual(await candidates.appendCaptureEntries({ entries: [canonical] }), {
      insertedCaptures: 1, duplicateCaptures: 0,
    });
    assert.deepEqual(await candidates.appendCaptureEntries({ entries: [canonical] }), {
      insertedCaptures: 0, duplicateCaptures: 1,
    });
    assert.deepEqual(await candidates.getParitySummary({ fromBlock: 100, toBlock: 100 }), [{
      stream: 'market', candidates: 1, mature_candidates: 0, awaiting_legacy: 1,
      missing_legacy: 0, matched: 0, volatile_drift: 0,
      divergent: 0, first_block: '100', last_block: '100',
    }]);
    await createRobinhoodHeadCaptureRepository().appendCaptureEntries({ entries: [canonical] });
    assert.deepEqual(await candidates.getParitySummary({ fromBlock: 100, toBlock: 100 }), [{
      stream: 'market', candidates: 1, mature_candidates: 0, awaiting_legacy: 1,
      missing_legacy: 0, matched: 0, volatile_drift: 0, divergent: 0,
      first_block: '100', last_block: '100',
    }]);
    await db.query(
      `INSERT INTO robinhood_head_capture_cursors(
         chain, stream, next_block, checkpoint_block, checkpoint_hash
       ) VALUES ('robinhood', 'market', 101, 100, $1)`, [HASH]
    );
    assert.deepEqual(await candidates.getParitySummary({ fromBlock: 100, toBlock: 100 }), [{
      stream: 'market', candidates: 1, mature_candidates: 1, awaiting_legacy: 0,
      missing_legacy: 0, matched: 1, volatile_drift: 0, divergent: 0,
      first_block: '100', last_block: '100',
    }]);
    await db.query(
      `UPDATE robinhood_canonical_head_candidates SET captured_at='2026-09-04T01:00:00Z'
        WHERE chain='robinhood' AND transaction_hash=$1 AND log_index=0`, [TX]
    );
    assert.deepEqual(await candidates.getParitySummary({
      fromBlock: 100, toBlock: 100, capturedAfter: '2026-09-04T01:00:01Z',
    }), []);
    const volatile = {
      ...canonical.evidence,
      quoteUsd: { ...canonical.evidence.quoteUsd, priceUsd: '1.01' },
      tokenMetadata: { ...canonical.evidence.tokenMetadata, totalSupplyRaw: '11' },
    };
    await db.query(
      `UPDATE robinhood_head_captures SET evidence=$1::jsonb
        WHERE chain='robinhood' AND transaction_hash=$2 AND log_index=0`,
      [JSON.stringify(volatile), TX]
    );
    assert.deepEqual(await candidates.getParitySummary({ fromBlock: 100, toBlock: 100 }), [{
      stream: 'market', candidates: 1, mature_candidates: 1, awaiting_legacy: 0,
      missing_legacy: 0, matched: 0, volatile_drift: 1, divergent: 0,
      first_block: '100', last_block: '100',
    }]);
    await db.query(
      `UPDATE robinhood_head_captures SET evidence=$1::jsonb
        WHERE chain='robinhood' AND transaction_hash=$2 AND log_index=0`,
      [JSON.stringify({ ...volatile, source: 'legacy' }), TX]
    );
    assert.deepEqual(await candidates.getParitySummary({ fromBlock: 100, toBlock: 100 }), [{
      stream: 'market', candidates: 1, mature_candidates: 1, awaiting_legacy: 0,
      missing_legacy: 0, matched: 0, volatile_drift: 0, divergent: 1,
      first_block: '100', last_block: '100',
    }]);
    await assert.rejects(candidates.appendCaptureEntries({ entries: [{
      ...canonical, evidence: { source: 'changed' },
    }] }), (error) => error.code === 'canonical_candidate_conflict');
  });

  it('commits the block envelope, transaction, event, and cursor atomically', async () => {
    const journal = createRobinhoodChainCaptureJournal();
    const input = capture();
    input.v3Snapshots = [{
      logIndex: 0,
      poolAddress: `0x${'6'.repeat(40)}`,
      tokenAddress: `0x${'7'.repeat(40)}`,
      quoteAddress: `0x${'8'.repeat(40)}`,
      tokenBalanceRaw: MAX_UINT256,
      quoteBalanceRaw: '2500000',
    }];
    assert.deepEqual(await journal.commitBlock(input), {
      status: 'committed', transactions: 1, events: 1, v3Snapshots: 1, workItems: 1,
    });

    const counts = await db.query(
      `SELECT (SELECT COUNT(*)::int FROM robinhood_chain_blocks) AS blocks,
              (SELECT COUNT(*)::int FROM robinhood_chain_transactions) AS transactions,
              (SELECT COUNT(*)::int FROM robinhood_chain_events) AS events,
              (SELECT COUNT(*)::int FROM robinhood_chain_domain_outbox) AS work_items,
              (SELECT COUNT(*)::int FROM robinhood_chain_v3_balance_snapshots) AS snapshots`
    );
    assert.deepEqual(counts.rows[0], {
      blocks: 1, transactions: 1, events: 1, work_items: 1, snapshots: 1,
    });
    const snapshot = await db.query(
      `SELECT token_balance_raw::text, quote_balance_raw::text
         FROM robinhood_chain_v3_balance_snapshots`
    );
    assert.deepEqual(snapshot.rows[0], {
      token_balance_raw: MAX_UINT256, quote_balance_raw: '2500000',
    });
    const transactionContext = await db.query(
      `SELECT blocks.capture_version, tx.nonce::text, tx.value_wei::text
         FROM robinhood_chain_blocks blocks
         JOIN robinhood_chain_transactions tx USING (chain, block_hash)`
    );
    assert.deepEqual(transactionContext.rows[0], {
      capture_version: 3, nonce: '7', value_wei: '42',
    });
    const cursor = await journal.getCursor();
    assert.equal(cursor.next_block, '101');
    assert.equal(cursor.checkpoint_block, '100');
    assert.equal(cursor.checkpoint_hash, HASH);
  });

  it('accepts an exact retry but rejects gaps and parent divergence without partial writes', async () => {
    const journal = createRobinhoodChainCaptureJournal();
    await journal.commitBlock(capture());
    assert.deepEqual(await journal.commitBlock(capture()), {
      status: 'replayed', transactions: 0, events: 0, v3Snapshots: 0, workItems: 0,
    });
    const divergent = capture();
    divergent.events[0].data = '0x01';
    await assert.rejects(journal.commitBlock(divergent),
      (error) => error.code === 'capture_replay_conflict');
    await assert.rejects(
      journal.commitBlock(capture(102, NEXT_HASH, HASH)),
      (error) => error.code === 'capture_sequence_conflict'
    );
    await assert.rejects(
      journal.commitBlock(capture(101, NEXT_HASH, PARENT)),
      (error) => error.code === 'capture_reorg_detected'
    );
    const counts = await db.query('SELECT COUNT(*)::int AS blocks FROM robinhood_chain_blocks');
    assert.equal(counts.rows[0].blocks, 1);
    assert.equal((await journal.getCursor()).next_block, '101');
  });

  it('leases only rows covered by the legacy cursor and protects settlement ownership', async () => {
    const journal = createRobinhoodChainCaptureJournal();
    await journal.commitBlock(capture());
    await db.query(
      `INSERT INTO robinhood_head_capture_cursors(chain, stream, next_block)
       VALUES ('robinhood', 'discovery', 101)`
    );
    const repository = createRobinhoodChainDomainOutboxRepository({ database: db });
    const [claimed] = await repository.claimShadow({
      domain: 'discovery', owner: 'shadow-a', limit: 10, leaseMs: 60_000,
    });
    assert.equal(claimed.block_number, '100');
    assert.equal(claimed.legacy_block_hash, null);
    assert.deepEqual(await repository.settle({
      owner: 'shadow-b', complete: [{
        domain: 'discovery', blockHash: HASH, logIndex: 0,
      }],
    }), { completed: 0, blocked: 0, retried: 0 });
    assert.deepEqual(await repository.settle({
      owner: 'shadow-a', complete: [{
        domain: 'discovery', blockHash: HASH, logIndex: 0,
      }],
    }), { completed: 1, blocked: 0, retried: 0 });
  });

  it('counts outbox lag only after the legacy frontier makes work mature', async () => {
    await createRobinhoodChainCaptureJournal().commitBlock(capture());
    await db.query(
      `INSERT INTO robinhood_head_capture_cursors(chain, stream, next_block)
       VALUES ('robinhood', 'discovery', 100)`
    );
    const database = {
      ...db,
      query: (sql, params) => sql.includes('worker_leases')
        ? Promise.resolve({ rows: [] }) : db.query(sql, params),
    };
    const audit = createRobinhoodCanonicalHeadCanaryAudit({ database });
    assert.equal((await audit.inspect({ phase: 'preflight' })).queue.mature_lag_blocks, '0');
    await db.query(
      `UPDATE robinhood_head_capture_cursors SET next_block=102
        WHERE chain='robinhood' AND stream='discovery'`
    );
    assert.equal((await audit.inspect({ phase: 'preflight' })).queue.mature_lag_blocks, '1');
  });

  it('leases production discovery immediately without waiting for the legacy cursor', async () => {
    await createRobinhoodChainCaptureJournal().commitBlock(capture());
    const repository = createRobinhoodChainDomainOutboxRepository({ database: db });
    const [claimed] = await repository.claimReady({
      domain: 'discovery', owner: 'canonical-a', limit: 10, leaseMs: 60_000,
    });
    assert.equal(claimed.block_number, '100');
    assert.equal(claimed.block_timestamp.toISOString(), OBSERVED_AT);
  });

  it('leases a bounded ready frontier with discovery before market', async () => {
    const mixed = capture();
    mixed.events.push({
      transactionHash: TX, transactionIndex: 0, logIndex: 1,
      address: `0x${'7'.repeat(40)}`, topics: [v2.TOPICS.swap], data: '0x',
    });
    await createRobinhoodChainCaptureJournal().commitBlock(mixed);
    const next = capture(101, NEXT_HASH, HASH);
    next.transactions[0].hash = NEXT_TX;
    next.events[0].transactionHash = NEXT_TX;
    await createRobinhoodChainCaptureJournal().commitBlock(next);
    const repository = createRobinhoodChainDomainOutboxRepository({ database: db });
    const claimed = await repository.claimNextBlock({
      owner: 'canonical-head', leaseMs: 60_000, maxBlocks: 2,
    });
    assert.deepEqual(claimed.map((row) => row.block_number), ['100', '100', '101']);
    assert.deepEqual(claimed.map((row) => row.domain), ['discovery', 'market', 'discovery']);
  });

  it('reclaims an expired lease and blocks a retry that exhausts its attempts', async () => {
    await createRobinhoodChainCaptureJournal().commitBlock(capture());
    await db.query(
      `INSERT INTO robinhood_head_capture_cursors(chain, stream, next_block)
       VALUES ('robinhood', 'discovery', 101)`
    );
    const repository = createRobinhoodChainDomainOutboxRepository({ database: db });
    await repository.claimShadow({
      domain: 'discovery', owner: 'shadow-a', limit: 10, leaseMs: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(await repository.reclaimExpiredLeases(), 1);
    await repository.claimShadow({
      domain: 'discovery', owner: 'shadow-b', limit: 10, leaseMs: 60_000,
    });
    assert.deepEqual(await repository.settle({
      owner: 'shadow-b', maxAttempts: 2, retry: [{
        domain: 'discovery', blockHash: HASH, logIndex: 0,
        error: { code: 'test_failure' }, backoffMs: 1_000,
      }],
    }), { completed: 0, blocked: 1, retried: 0 });
    const result = await db.query(
      `SELECT status, last_error FROM robinhood_chain_domain_outbox
       WHERE domain='discovery' AND block_hash=$1 AND log_index=0`, [HASH]
    );
    assert.deepEqual(result.rows[0], {
      status: 'blocked', last_error: { code: 'test_failure' },
    });
  });
});
