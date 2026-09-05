'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  LEASE_KEYS, MAX_CONTEXT_BLOCKS, createRobinhoodCanonicalWalletSwapAudit, evaluate,
} = require('../src/services/robinhood-canonical-wallet-swap-audit');
const { main, parseArgs } = require('../src/utils/audit-robinhood-canonical-wallet-swap');

function lease(lease_key, overrides = {}) {
  return {
    lease_key, active: true, heartbeat_at: '2026-09-05T10:00:00Z',
    metadata: { telemetry: { running: true, halted: false, lagBlocks: '3' } },
    ...overrides,
  };
}

function input(overrides = {}) {
  const hash = `0x${'a'.repeat(64)}`;
  return {
    confirmations: 12,
    state: {
      capture_next_block: '301', capture_checkpoint_block: '300',
      capture_node_head: '300', journal_start_block: '100',
      processing_next_block: '291', wallet_next_block: '240', wallet_safe_head: '280',
      wallet_checkpoint_block: '238', wallet_checkpoint_hash: hash,
      wallet_checkpoint_timestamp: '2026-09-05T10:00:00Z',
      canonical_wallet_checkpoint_hash: hash, wallet_lifecycle_state: 'running',
      wallet_updated_at: '2026-09-05T10:00:00Z',
      ...overrides,
    },
    context: {
      checked_first_block: '240', checked_last_block: '288',
      accepted_observations: '50', missing_context: '0',
    },
    leases: Object.values(LEASE_KEYS).map((key) => lease(key)),
  };
}

describe('Robinhood canonical wallet-swap audit', () => {
  it('accepts a replayable journal backlog and reports its bounded context proof', () => {
    const report = evaluate(input());
    assert.equal(report.ready, true);
    assert.deepEqual(report.blockers, []);
    assert.equal(report.capture.safe_head, '288');
    assert.equal(report.processing.processable_through_block, '288');
    assert.equal(report.wallet.lag_to_processable_blocks, '49');
    assert.equal(report.handoff.checkpoint_canonical, true);
    assert.deepEqual(report.transaction_context, {
      first_block: '240', last_block: '288', max_blocks: String(MAX_CONTEXT_BLOCKS),
      accepted_observations: 50, missing: 0,
    });
  });

  it('fails closed when accepted observations lack canonical transaction context', () => {
    const state = input();
    state.context = {
      checked_first_block: '240', checked_last_block: '288',
      accepted_observations: '50', missing_context: '2',
      first_missing_block: '245', first_missing_transaction_hash: `0x${'b'.repeat(64)}`,
    };
    assert.deepEqual(evaluate(state).blockers, [{
      code: 'accepted_transaction_context_missing',
      detail: {
        count: 2, first_block: '245',
        transaction_hash: `0x${'b'.repeat(64)}`,
      },
    }]);
  });

  it('requires legacy catch-up while the wallet cursor predates retained journal data', () => {
    const state = input({
      wallet_next_block: '90', wallet_checkpoint_block: '89',
      canonical_wallet_checkpoint_hash: null,
    });
    state.leases = state.leases.filter(({ lease_key }) => lease_key !== LEASE_KEYS.wallet);
    assert.deepEqual(evaluate(state).blockers, [
      { code: 'wallet_checkpoint_not_canonical' },
      { code: 'wallet_before_canonical_journal', detail: '10' },
      { code: 'wallet_catchup_inactive' },
    ]);
  });

  it('rejects unhealthy upstreams and inconsistent wallet state', () => {
    const state = input({
      capture_next_block: '290', wallet_lifecycle_state: 'pending',
      wallet_checkpoint_timestamp: null, wallet_checkpoint_block: '295',
    });
    state.leases = state.leases.filter(({ lease_key }) => lease_key !== LEASE_KEYS.capture);
    assert.deepEqual(evaluate(state).blockers.map(({ code }) => code), [
      'capture_lag_exceeded', 'canonical_capture_inactive', 'wallet_live_not_running',
      'wallet_live_checkpoint_inconsistent', 'wallet_ahead_of_processable_frontier',
    ]);
  });

  it('uses one read-only snapshot and bounds the transaction-context query', async () => {
    const queries = [];
    const fixture = input();
    const client = {
      async query(sql, params) {
        queries.push({ sql, params });
        if (sql.startsWith('BEGIN')) return { rows: [] };
        if (sql.includes('WITH leased AS MATERIALIZED')) return { rows: [fixture.state] };
        if (sql.includes('WITH candidates AS MATERIALIZED')) return { rows: [fixture.context] };
        if (sql.includes('FROM worker_leases')) return { rows: fixture.leases };
        if (sql === 'ROLLBACK') return { rows: [] };
        throw new Error(`unexpected query: ${sql}`);
      },
      release() { queries.push({ sql: 'RELEASE' }); },
    };
    const audit = createRobinhoodCanonicalWalletSwapAudit({
      database: { async getClient() { return client; } }, confirmations: 12,
    });
    assert.equal((await audit.inspect()).ready, true);
    assert.match(queries[0].sql, /REPEATABLE READ READ ONLY/);
    assert.match(queries[1].sql, /WHEN frontier\.block_number IS NULL THEN NULL/);
    assert.deepEqual(queries[2].params, ['robinhood', '240', '288']);
    assert.match(queries[2].sql, /BETWEEN \$2::bigint AND \$3::bigint/);
    assert.equal(queries.at(-2).sql, 'ROLLBACK');
    assert.equal(queries.at(-1).sql, 'RELEASE');
  });

  it('rejects CLI arguments and prints the report', async () => {
    assert.deepEqual(parseArgs([]), {});
    assert.throws(() => parseArgs(['--write']), /unknown argument/);
    const lines = [];
    const report = await main([], {
      audit: { async inspect() { return { mode: 'read-only', ready: true }; } },
      logger: { log(value) { lines.push(value); } },
    });
    assert.equal(report.ready, true);
    assert.deepEqual(JSON.parse(lines[0]), report);
  });
});
