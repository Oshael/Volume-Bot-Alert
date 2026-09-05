'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  LEASE_KEYS, MAX_CONTEXT_BLOCKS,
  createRobinhoodCanonicalSignedOriginAudit, evaluate,
} = require('../src/services/robinhood-canonical-signed-origin-audit');
const { main, parseArgs } = require('../src/utils/audit-robinhood-canonical-signed-origin');

const HASH = `0x${'a'.repeat(64)}`;

function lease(lease_key) {
  return {
    lease_key, active: true, heartbeat_at: '2026-09-05T20:00:00Z',
    metadata: { telemetry: {
      running: true, halted: false, sourceMode: 'canonical_journal', lastError: null,
    } },
  };
}

function input(overrides = {}) {
  return {
    confirmations: 2,
    state: {
      capture_next_block: '501', capture_checkpoint_block: '500',
      capture_node_head: '500', journal_start_block: '100',
      live_origin_block: '50', live_next_block: '450', live_safe_head: '449',
      live_checkpoint_block: '449', live_checkpoint_hash: HASH,
      live_checkpoint_timestamp: '2026-09-05T20:00:00Z',
      live_lifecycle_state: 'caught_up', live_updated_at: '2026-09-05T20:00:00Z',
      canonical_live_checkpoint_hash: HASH, legacy_discovery_safe_head: '449',
      seed_next_block: '400', seed_safe_head: '399', seed_lifecycle_state: 'completed',
      ...overrides,
    },
    context: {
      checked_first_block: '450', checked_last_block: '498',
      expected_blocks: '49', canonical_blocks: '49', missing_blocks: '0',
      transactions: '1000', transactions_missing_nonce: '0',
    },
    leases: Object.values(LEASE_KEYS).map(lease),
  };
}

describe('Robinhood canonical signed-origin audit', () => {
  it('accepts a complete cursor with reusable canonical backlog', () => {
    const report = evaluate(input());
    assert.equal(report.ready, true);
    assert.deepEqual(report.blockers, []);
    assert.equal(report.capture.safe_head, '498');
    assert.equal(report.signed_origin.lag_to_canonical_safe_head, '49');
    assert.equal(report.handoff.pre_journal_blocks_remaining, '0');
    assert.deepEqual(report.context, {
      first_block: '450', last_block: '498', max_blocks: String(MAX_CONTEXT_BLOCKS),
      expected_blocks: 49, canonical_blocks: 49, transactions: 1000,
      transactions_missing_nonce: 0, missing_blocks: 0,
    });
  });

  it('fails closed on missing blocks and transaction nonce', () => {
    const state = input();
    Object.assign(state.context, {
      missing_blocks: '2', first_missing_block: '455', transactions_missing_nonce: '3',
    });
    assert.deepEqual(evaluate(state).blockers, [
      { code: 'canonical_block_context_missing', detail: { count: 2, first_block: '455' } },
      { code: 'canonical_transaction_nonce_missing', detail: 3 },
    ]);
  });

  it('requires completed seed and a consistent canonical LIVE checkpoint', () => {
    const state = input({
      seed_lifecycle_state: 'running', live_next_block: '451',
      canonical_live_checkpoint_hash: `0x${'b'.repeat(64)}`,
    });
    assert.deepEqual(evaluate(state).blockers.map(({ code }) => code), [
      'signed_origin_seed_incomplete', 'signed_origin_live_checkpoint_inconsistent',
    ]);
  });

  it('identifies a pre-journal range that cannot catch up without its worker', () => {
    const state = input({
      live_next_block: '90', live_checkpoint_block: '89',
      canonical_live_checkpoint_hash: null,
    });
    state.leases = state.leases.filter(({ lease_key }) => lease_key !== LEASE_KEYS.signedOrigin);
    assert.deepEqual(evaluate(state).blockers.map(({ code }) => code), [
      'signed_origin_live_checkpoint_not_canonical',
      'signed_origin_before_canonical_journal', 'signed_origin_catchup_inactive',
    ]);
  });

  it('requires an active canonical source during cutover', () => {
    const state = input();
    state.phase = 'cutover';
    state.leases.find(({ lease_key }) => lease_key === LEASE_KEYS.signedOrigin)
      .metadata.telemetry.sourceMode = 'rpc';
    assert.deepEqual(evaluate(state).blockers, [{
      code: 'signed_origin_source_not_canonical', detail: 'rpc',
    }]);
  });

  it('uses a repeatable read-only snapshot and a bounded next page', async () => {
    const fixture = input();
    const calls = [];
    const client = {
      async query(sql, params) {
        calls.push({ sql, params });
        if (sql.startsWith('BEGIN')) return { rows: [] };
        if (sql.includes('live.origin_block')) return { rows: [fixture.state] };
        if (sql.includes('WITH expected AS MATERIALIZED')) return { rows: [fixture.context] };
        if (sql.includes('FROM worker_leases')) return { rows: fixture.leases };
        if (sql === 'ROLLBACK') return { rows: [] };
        throw new Error(`unexpected query: ${sql}`);
      },
      release() { calls.push({ sql: 'RELEASE' }); },
    };
    const audit = createRobinhoodCanonicalSignedOriginAudit({
      database: { async getClient() { return client; } }, confirmations: 2,
    });
    assert.equal((await audit.inspect()).ready, true);
    assert.match(calls[0].sql, /REPEATABLE READ READ ONLY/);
    assert.deepEqual(calls[2].params, ['robinhood', '450', '498']);
    assert.match(calls[2].sql, /nonce IS NULL/);
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
