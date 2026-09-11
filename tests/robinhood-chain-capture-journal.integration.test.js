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
  createRobinhoodWalletSwapRepository,
} = require('../src/models/robinhood-wallet-swap-persistence');
const {
  createRobinhoodTokenTransferRepository,
} = require('../src/models/robinhood-token-transfer-persistence');
const {
  createRobinhoodCanonicalHeadCanaryAudit,
} = require('../src/services/robinhood-canonical-head-canary-audit');
const stage191 = require('../src/utils/db-init-stage191');
const stage192 = require('../src/utils/db-init-stage192');
const stage193 = require('../src/utils/db-init-stage193');
const stage194 = require('../src/utils/db-init-stage194');
const stage195 = require('../src/utils/db-init-stage195');
const stage90 = require('../src/utils/db-init-stage90');
const stage91 = require('../src/utils/db-init-stage91');
const stage109 = require('../src/utils/db-init-stage109');
const stage122 = require('../src/utils/db-init-stage122');
const stage139 = require('../src/utils/db-init-stage139');
const stage126 = require('../src/utils/db-init-stage126');
const stage127 = require('../src/utils/db-init-stage127');
const stage128 = require('../src/utils/db-init-stage128');
const stage129 = require('../src/utils/db-init-stage129');
const stage130 = require('../src/utils/db-init-stage130');
const stage131 = require('../src/utils/db-init-stage131');
const stage134 = require('../src/utils/db-init-stage134');
const stage137 = require('../src/utils/db-init-stage137');
const stage153 = require('../src/utils/db-init-stage153');
const stage203 = require('../src/utils/db-init-stage203');
const stage204 = require('../src/utils/db-init-stage204');
const stage205 = require('../src/utils/db-init-stage205');
const stage206 = require('../src/utils/db-init-stage206');
const stage207 = require('../src/utils/db-init-stage207');
const stage208 = require('../src/utils/db-init-stage208');
const stage103 = require('../src/utils/db-init-stage103');
const stage165 = require('../src/utils/db-init-stage165');
const v2 = require('../src/services/uniswap-v2-decoder');
const { TRANSFER_TOPIC, ZERO_TOPIC } = require('../src/services/evm-erc20-supply-delta');
const { SCHEMA_GROUPS, __private: schemaChecks } = require('../src/utils/runtime-schema');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const PARENT = `0x${'1'.repeat(64)}`;
const HASH = `0x${'2'.repeat(64)}`;
const NEXT_HASH = `0x${'3'.repeat(64)}`;
const TX = `0x${'4'.repeat(64)}`;
const NEXT_TX = `0x${'5'.repeat(64)}`;
const LEGACY_TX = `0x${'b'.repeat(64)}`;
const ADDRESS = v2.ROBINHOOD_V2_FACTORY;
const TOKEN = `0x${'9'.repeat(40)}`;
const RECIPIENT = `0x${'8'.repeat(40)}`;
const TRANSFER_TX = `0x${'c'.repeat(64)}`;
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
  await db.query("DELETE FROM robinhood_wallet_transfer_reorg_journal WHERE chain='robinhood'");
  await db.query("DELETE FROM robinhood_wallet_relationship_evidence WHERE chain='robinhood'");
  await db.query("DELETE FROM robinhood_wallet_transfer_edges WHERE chain='robinhood'");
  await db.query("DELETE FROM robinhood_wallet_transfer_daily_summaries WHERE chain='robinhood'");
  await db.query("DELETE FROM robinhood_wallet_transfer_cursors WHERE chain='robinhood'");
  await db.query("DELETE FROM robinhood_wallet_token_positions WHERE chain='robinhood'");
  await db.query("DELETE FROM robinhood_wallet_position_cursors WHERE chain='robinhood'");
  await db.query("DELETE FROM robinhood_token_transfer_events WHERE chain='robinhood'");
  await db.query('DELETE FROM robinhood_chain_recovery_outbox');
  await db.query('DELETE FROM robinhood_chain_recoveries');
  await db.query('DELETE FROM robinhood_wallet_swap_outbox');
  await db.query('DELETE FROM robinhood_wallet_swap_realtime_outbox');
  await db.query("DELETE FROM robinhood_wallet_swap_cursors WHERE chain='robinhood'");
  await db.query("DELETE FROM robinhood_wallet_swaps WHERE chain='robinhood'");
  await db.query("DELETE FROM robinhood_swap_mc WHERE chain='robinhood'");
  await db.query("DELETE FROM robinhood_transaction_positions WHERE chain='robinhood'");
  await db.query('DELETE FROM robinhood_token_deployment_outbox');
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
    await stage165.init({ closePool: false });
    await stage191.init({ closePool: false });
    await stage192.init({ closePool: false });
    await stage193.init({ closePool: false });
    await stage194.init({ closePool: false });
    await stage195.init({ closePool: false });
    await stage90.init({ closePool: false });
    await stage91.init({ closePool: false });
    await stage109.init({ closePool: false });
    await stage122.init({ closePool: false });
    await stage139.init({ closePool: false });
    await stage126.init({ closePool: false });
    await stage127.init({ closePool: false });
    await stage128.init({ closePool: false });
    await stage129.init({ closePool: false });
    await stage130.init({ closePool: false });
    await stage131.init({ closePool: false });
    await stage134.init({ closePool: false });
    await stage137.init({ closePool: false });
    await stage153.init({ closePool: false });
    await stage203.init({ closePool: false });
    await stage204.init({ closePool: false });
    await stage205.init({ closePool: false });
    await stage206.init({ closePool: false });
    await stage207.init({ closePool: false });
    await stage208.init({ closePool: false });
  });

  beforeEach(clearTables);

  after(async () => {
    await clearTables().catch(() => {});
    await db.pool.end().catch(() => {});
  });

  it('registers the complete journal contract in the runtime schema guard', async () => {
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
    const constraint = await db.query(`SELECT conname, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE conrelid = 'public.robinhood_chain_transactions'::regclass
        AND conname = 'rh_chain_transactions_context_check'`);
    assert.deepEqual(schemaChecks.collectMissingConstraints(
      context.tables.find(({ table }) => table === 'robinhood_chain_transactions'),
      new Map(constraint.rows.map(({ conname, definition }) => [conname, definition]))
    ), []);
    const outbox = SCHEMA_GROUPS.find(({ key }) => key === 'stage193-robinhood-domain-outbox');
    assert.equal(outbox.repair, 'node src/utils/db-init-stage193.js');
    const outboxOptions = await db.query(
      `SELECT reloptions FROM pg_class WHERE oid='robinhood_chain_domain_outbox'::regclass`
    );
    assert.deepEqual(new Set(outboxOptions.rows[0].reloptions), new Set([
      'autovacuum_vacuum_scale_factor=0.005',
      'autovacuum_vacuum_threshold=50000',
      'autovacuum_analyze_scale_factor=0.01',
      'autovacuum_analyze_threshold=50000',
    ]));
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
      stream: 'market', log, protocol: 'uniswap-v3', marketKey: 'pool-a',
      evidenceVersion: 2,
      evidence: {
        source: 'canonical', quoteUsd: { priceUsd: '1', source: 'pool' },
        tokenMetadata: { totalSupplyRaw: '10', decimals: 18 },
        v3: {
          poolAddress: ADDRESS, blockTag: '0x64', balanceStatus: 'observed',
          tokenBalanceRaw: '100', quoteBalanceRaw: '200', sqrtPriceX96: '300',
        },
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
      missing_legacy: 0, matched: 0, quality_upgrade: 0, volatile_drift: 0,
      divergent: 0, first_block: '100', last_block: '100',
    }]);
    await createRobinhoodHeadCaptureRepository().appendCaptureEntries({ entries: [canonical] });
    assert.deepEqual(await candidates.getParitySummary({ fromBlock: 100, toBlock: 100 }), [{
      stream: 'market', candidates: 1, mature_candidates: 0, awaiting_legacy: 1,
      missing_legacy: 0, matched: 0, quality_upgrade: 0,
      volatile_drift: 0, divergent: 0,
      first_block: '100', last_block: '100',
    }]);
    await db.query(
      `INSERT INTO robinhood_head_capture_cursors(
         chain, stream, next_block, checkpoint_block, checkpoint_hash
       ) VALUES ('robinhood', 'market', 101, 100, $1)`, [HASH]
    );
    assert.deepEqual(await candidates.getParitySummary({ fromBlock: 100, toBlock: 100 }), [{
      stream: 'market', candidates: 1, mature_candidates: 1, awaiting_legacy: 0,
      missing_legacy: 0, matched: 1, quality_upgrade: 0,
      volatile_drift: 0, divergent: 0,
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
      missing_legacy: 0, matched: 0, quality_upgrade: 0,
      volatile_drift: 1, divergent: 0,
      first_block: '100', last_block: '100',
    }]);
    const upgraded = {
      ...volatile,
      v3: {
        ...volatile.v3,
        balanceStatus: 'unavailable_backfill',
        tokenBalanceRaw: null,
        quoteBalanceRaw: null,
      },
    };
    await db.query(
      `UPDATE robinhood_head_captures SET evidence=$1::jsonb
        WHERE chain='robinhood' AND transaction_hash=$2 AND log_index=0`,
      [JSON.stringify(upgraded), TX]
    );
    assert.deepEqual(await candidates.getParitySummary({ fromBlock: 100, toBlock: 100 }), [{
      stream: 'market', candidates: 1, mature_candidates: 1, awaiting_legacy: 0,
      missing_legacy: 0, matched: 0, quality_upgrade: 1,
      volatile_drift: 0, divergent: 0,
      first_block: '100', last_block: '100',
    }]);
    await db.query(
      `UPDATE robinhood_head_captures SET evidence=$1::jsonb
        WHERE chain='robinhood' AND transaction_hash=$2 AND log_index=0`,
      [JSON.stringify({ ...upgraded, source: 'legacy' }), TX]
    );
    assert.deepEqual(await candidates.getParitySummary({ fromBlock: 100, toBlock: 100 }), [{
      stream: 'market', candidates: 1, mature_candidates: 1, awaiting_legacy: 0,
      missing_legacy: 0, matched: 0, quality_upgrade: 0,
      volatile_drift: 0, divergent: 1,
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
    const [claimed] = await createRobinhoodChainDomainOutboxRepository().claimNextBlock({
      owner: 'snapshot-contract', leaseMs: 60_000, maxBlocks: 1,
    });
    assert.deepEqual(claimed.v3_balance_snapshot, {
      poolAddress: `0x${'6'.repeat(40)}`,
      tokenAddress: `0x${'7'.repeat(40)}`,
      quoteAddress: `0x${'8'.repeat(40)}`,
      tokenBalanceRaw: MAX_UINT256,
      quoteBalanceRaw: '2500000',
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

  it('durably enqueues a generic zero-address mint before catalog discovery', async () => {
    const input = capture();
    input.events = [{
      transactionHash: TX, transactionIndex: 0, logIndex: 0,
      address: TOKEN,
      topics: [TRANSFER_TOPIC, ZERO_TOPIC, `0x${'0'.repeat(24)}${'8'.repeat(40)}`],
      data: `0x${'0'.repeat(63)}1`,
    }];
    await createRobinhoodChainCaptureJournal().commitBlock(input);
    const result = await db.query(
      `SELECT token_address, status, attempt_count
         FROM robinhood_token_deployment_outbox WHERE chain='robinhood'`
    );
    assert.deepEqual(result.rows, [{
      token_address: TOKEN, status: 'pending', attempt_count: 0,
    }]);
  });

  it('commits a contiguous block batch atomically and advances one canonical frontier', async () => {
    const journal = createRobinhoodChainCaptureJournal();
    const next = capture(101, NEXT_HASH, HASH);
    next.transactions[0].hash = NEXT_TX;
    next.events[0].transactionHash = NEXT_TX;
    const broken = { ...next, block: { ...next.block, parentHash: PARENT } };
    await assert.rejects(
      journal.commitBlocks([capture(), broken]),
      (error) => error.code === 'capture_reorg_detected'
    );
    assert.equal((await db.query(
      'SELECT COUNT(*)::int AS blocks FROM robinhood_chain_blocks'
    )).rows[0].blocks, 0);

    assert.deepEqual(await journal.commitBlocks([capture(), next]), [{
      status: 'committed', transactions: 1, events: 1, v3Snapshots: 0, workItems: 1,
    }, {
      status: 'committed', transactions: 1, events: 1, v3Snapshots: 0, workItems: 1,
    }]);
    const counts = await db.query(
      `SELECT (SELECT COUNT(*)::int FROM robinhood_chain_blocks) AS blocks,
              (SELECT COUNT(*)::int FROM robinhood_chain_transactions) AS transactions,
              (SELECT COUNT(*)::int FROM robinhood_chain_events) AS events,
              (SELECT COUNT(*)::int FROM robinhood_chain_domain_outbox) AS work_items`
    );
    assert.deepEqual(counts.rows[0], {
      blocks: 2, transactions: 2, events: 2, work_items: 2,
    });
    const cursor = await journal.getCursor();
    assert.deepEqual(
      [cursor.next_block, cursor.checkpoint_block, cursor.checkpoint_hash, cursor.version],
      ['102', '101', NEXT_HASH, '1']
    );
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

  it('durably fences capture once explicit reorg recovery is required', async () => {
    const journal = createRobinhoodChainCaptureJournal();
    await journal.commitBlock(capture());
    const plan = {
      reason: 'parent_hash_mismatch', recoverable: true, maxDepth: 12, generation: '0',
      checkpoint: { blockNumber: '100', blockHash: HASH },
      incoming: { blockNumber: '101', blockHash: NEXT_HASH, parentHash: PARENT },
      ancestor: { blockNumber: '99', blockHash: PARENT },
    };

    await assert.rejects(journal.markRecoveryRequired({
      plan: {
        ...plan,
        checkpoint: { blockNumber: '99', blockHash: PARENT },
      },
    }), (error) => error.code === 'capture_recovery_fence_conflict');
    assert.equal((await journal.getCursor()).recovery_state, 'running');
    await assert.rejects(journal.markRecoveryRequired({
      plan: { ...plan, generation: '1' },
    }), (error) => error.code === 'capture_recovery_fence_conflict');
    assert.deepEqual(await journal.markRecoveryRequired({ plan }), {
      status: 'recovery-required', generation: '0', plan,
    });
    const cursor = await journal.getCursor();
    assert.equal(cursor.recovery_state, 'recovery_required');
    assert.deepEqual(cursor.recovery_plan, plan);
    assert.ok(cursor.recovery_detected_at instanceof Date);
    const recovery = await db.query(
      `SELECT generation::text, status, plan
         FROM robinhood_chain_recoveries WHERE chain='robinhood'`
    );
    assert.deepEqual(recovery.rows, [{ generation: '0', status: 'detected', plan }]);
    const events = await db.query(
      `SELECT generation::text, event_kind, status, payload
         FROM robinhood_chain_recovery_outbox WHERE chain='robinhood'`
    );
    assert.equal(events.rows.length, 1);
    assert.deepEqual(events.rows[0], {
      generation: '0', event_kind: 'detected', status: 'pending',
      payload: {
        type: 'chain:reorg:detected', generation: '0',
        detectedAt: cursor.recovery_detected_at.toISOString(), plan,
      },
    });
    assert.deepEqual(await journal.markRecoveryRequired({ plan }), {
      status: 'already-required', generation: '0', plan,
    });
    await assert.rejects(
      journal.commitBlock(capture(101, NEXT_HASH, HASH)),
      (error) => error.code === 'capture_recovery_required' && error.fatal === true
    );
    assert.equal((await journal.getCursor()).next_block, '101');
  });

  it('loads only the bounded canonical header range used by recovery planning', async () => {
    const journal = createRobinhoodChainCaptureJournal();
    const next = capture(101, NEXT_HASH, HASH);
    next.transactions[0].hash = NEXT_TX;
    next.events[0].transactionHash = NEXT_TX;
    await journal.commitBlocks([capture(), next]);
    assert.deepEqual(await journal.listCanonicalHeaders({
      fromBlock: '100', throughBlock: '101', limit: 1,
    }), [{ blockNumber: '101', blockHash: NEXT_HASH }]);
  });

  it('atomically preserves an orphan branch and rewinds only an executable recovery', async () => {
    const journal = createRobinhoodChainCaptureJournal();
    const second = capture(101, NEXT_HASH, HASH);
    second.transactions[0].hash = NEXT_TX;
    second.events[0].transactionHash = NEXT_TX;
    second.transactions.push({ ...second.transactions[0], hash: LEGACY_TX, index: 1 });
    await journal.commitBlocks([capture(), second]);
    const plan = {
      generation: '0', reason: 'parent_hash_mismatch', recoverable: true,
      executable: true, pendingRollbackDomains: [], maxDepth: 12,
      rollbackManifestVersion: 2,
      checkpoint: { blockNumber: '101', blockHash: NEXT_HASH },
      incoming: {
        blockNumber: '102', blockHash: `0x${'6'.repeat(64)}`,
        parentHash: `0x${'7'.repeat(64)}`,
      },
      ancestor: { blockNumber: '100', blockHash: HASH },
      affectedRange: { fromBlock: '101', throughBlock: '101', depth: '1' },
    };
    await db.query(
      `INSERT INTO robinhood_wallet_swap_realtime_outbox(
         chain, transaction_hash, log_index, event_kind, block_number,
         block_hash, transaction_index, payload
       ) VALUES ('robinhood',$1,0,'observed',101,$2,0,$3::jsonb)`,
      [NEXT_TX, NEXT_HASH, JSON.stringify({
        protocolVersion: 2, type: 'market:trade:observed', finality: 'observed',
        transactionHash: NEXT_TX, actionIndex: '0', blockNumber: '101',
        blockHash: NEXT_HASH,
      })]
    );
    await createRobinhoodWalletSwapRepository().insertWalletSwaps([
      {
        walletAddress: ADDRESS, transactionHash: TX, actionIndex: '0',
        blockNumber: '100', blockTime: OBSERVED_AT, protocol: 'uniswap-v2',
        marketKey: 'robinhood:uniswap-v2:canonical', tokenAddress: TOKEN,
        quoteAddress: ADDRESS, side: 'buy', tokenAmountRaw: '100', quoteAmountRaw: '200',
        tokenDecimals: '18', quoteDecimals: '18', tokenAmount: '100', quoteAmount: '200',
        priceUsd: '2', volumeUsd: '200', parserVersion: 'reorg-test',
        fdvUsd: '2000', tokenTotalSupplyRaw: '1000',
      },
      ...[NEXT_TX, LEGACY_TX].map((transactionHash) => ({
        walletAddress: ADDRESS, transactionHash, actionIndex: '0',
        blockNumber: '101', blockTime: OBSERVED_AT, protocol: 'uniswap-v2',
        marketKey: 'robinhood:uniswap-v2:reorg', tokenAddress: TOKEN,
        quoteAddress: ADDRESS, side: 'buy', tokenAmountRaw: '10', quoteAmountRaw: '20',
        tokenDecimals: '18', quoteDecimals: '18', tokenAmount: '10', quoteAmount: '20',
        priceUsd: '2', volumeUsd: '20', parserVersion: 'reorg-test',
        fdvUsd: '2000', tokenTotalSupplyRaw: '1000',
      })),
    ]);
    await createRobinhoodTokenTransferRepository().insertTransferEvents([{
      blockNumber: '101', blockHash: NEXT_HASH, blockTime: OBSERVED_AT,
      transactionHash: TRANSFER_TX, transactionIndex: '2', logIndex: '3',
      tokenAddress: TOKEN, fromWallet: ADDRESS, toWallet: RECIPIENT, amountRaw: '15',
      transferKind: 'wallet_transfer', classificationVersion: 'rh_transfer_v1',
    }]);
    await db.query(
      `INSERT INTO robinhood_wallet_swap_outbox(
         chain, transaction_hash, log_index, block_number, block_hash,
         transaction_index, payload
       ) VALUES
         ('robinhood',$1,0,101,$3,0,'{}'::jsonb),
         ('robinhood',$2,0,101,$3,1,'{}'::jsonb)`,
      [NEXT_TX, LEGACY_TX, NEXT_HASH]
    );
    await db.query(
      `INSERT INTO robinhood_transaction_positions(
         chain, transaction_hash, block_number, block_hash, transaction_index
       ) VALUES
         ('robinhood',$4,100,$5,0),
         ('robinhood',$1,101,$3,0),
         ('robinhood',$2,101,$3,1)`,
      [NEXT_TX, LEGACY_TX, NEXT_HASH, TX, HASH]
    );
    await db.query(
      `INSERT INTO robinhood_wallet_swap_cursors(
         chain, stream, next_block, safe_head, checkpoint_block, checkpoint_hash,
         checkpoint_timestamp, lifecycle_state
       ) VALUES ('robinhood','live',102,101,101,$1,$2,'running')`,
      [NEXT_HASH, OBSERVED_AT]
    );
    await db.query(
      `INSERT INTO robinhood_wallet_position_cursors(
         chain, projection_version, stream, origin_block, next_block, safe_head,
         checkpoint_block, checkpoint_hash, next_block_time, lifecycle_state, completed_at
       ) VALUES
         ('robinhood','swap_only_v1','seed',100,101,100,100,$1,$2,'complete',NOW()),
         ('robinhood','swap_only_v1','live',101,102,101,101,$3,$2,'running',NULL),
         ('robinhood','unified_transfer_v1','seed',100,101,100,100,$1,$2,'complete',NOW()),
         ('robinhood','unified_transfer_v1','live',101,102,101,101,$3,$2,'running',NULL)`,
      [HASH, OBSERVED_AT, NEXT_HASH]
    );
    await db.query(
      `INSERT INTO robinhood_wallet_token_positions(
         chain, projection_version, token_address, wallet_address, quantity_raw,
         cost_basis_usd, realized_pnl_usd, buy_volume_usd, buy_tx_count,
         cost_basis_source, quality, through_block, through_log_index
       ) VALUES
         ('robinhood','swap_only_v1',$1,$2,120,240,10,240,3,'swap_only',
           'exact_swap_only',101,0),
         ('robinhood','unified_transfer_v1',$1,$2,105,240,10,240,3,
           'transferred_assumed_zero','transferred_assumed_zero',101,3),
         ('robinhood','unified_transfer_v1',$1,$3,15,0,0,0,0,
           'transferred_assumed_zero','transferred_assumed_zero',101,3)`,
      [TOKEN, ADDRESS, RECIPIENT]
    );
    await journal.markRecoveryRequired({ plan });
    assert.deepEqual(await journal.rewindCanonicalRecovery({ generation: '0' }), {
      status: 'rewound', generation: '0', nextGeneration: '1', orphanedBlocks: 1,
      domainReady: ['canonical-journal', 'market', 'publication-alerts', 'wallet'],
      tradeInvalidations: { observed: 1, invalidated: 1 },
      market: {
        affectedTokens: 0, deletedProcessedLogs: 0, deletedDerivedRows: 0,
        deletedMinuteBuckets: 0, rebuiltMinuteBuckets: 0, deletedHourBuckets: 0,
        rebuiltHourBuckets: 0, deletedAggregateBuckets: 0,
        rebuiltAggregateBuckets: 0, removedEmptyAggregateBuckets: 0,
      },
      wallet: {
        orphanedSwaps: 2, deletedOutbox: 2, deletedSwapMc: 2,
        deletedSwaps: 2, deletedTransactionPositions: 2, cursorRewound: true,
        positionRollback: {
          projections: 2, affectedPositions: 3, removedPositions: 3,
          rebuiltPositions: 2, cursorsRewound: 2,
        },
      },
      walletTransfers: {
        projections: 0, restoredBatches: 0, replayedPrefix: 0,
        deletedRawTransfers: 1, cursorsRewound: 0,
      },
    });
    assert.deepEqual(await journal.rewindCanonicalRecovery({ generation: '0' }), {
      status: 'already-rewound', generation: '0', nextGeneration: '1',
    });
    const blocks = await db.query(
      `SELECT block_number::text, block_hash, canonical
         FROM robinhood_chain_blocks ORDER BY block_number, block_hash`
    );
    assert.deepEqual(blocks.rows, [
      { block_number: '100', block_hash: HASH, canonical: true },
      { block_number: '101', block_hash: NEXT_HASH, canonical: false },
    ]);
    const cursor = await journal.getCursor();
    assert.deepEqual({
      generation: cursor.generation, state: cursor.recovery_state,
      next: cursor.next_block, checkpoint: cursor.checkpoint_block,
      hash: cursor.checkpoint_hash,
    }, {
      generation: '1', state: 'recovery_required', next: '101',
      checkpoint: '100', hash: HASH,
    });
    const recovery = await db.query(
      `SELECT status, rewound_at IS NOT NULL AS rewound
         FROM robinhood_chain_recoveries WHERE chain='robinhood' AND generation=0`
    );
    assert.deepEqual(recovery.rows, [{ status: 'awaiting_domains', rewound: true }]);
    const event = await db.query(
      `SELECT payload FROM robinhood_chain_recovery_outbox
        WHERE chain='robinhood' AND generation=0 AND event_kind='rewound'`
    );
    assert.deepEqual(event.rows[0].payload, {
      type: 'chain:reorg:rewound', generation: '0', nextGeneration: '1', status: 'rewound',
      orphanedRange: { fromBlock: '101', throughBlock: '101', depth: '1' },
      ancestor: plan.ancestor, oldCheckpoint: plan.checkpoint,
      replacementCheckpointHash: plan.incoming.parentHash,
    });
    const lifecycle = await db.query(
      `SELECT event_kind, block_hash, payload, created_at
         FROM robinhood_wallet_swap_realtime_outbox
        WHERE transaction_hash=$1
        ORDER BY CASE event_kind WHEN 'observed' THEN 0 ELSE 1 END`, [NEXT_TX]
    );
    assert.deepEqual(lifecycle.rows.map(({ event_kind, block_hash }) => ({
      event_kind, block_hash,
    })), [
      { event_kind: 'observed', block_hash: NEXT_HASH },
      { event_kind: 'invalidate', block_hash: NEXT_HASH },
    ]);
    assert.equal(lifecycle.rows[1].payload.type, 'market:trade:invalidate');
    assert.equal(lifecycle.rows[1].payload.finality, 'invalidated');
    assert.equal(lifecycle.rows[1].payload.reason, 'reorg');
    assert.equal(lifecycle.rows[1].payload.recoveryGeneration, '0');
    assert.ok(Date.parse(lifecycle.rows[1].payload.invalidatedAt));
    assert.ok(lifecycle.rows[1].created_at >= lifecycle.rows[0].created_at);
    const walletArtifacts = await db.query(
      `SELECT
         (SELECT COUNT(*)::int FROM robinhood_wallet_swaps
           WHERE transaction_hash=ANY($1::varchar[])) AS swaps,
         (SELECT COUNT(*)::int FROM robinhood_swap_mc
           WHERE transaction_hash=ANY($1::varchar[])) AS swap_mc,
         (SELECT COUNT(*)::int FROM robinhood_wallet_swap_outbox
           WHERE transaction_hash=ANY($1::varchar[])) AS outbox,
         (SELECT COUNT(*)::int FROM robinhood_transaction_positions
           WHERE transaction_hash=ANY($1::varchar[])) AS positions`,
      [[NEXT_TX, LEGACY_TX]]
    );
    assert.deepEqual(walletArtifacts.rows[0], {
      swaps: 0, swap_mc: 0, outbox: 0, positions: 0,
    });
    const walletCursor = await db.query(
      `SELECT next_block::text, safe_head::text, checkpoint_block::text,
              checkpoint_hash, version
         FROM robinhood_wallet_swap_cursors
        WHERE chain='robinhood' AND stream='live'`
    );
    assert.deepEqual(walletCursor.rows[0], {
      next_block: '101', safe_head: '100', checkpoint_block: '100',
      checkpoint_hash: HASH, version: '1',
    });
    const financial = await db.query(
      `SELECT projection_version, wallet_address, quantity_raw::text,
              cost_basis_usd::text, realized_pnl_usd::text,
              buy_volume_usd::text, buy_tx_count::text,
              through_block::text, through_log_index::text
         FROM robinhood_wallet_token_positions
        ORDER BY projection_version, wallet_address`
    );
    assert.deepEqual(financial.rows, ['swap_only_v1', 'unified_transfer_v1'].map(
      (projection_version) => ({
        projection_version, wallet_address: ADDRESS, quantity_raw: '100',
        cost_basis_usd: '200', realized_pnl_usd: '0', buy_volume_usd: '200',
        buy_tx_count: '1', through_block: '100', through_log_index: '0',
      })
    ));
    const positionCursors = await db.query(
      `SELECT projection_version, next_block::text, safe_head::text,
              checkpoint_block::text, checkpoint_hash, version::text
         FROM robinhood_wallet_position_cursors WHERE stream='live'
        ORDER BY projection_version`
    );
    assert.deepEqual(positionCursors.rows, ['swap_only_v1', 'unified_transfer_v1'].map(
      (projection_version) => ({
        projection_version, next_block: '101', safe_head: '100',
        checkpoint_block: '100', checkpoint_hash: HASH, version: '1',
      })
    ));
    assert.deepEqual(await journal.resumeCanonicalRecovery({ generation: '0' }), {
      status: 'awaiting-domains', generation: '1',
      readyDomains: ['canonical-journal', 'market', 'publication-alerts', 'wallet'],
      pendingDomains: ['wallet-derived', 'liquidity', 'holders', 'discovery-creator'],
    });
    await assert.rejects(
      journal.commitBlock(second), (error) => error.code === 'capture_recovery_required'
    );
    for (const domain of ['wallet-derived', 'liquidity', 'holders', 'discovery-creator']) {
      await journal.recordRecoveryDomainReady({
        generation: '0', domain, evidence: { test: 'rollback-complete' },
      });
    }
    assert.equal((await journal.recordRecoveryDomainReady({
      generation: '0', domain: 'wallet-derived', evidence: { test: 'rollback-complete' },
    })).status, 'ready');
    await assert.rejects(journal.recordRecoveryDomainReady({
      generation: '0', domain: 'wallet-derived', evidence: { test: 'changed' },
    }), (error) => error.code === 'capture_recovery_domain_conflict');
    assert.deepEqual(await journal.resumeCanonicalRecovery({ generation: '0' }), {
      status: 'recapturing', generation: '1',
      readyDomains: [
        'canonical-journal', 'discovery-creator', 'holders', 'liquidity',
        'market', 'publication-alerts', 'wallet', 'wallet-derived',
      ],
      pendingDomains: [],
    });
    const replacement = capture(101, plan.incoming.parentHash, HASH);
    replacement.transactions[0].hash = `0x${'d'.repeat(64)}`;
    replacement.events[0].transactionHash = replacement.transactions[0].hash;
    const incoming = capture(102, plan.incoming.blockHash, plan.incoming.parentHash);
    incoming.transactions[0].hash = `0x${'e'.repeat(64)}`;
    incoming.events[0].transactionHash = incoming.transactions[0].hash;
    await journal.commitBlocks([replacement, incoming], { expectedGeneration: '1' });
    assert.equal((await journal.commitBlock(incoming, {
      expectedGeneration: '1',
    })).status, 'replayed');
    const canonicalBranch = await db.query(
      `SELECT block_number::text, block_hash FROM robinhood_chain_blocks
        WHERE canonical ORDER BY block_number`
    );
    assert.deepEqual(canonicalBranch.rows, [
      { block_number: '100', block_hash: HASH },
      { block_number: '101', block_hash: plan.incoming.parentHash },
      { block_number: '102', block_hash: plan.incoming.blockHash },
    ]);
  });

  it('fails closed before touching canonical state when the rollback gate is incomplete', async () => {
    const journal = createRobinhoodChainCaptureJournal();
    await journal.commitBlock(capture());
    const plan = {
      generation: '0', reason: 'parent_hash_mismatch', recoverable: true,
      executable: false, pendingRollbackDomains: ['market'], maxDepth: 12,
      rollbackManifestVersion: 2,
      checkpoint: { blockNumber: '100', blockHash: HASH },
      incoming: { blockNumber: '101', blockHash: NEXT_HASH, parentHash: PARENT },
      ancestor: { blockNumber: '99', blockHash: PARENT },
      affectedRange: { fromBlock: '100', throughBlock: '100', depth: '1' },
    };
    await journal.markRecoveryRequired({ plan });
    await assert.rejects(
      journal.rewindCanonicalRecovery({ generation: '0' }),
      (error) => error.code === 'capture_recovery_not_executable'
    );
    assert.equal((await db.query(
      `SELECT canonical FROM robinhood_chain_blocks WHERE block_hash=$1`, [HASH]
    )).rows[0].canonical, true);
    assert.equal((await journal.getCursor()).checkpoint_block, '100');
  });

  it('rolls back atomically when a wallet-domain cursor hash is outside the orphan branch', async () => {
    const journal = createRobinhoodChainCaptureJournal();
    const second = capture(101, NEXT_HASH, HASH);
    second.transactions[0].hash = NEXT_TX;
    second.events[0].transactionHash = NEXT_TX;
    await journal.commitBlocks([capture(), second]);
    await db.query(
      `INSERT INTO robinhood_wallet_swap_cursors(
         chain, stream, next_block, safe_head, checkpoint_block, checkpoint_hash,
         checkpoint_timestamp, lifecycle_state
       ) VALUES ('robinhood','live',102,101,101,$1,$2,'running')`,
      [`0x${'8'.repeat(64)}`, OBSERVED_AT]
    );
    const plan = {
      generation: '0', reason: 'parent_hash_mismatch', recoverable: true,
      executable: true, pendingRollbackDomains: [], maxDepth: 12,
      rollbackManifestVersion: 2,
      checkpoint: { blockNumber: '101', blockHash: NEXT_HASH },
      incoming: {
        blockNumber: '102', blockHash: `0x${'6'.repeat(64)}`,
        parentHash: `0x${'7'.repeat(64)}`,
      },
      ancestor: { blockNumber: '100', blockHash: HASH },
      affectedRange: { fromBlock: '101', throughBlock: '101', depth: '1' },
    };
    await journal.markRecoveryRequired({ plan });
    await assert.rejects(
      journal.rewindCanonicalRecovery({ generation: '0' }),
      (error) => error.code === 'wallet_recovery_fence_conflict'
    );
    await db.query(
      `UPDATE robinhood_wallet_swap_cursors SET checkpoint_hash=$1
        WHERE chain='robinhood' AND stream='live'`, [NEXT_HASH]
    );
    await db.query(
      `INSERT INTO robinhood_wallet_position_cursors(
         chain, projection_version, stream, origin_block, next_block, safe_head,
         checkpoint_block, checkpoint_hash, next_block_time, lifecycle_state, completed_at
       ) VALUES
         ('robinhood','swap_only_v1','seed',100,101,100,100,$1,$2,'complete',NOW()),
         ('robinhood','swap_only_v1','live',101,102,101,101,$3,$2,'running',NULL)`,
      [HASH, OBSERVED_AT, `0x${'8'.repeat(64)}`]
    );
    await assert.rejects(
      journal.rewindCanonicalRecovery({ generation: '0' }),
      (error) => error.code === 'wallet_position_recovery_fence_conflict'
    );
    assert.equal((await db.query(
      `SELECT canonical FROM robinhood_chain_blocks WHERE block_hash=$1`, [NEXT_HASH]
    )).rows[0].canonical, true);
    assert.equal((await journal.getCursor()).checkpoint_block, '101');
  });

  it('rolls back the rewind when an orphan trade has a conflicting invalidation', async () => {
    const journal = createRobinhoodChainCaptureJournal();
    const second = capture(101, NEXT_HASH, HASH);
    second.transactions[0].hash = NEXT_TX;
    second.events[0].transactionHash = NEXT_TX;
    await journal.commitBlocks([capture(), second]);
    await db.query(
      `INSERT INTO robinhood_wallet_swap_realtime_outbox(
         chain, transaction_hash, log_index, event_kind, block_number,
         block_hash, transaction_index, payload
       ) VALUES
         ('robinhood',$1,0,'observed',101,$2,0,'{}'::jsonb),
         ('robinhood',$1,0,'invalidate',101,$2,0,$3::jsonb)`,
      [NEXT_TX, NEXT_HASH, JSON.stringify({ recoveryGeneration: '9' })]
    );
    const plan = {
      generation: '0', reason: 'parent_hash_mismatch', recoverable: true,
      executable: true, pendingRollbackDomains: [], maxDepth: 12,
      rollbackManifestVersion: 2,
      checkpoint: { blockNumber: '101', blockHash: NEXT_HASH },
      incoming: { blockNumber: '102', blockHash: `0x${'6'.repeat(64)}`,
        parentHash: `0x${'7'.repeat(64)}` },
      ancestor: { blockNumber: '100', blockHash: HASH },
      affectedRange: { fromBlock: '101', throughBlock: '101', depth: '1' },
    };
    await journal.markRecoveryRequired({ plan });
    await assert.rejects(
      journal.rewindCanonicalRecovery({ generation: '0' }),
      (error) => error.code === 'trade_invalidation_conflict'
    );
    assert.equal((await db.query(
      `SELECT canonical FROM robinhood_chain_blocks WHERE block_hash=$1`, [NEXT_HASH]
    )).rows[0].canonical, true);
    assert.equal((await journal.getCursor()).checkpoint_block, '101');
  });

  it('refuses an executable rewind across the current finalized boundary', async () => {
    const journal = createRobinhoodChainCaptureJournal();
    await journal.commitBlock(capture());
    const plan = {
      generation: '0', reason: 'parent_hash_mismatch', recoverable: true,
      executable: true, pendingRollbackDomains: [], maxDepth: 12,
      rollbackManifestVersion: 2,
      checkpoint: { blockNumber: '100', blockHash: HASH },
      incoming: { blockNumber: '101', blockHash: NEXT_HASH,
        parentHash: `0x${'7'.repeat(64)}` },
      ancestor: { blockNumber: '97', blockHash: PARENT },
      affectedRange: { fromBlock: '98', throughBlock: '100', depth: '3' },
    };
    await journal.markRecoveryRequired({ plan });
    await assert.rejects(
      journal.rewindCanonicalRecovery({ generation: '0' }),
      (error) => error.code === 'capture_recovery_finalized_boundary'
    );
    assert.equal((await db.query(
      `SELECT canonical FROM robinhood_chain_blocks WHERE block_hash=$1`, [HASH]
    )).rows[0].canonical, true);
  });

  it('refuses an executable rewind whose ancestor is no longer retained', async () => {
    const journal = createRobinhoodChainCaptureJournal();
    await journal.commitBlock(capture());
    const plan = {
      generation: '0', reason: 'parent_hash_mismatch', recoverable: true,
      executable: true, pendingRollbackDomains: [], maxDepth: 12,
      rollbackManifestVersion: 2,
      checkpoint: { blockNumber: '100', blockHash: HASH },
      incoming: { blockNumber: '101', blockHash: NEXT_HASH,
        parentHash: `0x${'7'.repeat(64)}` },
      ancestor: { blockNumber: '99', blockHash: PARENT },
      affectedRange: { fromBlock: '100', throughBlock: '100', depth: '1' },
    };
    await journal.markRecoveryRequired({ plan });
    await assert.rejects(
      journal.rewindCanonicalRecovery({ generation: '0' }),
      (error) => error.code === 'capture_recovery_below_retention'
    );
    assert.equal((await journal.getCursor()).checkpoint_block, '100');
  });

  it('rejects a commit prepared under an obsolete capture generation', async () => {
    const journal = createRobinhoodChainCaptureJournal();
    await assert.rejects(
      journal.commitBlock(capture(), { expectedGeneration: '1' }),
      (error) => error.code === 'capture_generation_conflict'
    );
    assert.equal((await db.query(
      'SELECT COUNT(*)::int AS blocks FROM robinhood_chain_blocks'
    )).rows[0].blocks, 0);
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

  it('measures mature outbox lag against captured work rather than the legacy lead', async () => {
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
    assert.equal((await audit.inspect({ phase: 'preflight' })).queue.mature_lag_blocks, '0');
    const quiet = capture(101, NEXT_HASH, HASH);
    quiet.transactions[0].hash = NEXT_TX;
    quiet.events = [];
    await createRobinhoodChainCaptureJournal().commitBlock(quiet);
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
