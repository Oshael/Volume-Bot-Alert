'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  LEASE_KEYS, createRobinhoodCanonicalBundleFundingAudit, evaluate,
} = require('../src/services/robinhood-canonical-bundle-funding-audit');
const { main, parseArgs } = require('../src/utils/audit-robinhood-canonical-bundle-funding');

function lease(lease_key) {
  return {
    lease_key, active: true, heartbeat_at: '2026-09-05T23:00:00Z',
    metadata: { telemetry: {
      running: true, sourceMode: lease_key === LEASE_KEYS.bundleFunding
        ? 'canonical_journal' : null,
      lastError: null,
    } },
  };
}

function input(overrides = {}) {
  return {
    phase: 'preflight',
    state: {
      capture_next_block: '2001', capture_checkpoint_block: '2000',
      capture_node_head: '2000', journal_start_block: '500',
      journal_through_block: '2000', total_tasks: '9', completed_tasks: '6',
      historical_completed_tasks: '4', persisted_start_block: '50', pending_tasks: '2',
      archive_required_tasks: '0',
      leased_tasks: '1', active_tasks: '3', required_start_block: '900',
      required_through_block: '1900', first_seed_run_id: '7',
      first_source_next_block: '1990', first_seed_status: 'completed',
      ...overrides,
    },
    sample: {
      sample_blocks: '200', missing_blocks: '0', transactions: '4000',
      missing_value_transactions: '0', positive_native_transfers: '300',
    },
    leases: Object.values(LEASE_KEYS).map(lease),
  };
}

describe('Robinhood canonical bundle-funding audit', () => {
  it('accepts a covered reprocessable queue and reports the source contract', () => {
    const report = evaluate(input());
    assert.equal(report.ready, true);
    assert.deepEqual(report.blockers, []);
    assert.equal(report.handoff.pre_journal_blocks_remaining, '0');
    assert.equal(report.context.sampled_blocks, 200);
    assert.deepEqual(report.historical, {
      oldest_persisted_start_block: '50', completed_before_journal: 4,
      archive_required: 0,
      evidence_policy: 'preserve_until_explicit_archive_repair',
    });
    assert.deepEqual(report.contract, {
      source: 'robinhood_chain_blocks+robinhood_chain_transactions',
      top_level_native_transfers: 'covered', internal_native_transfers: 'out_of_scope',
    });
  });

  it('does not treat preserved completed history as active canonical work', () => {
    const fixture = input({
      active_tasks: '0', pending_tasks: '0', leased_tasks: '0',
      required_start_block: null, required_through_block: null,
      persisted_start_block: '47', historical_completed_tasks: '9',
    });
    fixture.sample = {};
    assert.equal(evaluate(fixture).ready, true);
    assert.equal(evaluate(fixture).historical.completed_before_journal, 9);
  });

  it('rejects a reprocessable range outside journal coverage', () => {
    const report = evaluate(input({
      journal_start_block: '1000', journal_through_block: '1800',
    }));
    assert.deepEqual(report.blockers, [
      { code: 'bundle_funding_before_journal', detail: '100' },
      { code: 'bundle_funding_range_not_captured', detail: '100' },
    ]);
  });

  it('rejects incomplete transaction context in the bounded sample', () => {
    const fixture = input();
    fixture.sample.missing_blocks = '2';
    fixture.sample.missing_value_transactions = '11';
    assert.deepEqual(evaluate(fixture).blockers, [
      { code: 'canonical_sample_missing_blocks', detail: 2 },
      { code: 'canonical_sample_missing_transaction_values', detail: 11 },
    ]);
  });

  it('requires canonical source mode only during cutover', () => {
    const fixture = input();
    fixture.leases.find(({ lease_key }) => lease_key === LEASE_KEYS.bundleFunding)
      .metadata.telemetry.sourceMode = 'rpc';
    assert.equal(evaluate(fixture).ready, true);
    fixture.phase = 'cutover';
    assert.deepEqual(evaluate(fixture).blockers, [
      { code: 'bundle_funding_source_not_canonical', detail: 'rpc' },
    ]);
  });

  it('uses a read-only snapshot and bounds context sampling to journal overlap', async () => {
    const fixture = input();
    const calls = [];
    const client = {
      async query(sql, params) {
        calls.push({ sql, params });
        if (sql.startsWith('BEGIN')) return { rows: [] };
        if (sql.includes('capture.next_block')) return { rows: [fixture.state] };
        if (sql.includes('WITH edge_blocks')) return { rows: [fixture.sample] };
        if (sql.includes('FROM worker_leases')) return { rows: fixture.leases };
        if (sql === 'ROLLBACK') return { rows: [] };
        throw new Error(`unexpected query: ${sql}`);
      },
      release() { calls.push({ sql: 'RELEASE' }); },
    };
    const audit = createRobinhoodCanonicalBundleFundingAudit({
      database: { async getClient() { return client; } },
    });
    assert.equal((await audit.inspect()).ready, true);
    assert.match(calls[0].sql, /REPEATABLE READ READ ONLY/);
    assert.match(calls[1].sql,
      /MIN\(GREATEST\(anchor_block-lookback_blocks, 0\)\)\s+FILTER/);
    assert.deepEqual(calls[2].params, ['robinhood', '900', '1900', '100']);
    assert.equal(calls.at(-2).sql, 'ROLLBACK');
  });

  it('parses phases and prints the report', async () => {
    assert.deepEqual(parseArgs([]), { phase: 'preflight' });
    assert.deepEqual(parseArgs(['--phase=cutover']), { phase: 'cutover' });
    assert.throws(() => parseArgs(['--apply']), /unknown argument/);
    const lines = [];
    const report = await main([], {
      audit: { async inspect() { return { mode: 'read-only', ready: true }; } },
      logger: { log(value) { lines.push(value); } },
    });
    assert.deepEqual(JSON.parse(lines[0]), report);
  });
});
