'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  LEASE_KEYS, MAX_CONTEXT_BLOCKS,
  createRobinhoodCanonicalDirectCreatorAudit, evaluate,
} = require('../src/services/robinhood-canonical-direct-creator-audit');
const { main, parseArgs } = require('../src/utils/audit-robinhood-canonical-direct-creator');

function lease(lease_key) {
  return {
    lease_key, active: true, heartbeat_at: '2026-09-05T20:00:00Z',
    metadata: { telemetry: {
      running: true, sourceMode: 'canonical_journal', lastError: null,
    } },
  };
}

function input(overrides = {}) {
  const hash = `0x${'a'.repeat(64)}`;
  return {
    confirmations: 2,
    state: {
      capture_next_block: '301', capture_checkpoint_block: '300',
      capture_node_head: '300', journal_start_block: '100',
      creator_next_block: '250', creator_safe_head: '249',
      creator_checkpoint_block: '249', creator_checkpoint_hash: hash,
      creator_checkpoint_timestamp: '2026-09-05T20:00:00Z',
      canonical_creator_checkpoint_hash: hash,
      creator_updated_at: '2026-09-05T20:00:00Z',
      ...overrides,
    },
    context: {
      checked_first_block: '250', checked_last_block: '298',
      expected_blocks: '49', canonical_blocks: '49', missing_blocks: '0',
      direct_deployments: '2', launchpad_events: '3',
    },
    leases: Object.values(LEASE_KEYS).map(lease),
  };
}

describe('Robinhood canonical direct-creator audit', () => {
  it('accepts a continuous canonical backlog without claiming trace coverage', () => {
    const report = evaluate(input());
    assert.equal(report.ready, true);
    assert.deepEqual(report.blockers, []);
    assert.equal(report.capture.safe_head, '298');
    assert.equal(report.direct_creator.lag_to_canonical_safe_head, '49');
    assert.equal(report.handoff.checkpoint_canonical, true);
    assert.deepEqual(report.context, {
      first_block: '250', last_block: '298', max_blocks: String(MAX_CONTEXT_BLOCKS),
      expected_blocks: 49, canonical_blocks: 49, direct_deployments: 2,
      launchpad_events: 3, missing_blocks: 0,
    });
    assert.equal(report.contract.internal_create_create2, 'requires_trace_source');
  });

  it('blocks any hole in the next bounded canonical page', () => {
    const state = input();
    state.context.missing_blocks = '2';
    state.context.first_missing_block = '255';
    assert.deepEqual(evaluate(state).blockers, [{
      code: 'canonical_block_context_missing',
      detail: { count: 2, first_block: '255' },
    }]);
  });

  it('requires RPC catch-up while the cursor predates retained journal data', () => {
    const state = input({
      creator_next_block: '90', creator_checkpoint_block: '89',
      canonical_creator_checkpoint_hash: null,
    });
    state.leases = state.leases.filter(({ lease_key }) => lease_key !== LEASE_KEYS.creator);
    assert.deepEqual(evaluate(state).blockers, [
      { code: 'direct_creator_checkpoint_not_canonical' },
      { code: 'direct_creator_before_canonical_journal', detail: '10' },
      { code: 'direct_creator_catchup_inactive' },
    ]);
  });

  it('fails closed on capture lag and an inconsistent or advanced checkpoint', () => {
    const state = input({
      capture_next_block: '290', creator_next_block: '302',
      creator_checkpoint_block: '300', creator_checkpoint_timestamp: null,
    });
    state.leases = state.leases.filter(({ lease_key }) => lease_key !== LEASE_KEYS.capture);
    assert.deepEqual(evaluate(state).blockers.map(({ code }) => code), [
      'capture_lag_exceeded', 'canonical_capture_inactive',
      'direct_creator_checkpoint_inconsistent', 'direct_creator_ahead_of_canonical_capture',
    ]);
  });

  it('requires an active canonical worker during cutover', () => {
    const state = input();
    state.phase = 'cutover';
    state.leases.find(({ lease_key }) => lease_key === LEASE_KEYS.creator)
      .metadata.telemetry.sourceMode = 'rpc';
    assert.deepEqual(evaluate(state).blockers, [{
      code: 'direct_creator_source_not_canonical', detail: 'rpc',
    }]);
  });

  it('uses a repeatable read-only snapshot and checks at most 200 blocks', async () => {
    const calls = [];
    const fixture = input();
    const client = {
      async query(sql, params) {
        calls.push({ sql, params });
        if (sql.startsWith('BEGIN')) return { rows: [] };
        if (sql.includes('creator.next_block')) return { rows: [fixture.state] };
        if (sql.includes('WITH expected AS MATERIALIZED')) return { rows: [fixture.context] };
        if (sql.includes('FROM worker_leases')) return { rows: fixture.leases };
        if (sql === 'ROLLBACK') return { rows: [] };
        throw new Error(`unexpected query: ${sql}`);
      },
      release() { calls.push({ sql: 'RELEASE' }); },
    };
    const audit = createRobinhoodCanonicalDirectCreatorAudit({
      database: { async getClient() { return client; } }, confirmations: 2,
    });
    assert.equal((await audit.inspect()).ready, true);
    assert.match(calls[0].sql, /REPEATABLE READ READ ONLY/);
    assert.deepEqual(calls[2].params.slice(0, 3), ['robinhood', '250', '298']);
    assert.match(calls[2].sql, /generate_series\(\$2::bigint, \$3::bigint\)/);
    assert.match(calls[2].sql, /block\.canonical=TRUE/);
    assert.equal(calls.at(-2).sql, 'ROLLBACK');
    assert.equal(calls.at(-1).sql, 'RELEASE');
  });

  it('rejects CLI arguments and prints the report', async () => {
    assert.deepEqual(parseArgs([]), { phase: 'preflight' });
    assert.deepEqual(parseArgs(['--phase=cutover']), { phase: 'cutover' });
    assert.throws(() => parseArgs(['--write']), /unknown argument/);
    const lines = [];
    const report = await main([], {
      audit: { async inspect() { return { mode: 'read-only', ready: true }; } },
      logger: { log(value) { lines.push(value); } },
    });
    assert.deepEqual(JSON.parse(lines[0]), report);
  });
});
