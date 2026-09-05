'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  LEASE_KEYS, createRobinhoodCanonicalFirstBuyAudit, evaluate,
} = require('../src/services/robinhood-canonical-first-buy-audit');
const { main, parseArgs } = require('../src/utils/audit-robinhood-canonical-first-buy');

const HASH = `0x${'a'.repeat(64)}`;

function lease(lease_key) {
  return {
    lease_key, active: true, heartbeat_at: '2026-09-05T23:00:00Z',
    metadata: { telemetry: {
      running: true, halted: false, sourceMode: lease_key === LEASE_KEYS.walletSwap
        ? 'canonical_journal' : null,
      lagMs: 0, lastError: null,
    } },
  };
}

function input(overrides = {}) {
  return {
    state: {
      capture_next_block: '1001', capture_checkpoint_block: '1000',
      capture_node_head: '1000', journal_start_block: '500',
      swap_next_block: '999', swap_checkpoint_block: '998',
      swap_checkpoint_hash: HASH, canonical_swap_checkpoint_hash: HASH,
      swap_checkpoint_timestamp: '2026-09-05T23:00:00.000Z',
      swap_lifecycle_state: 'running', first_seed_run_id: '7', seed_status: 'completed',
      first_next_time: '2026-09-05T22:59:59.001Z',
      first_source_through: '2026-09-05T22:59:59.001Z',
      first_source_next_block: '997', first_updated_at: '2026-09-05T23:00:00Z',
      ...overrides,
    },
    leases: Object.values(LEASE_KEYS).map(lease),
  };
}

describe('Robinhood canonical first-buy audit', () => {
  it('accepts first-buy as an indirect canonical projection', () => {
    const report = evaluate(input());
    assert.equal(report.ready, true);
    assert.deepEqual(report.blockers, []);
    assert.equal(report.first_buy.lag_to_wallet_swap_ms, 1000);
    assert.equal(report.first_buy.lag_to_wallet_swap_blocks, '2');
    assert.deepEqual(report.dependency, {
      source: 'robinhood_wallet_swaps', canonical_indirect: true,
      direct_rpc_reads: false, direct_chain_journal_reads: false,
    });
  });

  it('fails when wallet-swap is not canonical', () => {
    const state = input();
    state.leases.find(({ lease_key }) => lease_key === LEASE_KEYS.walletSwap)
      .metadata.telemetry.sourceMode = 'rpc';
    assert.deepEqual(evaluate(state).blockers, [{
      code: 'wallet_swap_source_not_canonical', detail: 'rpc',
    }]);
  });

  it('fails on an invalid seed and first-buy frontiers ahead of swaps', () => {
    const report = evaluate(input({
      seed_status: 'failed', first_next_time: '2026-09-05T23:00:01.002Z',
      first_source_through: '2026-09-05T23:00:01.002Z', first_source_next_block: '1000',
    }));
    assert.deepEqual(report.blockers.map(({ code }) => code), [
      'first_buy_seed_incomplete', 'first_buy_ahead_of_wallet_swap',
      'first_buy_block_frontier_ahead',
    ]);
  });

  it('requires active healthy consumers', () => {
    const state = input();
    state.leases = state.leases.filter(({ lease_key }) => lease_key !== LEASE_KEYS.firstBuy);
    assert.deepEqual(evaluate(state).blockers, [{ code: 'first_buy_worker_inactive' }]);
  });

  it('requires a materialized first-buy block frontier', () => {
    assert.deepEqual(evaluate(input({ first_source_next_block: null })).blockers, [
      { code: 'first_buy_block_frontier_missing' },
    ]);
  });

  it('uses one repeatable read-only snapshot', async () => {
    const fixture = input();
    const calls = [];
    const client = {
      async query(sql, params) {
        calls.push({ sql, params });
        if (sql.startsWith('BEGIN')) return { rows: [] };
        if (sql.includes('capture.next_block')) return { rows: [fixture.state] };
        if (sql.includes('FROM worker_leases')) return { rows: fixture.leases };
        if (sql === 'ROLLBACK') return { rows: [] };
        throw new Error(`unexpected query: ${sql}`);
      },
      release() { calls.push({ sql: 'RELEASE' }); },
    };
    const audit = createRobinhoodCanonicalFirstBuyAudit({
      database: { async getClient() { return client; } },
    });
    assert.equal((await audit.inspect()).ready, true);
    assert.match(calls[0].sql, /REPEATABLE READ READ ONLY/);
    assert.deepEqual(calls[1].params, ['robinhood']);
    assert.equal(calls.at(-2).sql, 'ROLLBACK');
  });

  it('rejects write-like CLI arguments and prints the report', async () => {
    assert.deepEqual(parseArgs([]), {});
    assert.throws(() => parseArgs(['--write']), /unknown argument/);
    const lines = [];
    const report = await main([], {
      audit: { async inspect() { return { mode: 'read-only', ready: true }; } },
      logger: { log(value) { lines.push(value); } },
    });
    assert.deepEqual(JSON.parse(lines[0]), report);
  });
});
