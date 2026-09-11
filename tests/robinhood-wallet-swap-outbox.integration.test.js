'use strict';

process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');
const db = require('../src/models/db');
const { STATEMENTS } = require('../src/utils/db-init-stage203');
const { STATEMENTS: REALTIME_STATEMENTS } = require('../src/utils/db-init-stage204');
const { STATEMENTS: AUDIT_STATEMENTS } = require('../src/utils/db-init-stage209');
const {
  createRobinhoodWalletSwapOutboxProducer,
} = require('../src/models/robinhood-wallet-swap-outbox-producer');
const {
  createRobinhoodWalletSwapOutboxRepository,
} = require('../src/models/robinhood-wallet-swap-outbox');
const {
  createRobinhoodWalletSwapRealtimeOutboxRepository,
} = require('../src/models/robinhood-wallet-swap-realtime-outbox');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const TX = `0x${'2'.repeat(64)}`;
const BLOCK = `0x${'3'.repeat(64)}`;
const REPLAY_TX = `0x${'7'.repeat(64)}`;
const ORPHAN_BLOCK = `0x${'8'.repeat(64)}`;
const REPLACEMENT_BLOCK = `0x${'9'.repeat(64)}`;
const WALLET = `0x${'4'.repeat(40)}`;
const TOKEN = `0x${'5'.repeat(40)}`;
const QUOTE = `0x${'6'.repeat(40)}`;
let client;

