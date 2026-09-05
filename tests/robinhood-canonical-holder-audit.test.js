'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  LEASE_KEYS, createRobinhoodCanonicalHolderAudit, evaluate,
} = require('../src/services/robinhood-canonical-holder-audit');
const { main } = require('../src/utils/audit-robinhood-canonical-holder');

function lease(lease_key, overrides = {}) {
  return {
    lease_key, active: true, heartbeat_at: '2026-09-05T10:00:00Z',
    metadata: { telemetry: { running: true, sourceMode: 'rpc', lastError: null } },
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
      holder_next_block: '240', holder_safe_head: '238',
      holder_checkpoint_block: '239', holder_checkpoint_hash: hash,
      canonical_holder_checkpoint_hash: hash,
      holder_journal_floor_block: '120', holder_buffer_floor_block: '130',
      holder_updated_at: '2026-09-05T10:00:00Z',
      total_tokens: '100', pending_tokens: '2', backfilling_tokens: '5',
      shadow_tokens: '3', live_tokens: '87', drifted_tokens: '2',
      resyncing_tokens: '1', invalid_live_frontiers: '0',
      queued_tokens: '4', oldest_pending_block: '220', newest_pending_block: '239',
      ...overrides,
    },
    leases: Object.values(LEASE_KEYS).map((key) => lease(key)),
  };
}

describe('Robinhood canonical holder audit', () => {
  it('allows a replayable holder backlog and reports incomplete tokens separately', () => {
    const report = evaluate(input());
    assert.equal(report.ready, true);
    assert.deepEqual(report.blockers, []);
    assert.equal(report.capture.safe_head, '288');
    assert.equal(report.holder.lag_to_canonical_safe_head, '49');
    assert.deepEqual(report.handoff, {
      journal_start_block: '100', pre_journal_blocks_remaining: '0',
      checkpoint_canonical: true,
    });
    assert.equal(report.tokens.backfilling, 5);
    assert.equal(report.tokens.drifted, 2);
    assert.equal(report.apply.queued_tokens, 4);
  });

  it('blocks a holder cursor outside retained canonical coverage', () => {
    const state = input({
      holder_next_block: '90', holder_checkpoint_block: '89',
      canonical_holder_checkpoint_hash: null,
    });
    state.leases = state.leases.filter(({ lease_key }) => lease_key !== LEASE_KEYS.holder);
    const report = evaluate(state);
    assert.deepEqual(report.blockers, [
      { code: 'holder_checkpoint_not_canonical' },
      { code: 'holder_before_canonical_journal', detail: '10' },
      { code: 'holder_catchup_inactive' },
    ]);
  });

  it('fails closed on unhealthy capture, cursor corruption and invalid live state', () => {
    const state = input({
      capture_next_block: '290', capture_checkpoint_block: '289',
      holder_next_block: '302', holder_checkpoint_block: '300',
      holder_journal_floor_block: null, holder_buffer_floor_block: null,
      invalid_live_frontiers: '3',
    });
    state.leases = state.leases.filter(({ lease_key }) => lease_key !== LEASE_KEYS.capture);
    assert.deepEqual(evaluate(state).blockers, [
      { code: 'capture_lag_exceeded', detail: { actual: '11', maximum: '2' } },
      { code: 'canonical_capture_inactive' },
      { code: 'holder_cursor_checkpoint_inconsistent' },
      { code: 'holder_journal_floor_uninitialized' },
      { code: 'holder_buffer_floor_uninitialized' },
      { code: 'holder_ahead_of_canonical_capture', detail: { holder: '300', capture: '289' } },
      { code: 'holder_live_frontier_invalid', detail: 3 },
    ]);
  });

  it('inspects a single repeatable read-only snapshot with bounded queries', async () => {
    const queries = [];
    const client = {
      async query(sql, params) {
        queries.push({ sql, params });
        if (sql.startsWith('BEGIN')) return { rows: [] };
        if (sql.includes('WITH token_counts AS MATERIALIZED')) return { rows: [input().state] };
        if (sql.includes('FROM worker_leases')) return { rows: input().leases };
        if (sql === 'ROLLBACK') return { rows: [] };
        throw new Error(`unexpected query: ${sql}`);
      },
      release() { queries.push({ sql: 'RELEASE' }); },
    };
    const audit = createRobinhoodCanonicalHolderAudit({
      database: { async getClient() { return client; } }, confirmations: 12,
    });
    assert.equal((await audit.inspect()).ready, true);
    assert.match(queries[0].sql, /REPEATABLE READ READ ONLY/);
    assert.match(queries[1].sql, /robinhood_holder_hot_queue/);
    assert.match(queries[1].sql, /FILTER \(WHERE ledger_status='live' AND/);
    assert.doesNotMatch(queries[1].sql, /ledger_status IN \('shadow','live'\) AND/);
    assert.deepEqual(queries[2].params, [Object.values(LEASE_KEYS)]);
    assert.equal(queries.at(-2).sql, 'ROLLBACK');
    assert.equal(queries.at(-1).sql, 'RELEASE');
  });

  it('keeps the command argument-free and prints the report', async () => {
    const lines = [];
    const report = await main([], {
      audit: { async inspect() { return { mode: 'read-only', ready: true }; } },
      logger: { log(value) { lines.push(value); } },
    });
    assert.equal(report.ready, true);
    assert.deepEqual(JSON.parse(lines[0]), report);
    await assert.rejects(main(['--write'], {}), /unknown argument/);
  });
});
