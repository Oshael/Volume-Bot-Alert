'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  createRobinhoodRetentionSafetyAudit, evaluate, probeArchive,
} = require('../src/services/robinhood-retention-safety-audit');
const { main, parseArgs } = require('../src/utils/audit-robinhood-retention-safety');

function state(overrides = {}) {
  const hash = `0x${'a'.repeat(64)}`;
  return {
    capture_next_block: '1001', capture_node_head: '1000', journal_start_block: '100',
    liquidity_next_block: '950', liquidity_checkpoint_block: '949',
    liquidity_checkpoint_hash: hash, liquidity_canonical_hash: hash,
    holder_next_block: '960', holder_checkpoint_block: '959',
    holder_checkpoint_hash: hash, holder_canonical_hash: hash,
    holder_journal_floor_block: '100',
    creator_next_block: '970', creator_checkpoint_block: '969',
    creator_checkpoint_hash: hash, creator_canonical_hash: hash,
    transfer_next_block: '980', transfer_checkpoint_block: '979',
    transfer_checkpoint_hash: hash, transfer_canonical_hash: hash,
    outbox_first_unsettled: null, oldest_unapplied_holder_block: null,
    global_run_id: null, global_run_status: null, global_run_next_block: null,
    oldest_pending_deployment_mint_block: null,
    chain_events_bytes: '1000000', holder_journal_bytes: '500000',
    ...overrides,
  };
}

const archive = Object.freeze({
  configured: true, ready: true,
  samples: [{ block_number: '100', ready: true }, { block_number: '800', ready: true }],
});

describe('Robinhood retention safety audit', () => {
  it('calculates conservative independent cutoffs and never authorizes a write', () => {
    const report = evaluate({ state: state(), archive,
      chainRetentionBlocks: 100, holderRetentionBlocks: 200 });
    assert.equal(report.ready_for_pilot, true);
    assert.equal(report.action, 'none');
    assert.equal(report.chain_events.candidate_cutoff_block, '850');
    assert.equal(report.holder_journal.candidate_cutoff_block, '760');
    assert.equal(report.chain_events.consumers.liquidity.checkpoint_canonical, true);
    assert.equal(report.proof.scope, 'consumer_checkpoints_plus_sampled_archive_receipts');
  });

  it('fails closed on active backfill, unapplied rows, mint hints and archive failure', () => {
    const report = evaluate({ state: state({
      global_run_id: '9', global_run_status: 'scanning', global_run_next_block: '400',
      oldest_unapplied_holder_block: '500', oldest_pending_deployment_mint_block: '600',
    }), archive: { configured: true, ready: false, samples: [], error: 'timeout' },
    chainRetentionBlocks: 100, holderRetentionBlocks: 200 });
    assert.deepEqual(report.holder_journal.blockers.map(({ code }) => code), [
      'archive_receipt_probe_failed', 'holder_global_backfill_active',
      'unapplied_holder_event_before_cutoff', 'deployment_mint_hint_before_cutoff',
    ]);
    assert.equal(report.ready_for_pilot, false);
  });

  it('rejects a non-canonical consumer checkpoint', () => {
    const report = evaluate({ state: state({ creator_canonical_hash: null }), archive,
      chainRetentionBlocks: 100, holderRetentionBlocks: 200 });
    assert.deepEqual(report.chain_events.blockers, [
      { code: 'consumer_checkpoint_invalid', detail: 'creator' },
    ]);
  });

  it('probes exact archive block hashes and receipt log counts', async () => {
    const hash = `0x${'b'.repeat(64)}`;
    const rpcClient = { async request(method) {
      if (method === 'eth_getBlockByNumber') return { hash };
      return [{ logs: [{}, {}] }, { logs: [{}] }];
    } };
    const result = await probeArchive([
      { block_number: '50', block_hash: hash, event_count: '3' },
      { block_number: '60', block_hash: hash, event_count: '3' },
    ], rpcClient);
    assert.equal(result.ready, true);
    assert.equal(result.samples[0].archive_events, 3);
  });

  it('uses only a repeatable read-only database snapshot', async () => {
    const hash = `0x${'a'.repeat(64)}`;
    const queries = [];
    const client = { async query(sql) {
      queries.push(sql);
      if (sql.startsWith('BEGIN')) return { rows: [] };
      if (sql.startsWith('SELECT capture.next_block')) return { rows: [state()] };
      if (sql.startsWith('SELECT block.block_number')) return { rows: [
        { block_number: '100', block_hash: hash, event_count: '0' },
        { block_number: '849', block_hash: hash, event_count: '0' },
      ] };
      if (sql === 'ROLLBACK') return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    }, release() {} };
    const audit = createRobinhoodRetentionSafetyAudit({
      database: { async getClient() { return client; } },
      chainRetentionBlocks: 100, holderRetentionBlocks: 200,
      rpcClient: {}, async archiveProbe(samples) {
        return { configured: true, ready: samples.length === 2, samples };
      },
    });
    assert.equal((await audit.inspect()).ready_for_pilot, true);
    assert.match(queries[0], /REPEATABLE READ READ ONLY/);
    assert.equal(queries.at(-1), 'ROLLBACK');
    assert.equal(queries.some((sql) => /\b(DELETE|UPDATE|INSERT)\b/.test(sql)), false);
  });

  it('parses options and prints the report', async () => {
    assert.deepEqual(parseArgs([]), {
      chainRetentionBlocks: 20000, holderRetentionBlocks: 20000,
    });
    assert.deepEqual(parseArgs(['--chain-retention-blocks=50000']), {
      chainRetentionBlocks: 50000, holderRetentionBlocks: 20000,
    });
    assert.throws(() => parseArgs(['--apply']), /unknown argument/);
    const output = [];
    const report = await main([], { options: {},
      audit: { async inspect() { return { ready_for_pilot: false }; } },
      logger: { log(value) { output.push(value); } } });
    assert.deepEqual(JSON.parse(output[0]), report);
  });
});
