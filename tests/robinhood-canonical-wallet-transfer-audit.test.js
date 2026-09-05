'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  LEASE_KEYS, MAX_CONTEXT_BLOCKS, createRobinhoodCanonicalWalletTransferAudit, evaluate,
} = require('../src/services/robinhood-canonical-wallet-transfer-audit');
const { main, parseArgs } = require('../src/utils/audit-robinhood-canonical-wallet-transfer');

const HASH = `0x${'a'.repeat(64)}`;

function lease(lease_key) {
  return { lease_key, active: true, heartbeat_at: '2026-09-05T20:00:00Z',
    metadata: { telemetry: { running: true, halted: false,
      sourceMode: lease_key === LEASE_KEYS.swap ? 'canonical_journal' : null,
      lagBlocks: '0', lastError: null } } };
}

function input(overrides = {}) {
  return {
    confirmations: 2,
    state: {
      capture_next_block: '501', capture_checkpoint_block: '500', capture_node_head: '500',
      journal_start_block: '100', tracked_tokens: '10',
      swap_next_block: '499', swap_safe_head: '498', swap_checkpoint_block: '498',
      swap_checkpoint_hash: HASH, canonical_swap_checkpoint_hash: HASH,
      swap_lifecycle_state: 'running',
      transfer_origin_block: '100', transfer_next_block: '450', transfer_safe_head: '498',
      transfer_checkpoint_block: '449', transfer_checkpoint_hash: HASH,
      canonical_transfer_checkpoint_hash: HASH, transfer_lifecycle_state: 'running',
      transfer_updated_at: '2026-09-05T20:00:00Z',
      position_seed_next_block: '100', position_seed_state: 'complete',
      position_live_next_block: '450', position_live_state: 'running', ...overrides,
    },
    context: { checked_first_block: '450', checked_last_block: '498',
      expected_blocks: '49', canonical_blocks: '49', missing_blocks: '0',
      transfer_events: '20', in_scope_events: '10', malformed_in_scope_events: '0' },
    tokens: { live: 10 }, leases: Object.values(LEASE_KEYS).map(lease),
  };
}

describe('Robinhood canonical wallet-transfer audit', () => {
  it('accepts reusable canonical transfer coverage and reports coupled frontiers', () => {
    const report = evaluate(input());
    assert.equal(report.ready, true);
    assert.deepEqual(report.blockers, []);
    assert.equal(report.wallet_transfer.lag_to_wallet_swap_blocks, '49');
    assert.equal(report.handoff.pre_journal_blocks_remaining, '0');
    assert.equal(report.context.max_blocks, String(MAX_CONTEXT_BLOCKS));
    assert.equal(report.unified_position.aligned_with_transfer, true);
  });

  it('identifies backlog that still requires the legacy source', () => {
    const fixture = input({
      transfer_origin_block: '50', transfer_next_block: '90',
      transfer_checkpoint_block: '89',
    });
    fixture.leases = fixture.leases.filter(({ lease_key }) => lease_key !== LEASE_KEYS.transfer);
    assert.deepEqual(evaluate(fixture).blockers.map(({ code }) => code), [
      'wallet_transfer_before_canonical_journal', 'wallet_transfer_catchup_inactive',
    ]);
  });

  it('fails closed on missing blocks, malformed evidence and noncanonical swap source', () => {
    const fixture = input();
    Object.assign(fixture.context, {
      missing_blocks: '2', first_missing_block: '455', malformed_in_scope_events: '3',
    });
    fixture.leases.find(({ lease_key }) => lease_key === LEASE_KEYS.swap)
      .metadata.telemetry.sourceMode = 'rpc';
    assert.deepEqual(evaluate(fixture).blockers.map(({ code }) => code), [
      'wallet_swap_source_not_canonical', 'canonical_block_context_missing',
      'canonical_transfer_evidence_invalid',
    ]);
  });

  it('uses one repeatable read-only snapshot and bounded canonical context', async () => {
    const fixture = input();
    const calls = [];
    const client = { async query(sql, params) {
      calls.push({ sql, params });
      if (sql.startsWith('BEGIN')) return { rows: [] };
      if (sql.includes('position_seed.next_block')) return { rows: [fixture.state] };
      if (sql.includes('expected AS MATERIALIZED')) return { rows: [fixture.context] };
      if (sql.includes('GROUP BY ledger_status')) return {
        rows: [{ ledger_status: 'live', tokens: '10' }],
      };
      if (sql.includes('FROM worker_leases')) return { rows: fixture.leases };
      if (sql === 'ROLLBACK') return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    }, release() { calls.push({ sql: 'RELEASE' }); } };
    const audit = createRobinhoodCanonicalWalletTransferAudit({
      database: { async getClient() { return client; } }, confirmations: 2,
    });
    const report = await audit.inspect();
    assert.equal(report.ready, true);
    assert.match(calls[0].sql, /REPEATABLE READ READ ONLY/);
    assert.deepEqual(calls[2].params.slice(0, 3), ['robinhood', '450', '498']);
    assert.match(calls[2].sql, /jsonb_array_length\(topics\)<>3/);
    assert.equal(calls.at(-2).sql, 'ROLLBACK');
    assert.equal(calls.at(-1).sql, 'RELEASE');
  });

  it('rejects CLI arguments and prints the read-only report', async () => {
    assert.deepEqual(parseArgs([]), {});
    assert.throws(() => parseArgs(['--write']), /unknown argument/);
    const lines = [];
    const report = await main([], { audit: { async inspect() { return { ready: true }; } },
      logger: { log(value) { lines.push(value); } } });
    assert.deepEqual(JSON.parse(lines[0]), report);
  });
});