describe('Robinhood wallet-swap outbox producer integration', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    client = await db.getClient();
    await client.query(`CREATE TEMP TABLE robinhood_market_observations (
      chain text, transaction_hash text, log_index bigint, block_number bigint,
      protocol text, market_key text, token_address text, quote_address text,
      side text, status text, token_amount_raw numeric, quote_amount_raw numeric,
      token_decimals smallint, quote_decimals smallint, token_amount numeric,
      quote_amount numeric, price_usd numeric, volume_usd numeric, fdv_usd numeric,
      token_total_supply_raw numeric
    ); CREATE TEMP TABLE robinhood_processed_logs (
      chain text, transaction_hash text, log_index bigint, block_hash text
    ); CREATE TEMP TABLE robinhood_chain_blocks (
      chain text, block_number bigint, block_hash text, block_timestamp timestamptz,
      canonical boolean, head_observed_at timestamptz,
      receipts_available_at timestamptz, captured_at timestamptz
    ); CREATE TEMP TABLE robinhood_chain_transactions (
      chain text, block_hash text, transaction_hash text,
      transaction_index integer, from_address text
    ); CREATE TEMP TABLE robinhood_head_captures (
      chain text, stream text, block_number bigint, processing_status text
    ); CREATE TEMP TABLE robinhood_wallet_swap_cursors (
      chain text, stream text, next_block bigint, safe_head bigint,
      checkpoint_block bigint, checkpoint_hash text, checkpoint_timestamp timestamptz,
      lifecycle_state text, state_reason text, version bigint, updated_at timestamptz
    )`);
    for (const [index, sql] of STATEMENTS.entries()) {
      await client.query(index === 0
        ? sql.replace('CREATE TABLE IF NOT EXISTS', 'CREATE TEMP TABLE')
        : sql);
    }
    for (const [index, sql] of REALTIME_STATEMENTS.entries()) {
      await client.query(index === 0
        ? sql.replace('CREATE TABLE IF NOT EXISTS', 'CREATE TEMP TABLE')
        : sql);
    }
    for (const sql of AUDIT_STATEMENTS) {
      await client.query(sql.replace('CREATE INDEX CONCURRENTLY', 'CREATE INDEX'));
    }
    await client.query(`INSERT INTO robinhood_market_observations VALUES (
      'robinhood',$1,9,100,'uniswap-v3','robinhood:uniswap-v3:test',$2,$3,
      'buy','accepted',1000,2000,18,6,1,2,2,2,2000000,1000000
    )`, [TX, TOKEN, QUOTE]);
    await client.query(
      `INSERT INTO robinhood_processed_logs VALUES ('robinhood',$1,9,$2)`, [TX, BLOCK]
    );
    await client.query(`INSERT INTO robinhood_chain_blocks VALUES (
      'robinhood',100,$1,'2026-09-10T08:00:00Z',TRUE,
      '2026-09-10T08:00:00.010Z','2026-09-10T08:00:00.020Z','2026-09-10T08:00:00.030Z'
    )`, [BLOCK]);
    await client.query(
      `INSERT INTO robinhood_chain_transactions VALUES ('robinhood',$1,$2,3,$3)`,
      [BLOCK, TX, WALLET]
    );
    await client.query(`INSERT INTO robinhood_wallet_swap_cursors VALUES (
      'robinhood','live',100,99,99,$1,'2026-09-10T07:59:59Z','running',NULL,1,NOW()
    )`, [BLOCK]);
  });

  after(async () => {
    client?.release(true);
    await db.pool.end();
  });

  it('captures canonical context atomically and deduplicates replay', async () => {
    const producer = createRobinhoodWalletSwapOutboxProducer();
    const target = [{ transactionHash: TX, logIndex: '9' }];

    assert.deepEqual(await producer.appendAccepted(client, target), {
      requested: 1, eligible: 1, inserted: 1, realtimeInserted: 1,
    });
    assert.deepEqual(await producer.appendAccepted(client, target), {
      requested: 1, eligible: 1, inserted: 0, realtimeInserted: 0,
    });
    const stored = await client.query(
      `SELECT block_number::text, transaction_index, log_index::text, payload
       FROM robinhood_wallet_swap_outbox WHERE transaction_hash = $1`, [TX]
    );
    assert.equal(stored.rows[0].block_number, '100');
    assert.equal(stored.rows[0].transaction_index, 3);
    assert.equal(stored.rows[0].log_index, '9');
    assert.equal(stored.rows[0].payload.walletAddress, WALLET);
    assert.equal(stored.rows[0].payload.blockHash, BLOCK);
    assert.equal(stored.rows[0].payload.transactionIndex, '3');
    assert.equal(stored.rows[0].payload.parserVersion, 'rh-wallet-outbox-1');
    const realtime = await client.query(
      `SELECT event_kind, status, block_hash, payload
       FROM robinhood_wallet_swap_realtime_outbox WHERE transaction_hash = $1`, [TX]
    );
    assert.equal(realtime.rows.length, 1);
    assert.equal(realtime.rows[0].event_kind, 'observed');
    assert.equal(realtime.rows[0].status, 'pending');
    assert.equal(realtime.rows[0].block_hash, BLOCK);
    assert.equal(realtime.rows[0].payload.protocolVersion, 2);
    assert.equal(realtime.rows[0].payload.type, 'market:trade:observed');
    assert.equal(realtime.rows[0].payload.finality, 'observed');
    assert.equal(realtime.rows[0].payload.asOfBlock, '100');
    assert.equal(realtime.rows[0].payload.asOfBlockHash, BLOCK);
    assert.equal(realtime.rows[0].payload.observedAt,
      realtime.rows[0].payload.latency.observationCommittedAt);

    const lifecycle = createRobinhoodWalletSwapRealtimeOutboxRepository({ database: client });
    assert.equal(await lifecycle.promoteFinalized({ throughBlock: '99', limit: 10 }), 0);
    await client.query(
      `UPDATE robinhood_chain_blocks SET canonical=FALSE WHERE block_hash=$1`, [BLOCK]
    );
    assert.equal(await lifecycle.promoteFinalized({ throughBlock: '100', limit: 10 }), 0);
    await client.query(
      `UPDATE robinhood_chain_blocks SET canonical=TRUE WHERE block_hash=$1`, [BLOCK]
    );
    assert.equal(await lifecycle.promoteFinalized({ throughBlock: '100', limit: 10 }), 1);
    assert.equal(await lifecycle.promoteFinalized({ throughBlock: '100', limit: 10 }), 0);
    const finalized = await client.query(
      `SELECT status, payload
         FROM robinhood_wallet_swap_realtime_outbox
        WHERE transaction_hash=$1 AND event_kind='finalized'`, [TX]
    );
    assert.equal(finalized.rows.length, 1);
    assert.equal(finalized.rows[0].status, 'pending');
    assert.equal(finalized.rows[0].payload.type, 'market:trade:finalized');
    assert.equal(finalized.rows[0].payload.finality, 'finalized');
    assert.ok(Date.parse(finalized.rows[0].payload.finalizedAt));
  });

  it('leases finalized canonical work and deletes it only after delivery', async () => {
    const database = {
      query: (...args) => client.query(...args),
      getClient: async () => ({
        query: (...args) => client.query(...args),
        release: () => {},
      }),
    };
    const outbox = createRobinhoodWalletSwapOutboxRepository({ database });
    assert.equal(await outbox.discardLegacyCovered(), 0);
    const claimed = await outbox.claimFinalized({
      owner: 'integration', limit: 10, leaseMs: 60000, throughBlock: '100',
    });
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].transactionHash, TX);
    assert.equal((await outbox.settle({ owner: 'integration', delivered: claimed })).delivered, 1);
    assert.equal(await outbox.advanceCompatibilityWatermark('100'), '100');
    assert.equal((await client.query(
      'SELECT COUNT(*)::int AS count FROM robinhood_wallet_swap_outbox'
    )).rows[0].count, 0);
  });

  it('audits observed before terminal events without changing publication state', async () => {
    const database = {
      query: (...args) => client.query(...args),
      getClient: async () => ({
        query: (...args) => client.query(...args),
        release: () => {},
      }),
    };
    const lifecycle = createRobinhoodWalletSwapRealtimeOutboxRepository({ database });
    const first = await lifecycle.claimAudit({ owner: 'audit', limit: 10, leaseMs: 60000 });
    assert.deepEqual(first.map(({ eventKind }) => eventKind), ['observed']);
    assert.deepEqual(await lifecycle.settleAudit({ owner: 'audit', audited: first }), {
      audited: 1, retried: 0, blocked: 0,
    });

    let terminal = await lifecycle.claimAudit({ owner: 'audit', limit: 10, leaseMs: 60000 });
    assert.deepEqual(terminal.map(({ eventKind }) => eventKind), ['finalized']);
    await client.query(`UPDATE robinhood_wallet_swap_realtime_outbox
      SET audit_lease_until=NOW()-INTERVAL '1 second' WHERE event_kind='finalized'`);
    assert.equal(await lifecycle.reclaimExpiredAuditLeases(), 1);
    terminal = await lifecycle.claimAudit({ owner: 'audit', limit: 10, leaseMs: 60000 });
    assert.deepEqual(await lifecycle.settleAudit({
      owner: 'audit', retry: [{ ...terminal[0], error: 'bad payload', backoffMs: 1 }],
      maxAttempts: 2,
    }), { audited: 0, retried: 0, blocked: 1 });

    const rows = await client.query(
      `SELECT event_kind, status, published_at, audit_status, audit_last_error
         FROM robinhood_wallet_swap_realtime_outbox
        WHERE transaction_hash=$1 ORDER BY event_kind`,
      [TX]
    );
    assert.deepEqual(rows.rows, [{
      event_kind: 'finalized', status: 'pending', published_at: null,
      audit_status: 'blocked', audit_last_error: 'bad payload',
    }, {
      event_kind: 'observed', status: 'pending', published_at: null,
      audit_status: 'complete', audit_last_error: null,
    }]);

    assert.deepEqual(await lifecycle.claimPublication({
      owner: 'publish', limit: 10, leaseMs: 60000, observedEnabled: false,
    }), []);
    const observed = await lifecycle.claimPublication({
      owner: 'publish', limit: 10, leaseMs: 60000, observedEnabled: true,
    });
    assert.deepEqual(observed.map(({ eventKind }) => eventKind), ['observed']);
    assert.deepEqual(await lifecycle.settlePublication({
      owner: 'publish', delivered: observed,
    }), { delivered: 1, retried: 0, blocked: 0 });
    await client.query(`UPDATE robinhood_wallet_swap_realtime_outbox
      SET audit_status='complete', audited_at=NOW(), audit_last_error=NULL
      WHERE transaction_hash=$1 AND event_kind='finalized'`, [TX]);
    const finalized = await lifecycle.claimPublication({
      owner: 'publish', limit: 10, leaseMs: 60000, observedEnabled: false,
    });
    assert.deepEqual(finalized.map(({ eventKind }) => eventKind), ['finalized']);
    assert.deepEqual(await lifecycle.settlePublication({
      owner: 'publish', retry: [{ ...finalized[0], error: 'relay down', backoffMs: 1 }],
      maxAttempts: 1,
    }), { delivered: 0, retried: 0, blocked: 1 });
  });

  it('keeps lifecycle events distinct when the same swap identity moves branches', async () => {
    const producer = createRobinhoodWalletSwapOutboxProducer();
    const lifecycle = createRobinhoodWalletSwapRealtimeOutboxRepository({ database: client });
    const target = [{ transactionHash: REPLAY_TX, logIndex: '4' }];
    const seedBranch = async (blockHash) => {
      await client.query(`INSERT INTO robinhood_market_observations VALUES (
        'robinhood',$1,4,101,'uniswap-v3','robinhood:uniswap-v3:replay',$2,$3,
        'sell','accepted',3000,4000,18,6,3,4,4,4,4000000,1000000
      )`, [REPLAY_TX, TOKEN, QUOTE]);
      await client.query(
        `INSERT INTO robinhood_processed_logs VALUES ('robinhood',$1,4,$2)`,
        [REPLAY_TX, blockHash]
      );
      await client.query(`INSERT INTO robinhood_chain_blocks VALUES (
        'robinhood',101,$1,'2026-09-10T08:00:01Z',TRUE,
        '2026-09-10T08:00:01.010Z','2026-09-10T08:00:01.020Z',
        '2026-09-10T08:00:01.030Z'
      )`, [blockHash]);
      await client.query(
        `INSERT INTO robinhood_chain_transactions VALUES ('robinhood',$1,$2,1,$3)`,
        [blockHash, REPLAY_TX, WALLET]
      );
    };

    await seedBranch(ORPHAN_BLOCK);
    assert.equal((await producer.appendAccepted(client, target)).realtimeInserted, 1);
    assert.deepEqual(await lifecycle.appendOrphanInvalidations(client, {
      generation: '1', fromBlock: '101', throughBlock: '101',
    }), { observed: 1, invalidated: 1 });
    await client.query(
      `UPDATE robinhood_chain_blocks SET canonical=FALSE WHERE block_hash=$1`,
      [ORPHAN_BLOCK]
    );
    await client.query(
      `WITH observations AS (
         DELETE FROM robinhood_market_observations WHERE transaction_hash=$1
       ), processed AS (
         DELETE FROM robinhood_processed_logs WHERE transaction_hash=$1
       ), transactions AS (
         DELETE FROM robinhood_chain_transactions WHERE transaction_hash=$1
       )
       DELETE FROM robinhood_wallet_swap_outbox WHERE transaction_hash=$1`,
      [REPLAY_TX]
    );

    await seedBranch(REPLACEMENT_BLOCK);
    assert.equal((await producer.appendAccepted(client, target)).realtimeInserted, 1);
    assert.equal(await lifecycle.promoteFinalized({ throughBlock: '101', limit: 10 }), 1);
    const events = await client.query(
      `SELECT block_hash, event_kind
         FROM robinhood_wallet_swap_realtime_outbox
        WHERE transaction_hash=$1
        ORDER BY block_hash, event_kind`,
      [REPLAY_TX]
    );
    assert.deepEqual(events.rows, [
      { block_hash: ORPHAN_BLOCK, event_kind: 'invalidate' },
      { block_hash: ORPHAN_BLOCK, event_kind: 'observed' },
      { block_hash: REPLACEMENT_BLOCK, event_kind: 'finalized' },
      { block_hash: REPLACEMENT_BLOCK, event_kind: 'observed' },
    ]);
  });

  it('rejects an accepted identity without committed canonical context', async () => {
    await assert.rejects(
      createRobinhoodWalletSwapOutboxProducer().appendAccepted(client, [{
        transactionHash: `0x${'a'.repeat(64)}`, logIndex: '1',
      }]),
      (error) => error.code === 'wallet_swap_canonical_context_missing'
    );
  });
});
