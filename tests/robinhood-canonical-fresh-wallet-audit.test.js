'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  LEASE_KEYS, createRobinhoodCanonicalFreshWalletAudit, evaluate,
} = require('../src/services/robinhood-canonical-fresh-wallet-audit');
const { main, parseArgs } = require('../src/utils/audit-robinhood-canonical-fresh-wallet');

function lease(lease_key) {
  return { lease_key, active: true, heartbeat_at: '2026-09-06T01:00:00Z',
    metadata: { telemetry: { running: true, lastError: null,
      sourceMode: lease_key === LEASE_KEYS.signedOrigin ? 'canonical_journal' : null } } };
}

function fixture(overrides = {}) {
  return {
    state: { capture_next_block: '2001', capture_node_head: '2000',
      journal_start_block: '500', journal_through_block: '2000',
      activation_status: 'active', seed_status: 'completed', total_live: '100',
      pending: '2', leased: '1', active: '3', completed: '97',
      active_through_block: '1900', active_before_journal: '0',
      signed_origin_block: '400', signed_checkpoint_block: '1950',
      signed_lifecycle_state: 'caught_up', ...overrides },
    sample: { sampled: '100', missing_blocks: '0', missing_transactions: '0',
      missing_nonces: '0', divergent: '0' },
    leases: Object.values(LEASE_KEYS).map(lease),
  };
}

describe('Robinhood canonical FRESH preflight', () => {
  it('accepts canonical transaction and signed-origin coverage', () => {
    const report = evaluate(fixture());
    assert.equal(report.ready, true);
    assert.deepEqual(report.blockers, []);
    assert.equal(report.fresh.active, 3);
    assert.equal(report.signed_origin.lag_to_active_blocks, '0');
    assert.deepEqual(report.contract, {
      target: 'robinhood_chain_blocks+robinhood_chain_transactions',
      first_buy_nonce: 'covered', cutoff_24h: 'covered_by_block_timestamps',
      prior_signed_activity: 'robinhood_wallet_signed_origins',
    });
  });

  it('rejects active work whose 24-hour boundary predates the journal', () => {
    const report = evaluate(fixture({ active_before_journal: '7' }));
    assert.deepEqual(report.blockers, [
      { code: 'fresh_active_before_journal', detail: 7 },
    ]);
  });

  it('rejects incomplete canonical first-buy context', () => {
    const input = fixture();
    input.sample = { sampled: '10', missing_blocks: '1', missing_transactions: '2',
      missing_nonces: '3', divergent: '4' };
    assert.deepEqual(evaluate(input).blockers, [
      { code: 'canonical_sample_missing_blocks', detail: 1 },
      { code: 'canonical_sample_missing_transactions', detail: 2 },
      { code: 'canonical_sample_missing_nonces', detail: 3 },
      { code: 'canonical_sample_divergent', detail: 4 },
    ]);
  });

  it('requires an eligible canonical sample when live history exists', () => {
    const input = fixture(); input.sample.sampled = '0';
    assert.deepEqual(evaluate(input).blockers, [{ code: 'canonical_fresh_sample_empty' }]);
  });

  it('requires the canonical signed-origin dependency and live workers', () => {
    const input = fixture();
    const signed = input.leases.find(({ lease_key }) => lease_key === LEASE_KEYS.signedOrigin);
    signed.metadata.telemetry.sourceMode = 'rpc';
    const fresh = input.leases.find(({ lease_key }) => lease_key === LEASE_KEYS.fresh);
    fresh.metadata.telemetry.running = false;
    assert.deepEqual(evaluate(input).blockers, [
      { code: 'signed_origin_source_not_canonical', detail: 'rpc' },
      { code: 'fresh_worker_inactive' },
    ]);
  });

  it('uses a read-only snapshot and bounded sample', async () => {
    const input = fixture(); const calls = [];
    const client = { async query(sql, params) {
      calls.push({ sql, params });
      if (sql.startsWith('BEGIN')) return { rows: [] };
      if (sql.includes('WITH journal') && sql.includes('activation.status')) {
        return { rows: [input.state] };
      }
      if (sql.includes('WITH journal') && sql.includes('missing_transactions')) {
        return { rows: [input.sample] };
      }
      if (sql.includes('FROM worker_leases')) return { rows: input.leases };
      if (sql === 'ROLLBACK') return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    }, release() {} };
    const audit = createRobinhoodCanonicalFreshWalletAudit({
      database: { async getClient() { return client; } },
    });
    assert.equal((await audit.inspect()).ready, true);
    assert.match(calls[0].sql, /REPEATABLE READ READ ONLY/);
    assert.match(calls[1].sql, /ORDER BY block_number LIMIT 1/);
    assert.deepEqual(calls[2].params, ['robinhood', 'rh_fresh_signed_v1', 100]);
    assert.equal(calls.at(-1).sql, 'ROLLBACK');
  });

  it('parses arguments and prints the report', async () => {
    assert.deepEqual(parseArgs([]), {});
    assert.throws(() => parseArgs(['--apply']), /unknown argument/);
    const lines = [];
    const report = await main([], { audit: { async inspect() {
      return { mode: 'read-only', ready: true };
    } }, logger: { log(value) { lines.push(value); } } });
    assert.deepEqual(JSON.parse(lines[0]), report);
  });
});
