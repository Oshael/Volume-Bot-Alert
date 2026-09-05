'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  createRobinhoodCanonicalLiquidityAudit, evaluate,
} = require('../src/services/robinhood-canonical-liquidity-audit');
const { LIQUIDITY_EVENT_TOPICS } = require('../src/services/robinhood-pool-liquidity-events');
const { main } = require('../src/utils/audit-robinhood-canonical-liquidity');

function lease(lease_key) {
  return { lease_key, active: true, heartbeat_at: '2026-09-05T05:00:00Z', metadata: {
    running: true, lastError: null,
  } };
}

function input(overrides = {}) {
  return {
    state: {
      capture_next_block: '201', capture_checkpoint_block: '200',
      capture_node_head: '200', journal_start_block: '100',
      liquidity_coverage_start_block: '1', liquidity_next_block: '150',
      liquidity_checkpoint_block: '149', liquidity_safe_head: '199',
      liquidity_updated_at: '2026-09-05T05:00:00Z',
      processing_checkpoint_block: '199', processing_pending_block: null,
      ...overrides,
    },
    topics: LIQUIDITY_EVENT_TOPICS.map((topic0, index) => ({
      topic0, first_block: String(100 + index), last_block: String(190 + index),
    })),
    leases: [
      lease('robinhood-chain-capture-worker'),
      lease('robinhood-pool-liquidity-worker'),
    ],
  };
}

describe('Robinhood canonical liquidity audit', () => {
  it('reports the replayable journal backlog without treating it as a source gap', () => {
    const report = evaluate(input());
    assert.equal(report.ready, true);
    assert.deepEqual(report.blockers, []);
    assert.deepEqual(report.handoff, {
      journal_start_block: '100', journal_through_block: '200',
      processing_frontier: '199', pre_journal_blocks_remaining: '0',
      journal_blocks_available: '50', processing_blocks_not_captured: '0',
    });
    assert.equal(report.liquidity.lag_to_processing_blocks, '50');
    assert.equal(report.source.configured_topics, 9);
    assert.equal(report.source.observed_topics, 9);
  });

  it('blocks handoff while archive catch-up is still before journal coverage', () => {
    const state = input({ liquidity_next_block: '90', liquidity_checkpoint_block: '89' });
    state.leases = state.leases.filter(({ lease_key }) => !lease_key.includes('liquidity'));
    const report = evaluate(state);
    assert.equal(report.ready, false);
    assert.equal(report.handoff.pre_journal_blocks_remaining, '10');
    assert.deepEqual(report.blockers, [
      { code: 'liquidity_before_journal', detail: '10' },
      { code: 'liquidity_catchup_inactive' },
    ]);
  });

  it('distinguishes unhealthy capture and an uncaptured processing frontier', () => {
    const state = input({ capture_next_block: '190', capture_checkpoint_block: '189' });
    state.leases = state.leases.filter(({ lease_key }) => !lease_key.includes('chain-capture'));
    const report = evaluate(state);
    assert.deepEqual(report.blockers, [
      { code: 'capture_lag_exceeded', detail: '11' },
      { code: 'canonical_capture_inactive' },
      { code: 'journal_behind_processing', detail: '10' },
    ]);
  });

  it('inspects one repeatable read-only snapshot using indexed frontier lookups', async () => {
    const queries = [];
    const client = {
      async query(sql, params) {
        queries.push({ sql, params });
        if (sql.startsWith('BEGIN')) return { rows: [] };
        if (sql.includes('WITH pending AS MATERIALIZED')) return { rows: [input().state] };
        if (sql.includes('unnest($2::text[])')) return { rows: input().topics };
        if (sql.includes('FROM worker_leases')) return { rows: input().leases };
        if (sql === 'ROLLBACK') return { rows: [] };
        throw new Error(`unexpected query: ${sql}`);
      },
      release() { queries.push({ sql: 'RELEASE' }); },
    };
    const audit = createRobinhoodCanonicalLiquidityAudit({
      database: { async getClient() { return client; } },
    });
    assert.equal((await audit.inspect()).ready, true);
    assert.match(queries[0].sql, /REPEATABLE READ READ ONLY/);
    assert.match(queries[1].sql, /robinhood_chain_domain_outbox/);
    assert.doesNotMatch(queries[1].sql, /robinhood_head_capture/);
    assert.deepEqual(queries[2].params, ['robinhood', LIQUIDITY_EVENT_TOPICS]);
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
