'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  DEFAULT_STATEMENT_TIMEOUT_MS, createRobinhoodRetentionSafetyAudit, evaluate,
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
    outbox_first_unsettled: null, liquidity_dirty_from_block: null,
    liquidity_quarantined_count: '0',
    oldest_unapplied_holder_block: null,
    global_run_id: null, global_run_status: null, global_run_next_block: null,
    oldest_pending_deployment_mint_block: null,
    chain_events_bytes: '1000000', holder_journal_bytes: '500000',
    ...overrides,
  };
}

function classificationRows(overrides = {}) {
  return ['funding', 'deployment', 'redistribution'].map((dependency) => ({
    dependency, items: 0, safe: 0, at_risk: 0, archive_required: 0,
    blocked: 0, oldest_age_s: null, ...(overrides[dependency] || {}),
  }));
}

describe('Robinhood retention safety audit', () => {
  it('calculates conservative independent cutoffs and never authorizes a write', () => {
    const report = evaluate({ state: state(),
      chainRetentionBlocks: 100, holderRetentionBlocks: 200 });
    assert.equal(report.ready_for_pilot, true);
    assert.equal(report.action, 'none');
    assert.equal(report.chain_events.candidate_cutoff_block, '850');
    assert.equal(report.holder_journal.candidate_cutoff_block, '760');
    assert.equal(report.wallet_classification.status, 'safe');
    assert.equal(report.chain_events.consumers.liquidity.checkpoint_canonical, true);
    assert.equal(report.proof.scope,
      'durable_consumer_checkpoints_and_downstream_materialization_gates');
  });

  it('fails closed on active backfill, unapplied rows and required mint hints', () => {
    const report = evaluate({ state: state({
      global_run_id: '9', global_run_status: 'scanning', global_run_next_block: '400',
      oldest_unapplied_holder_block: '500', oldest_pending_deployment_mint_block: '600',
    }),
    chainRetentionBlocks: 100, holderRetentionBlocks: 200 });
    assert.deepEqual(report.holder_journal.blockers.map(({ code }) => code), [
      'holder_global_backfill_active',
      'unapplied_holder_event_before_cutoff', 'deployment_mint_hint_before_cutoff',
    ]);
    assert.equal(report.ready_for_pilot, false);
  });

  it('rejects a non-canonical consumer checkpoint', () => {
    const report = evaluate({ state: state({ creator_canonical_hash: null }),
      chainRetentionBlocks: 100, holderRetentionBlocks: 200 });
    assert.deepEqual(report.chain_events.blockers, [
      { code: 'consumer_checkpoint_invalid', detail: 'creator' },
    ]);
  });

  it('holds chain events behind downstream liquidity materialization', () => {
    const report = evaluate({ state: state({ liquidity_dirty_from_block: '700' }),
      chainRetentionBlocks: 100, holderRetentionBlocks: 200 });
    assert.equal(report.chain_events.source_frontier_block, '700');
    assert.equal(report.chain_events.candidate_cutoff_block, '600');
    assert.equal(report.chain_events.first_pending_liquidity_refresh_block, '700');
  });

  it('reports quarantined pools without letting them constrain retention', () => {
    const report = evaluate({ state: state({ liquidity_quarantined_count: '2' }),
      chainRetentionBlocks: 100, holderRetentionBlocks: 200 });
    assert.equal(report.chain_events.candidate_cutoff_block, '850');
    assert.equal(report.chain_events.first_pending_liquidity_refresh_block, null);
    assert.equal(report.chain_events.quarantined_liquidity_refreshes, '2');
  });

  it('warns at 48 hours and blocks pruning on expired or divergent classification proof', () => {
    const atRisk = evaluate({ state: state(), chainRetentionBlocks: 100,
      holderRetentionBlocks: 200, classification: classificationRows({
        funding: { items: 2, safe: 1, at_risk: 1, oldest_age_s: '172801' },
      }) });
    assert.equal(atRisk.wallet_classification.status, 'at_risk');
    assert.equal(atRisk.chain_events.ready_for_pilot, true);

    const unsafe = evaluate({ state: state(), chainRetentionBlocks: 100,
      holderRetentionBlocks: 200, classification: classificationRows({
        deployment: { items: 1, archive_required: 1, oldest_age_s: '259201' },
        redistribution: { items: 1, blocked: 1, oldest_age_s: '100' },
      }) });
    assert.equal(unsafe.wallet_classification.status, 'blocked');
    assert.deepEqual(unsafe.chain_events.blockers.slice(-2).map(({ code }) => code), [
      'wallet_classification_archive_required', 'wallet_classification_retention_blocked',
    ]);
  });

  it('uses only a repeatable read-only database snapshot', async () => {
    const queries = [];
    const client = { async query(sql) {
      queries.push(sql);
      if (sql.startsWith('BEGIN')) return { rows: [] };
      if (sql.startsWith('SET LOCAL')) return { rows: [] };
      if (sql.startsWith('/* retention-safety:state */')) return { rows: [state()] };
      if (sql.startsWith('/* retention-safety:wallet-classification */')) {
        return { rows: classificationRows() };
      }
      if (sql.startsWith('/* retention-safety:mint */')) {
        return { rows: [{ block_number: null }] };
      }
      if (sql === 'ROLLBACK') return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    }, release() {} };
    const audit = createRobinhoodRetentionSafetyAudit({
      database: { async getClient() { return client; } },
      chainRetentionBlocks: 100, holderRetentionBlocks: 200,
    });
    assert.equal((await audit.inspect()).ready_for_pilot, true);
    assert.match(queries[0], /REPEATABLE READ READ ONLY/);
    assert.equal(queries[1], `SET LOCAL statement_timeout = '${DEFAULT_STATEMENT_TIMEOUT_MS}ms'`);
    assert.match(queries[3], /INTERVAL '48 hours'[\s\S]+INTERVAL '72 hours'/);
    assert.match(queries[4], /EXISTS[\s\S]+robinhood_token_deployment_outbox/);
    assert.match(queries[2], /status<>'quarantined'/);
    assert.doesNotMatch(queries[4], /JOIN LATERAL|UNION ALL/);
    assert.equal(queries.at(-1), 'ROLLBACK');
    assert.equal(queries.some((sql) => /\b(DELETE|UPDATE|INSERT)\b/.test(sql)), false);
  });

  it('skips the mint proof when an active global campaign already blocks retention', async () => {
    const queries = [];
    const client = { async query(sql) {
      queries.push(sql);
      if (sql.startsWith('BEGIN') || sql.startsWith('SET LOCAL') || sql === 'ROLLBACK') {
        return { rows: [] };
      }
      if (sql.startsWith('/* retention-safety:state */')) {
        return { rows: [state({
          global_run_id: '9', global_run_status: 'scanning', global_run_next_block: '400',
        })] };
      }
      if (sql.startsWith('/* retention-safety:wallet-classification */')) {
        return { rows: classificationRows() };
      }
      throw new Error(`unexpected query: ${sql}`);
    }, release() {} };
    const audit = createRobinhoodRetentionSafetyAudit({
      database: { async getClient() { return client; } },
      chainRetentionBlocks: 100, holderRetentionBlocks: 200,
    });
    const report = await audit.inspect();
    assert.equal(report.ready_for_pilot, false);
    assert.equal(report.holder_journal.blockers[0].code, 'holder_global_backfill_active');
    assert.equal(queries.some((sql) => sql.startsWith('/* retention-safety:mint */')), false);
    assert.equal(queries.at(-1), 'ROLLBACK');
  });

  it('can audit chain-event retention without scanning the holder mint proof', async () => {
    const queries = [];
    const client = { async query(sql) {
      queries.push(sql);
      if (sql.startsWith('BEGIN') || sql.startsWith('SET LOCAL') || sql === 'ROLLBACK') {
        return { rows: [] };
      }
      if (sql.startsWith('/* retention-safety:state */')) return { rows: [state()] };
      if (sql.startsWith('/* retention-safety:wallet-classification */')) {
        return { rows: classificationRows() };
      }
      throw new Error(`unexpected query: ${sql}`);
    }, release() {} };
    const audit = createRobinhoodRetentionSafetyAudit({
      database: { async getClient() { return client; } },
      chainRetentionBlocks: 100,
      holderRetentionBlocks: 200,
      includeHolderProof: false,
    });

    const report = await audit.inspect();

    assert.equal(report.chain_events.ready_for_pilot, true);
    assert.equal(report.holder_journal.ready_for_pilot, false);
    assert.equal(report.holder_journal.blockers.at(-1).code, 'holder_mint_proof_not_requested');
    assert.equal(queries.some((sql) => sql.startsWith('/* retention-safety:mint */')), false);
  });

  it('reports the failed read-only phase without weakening the audit', async () => {
    for (const failedPhase of ['state', 'wallet-classification', 'mint']) {
      const queries = [];
      const client = { async query(sql) {
        queries.push(sql);
        if (sql.startsWith('BEGIN') || sql.startsWith('SET LOCAL') || sql === 'ROLLBACK') {
          return { rows: [] };
        }
        if (sql.startsWith(`/* retention-safety:${failedPhase} */`)) {
          throw Object.assign(new Error('statement timeout'), { code: '57014' });
        }
        if (sql.startsWith('/* retention-safety:state */')) return { rows: [state()] };
        if (sql.startsWith('/* retention-safety:wallet-classification */')) {
          return { rows: classificationRows() };
        }
        throw new Error(`unexpected query: ${sql}`);
      }, release() {} };
      const audit = createRobinhoodRetentionSafetyAudit({
        database: { async getClient() { return client; } },
      });
      await assert.rejects(audit.inspect(), (error) => error.code === '57014'
        && error.auditPhase === failedPhase);
      assert.equal(queries.at(-1), 'ROLLBACK');
    }
  });

  it('parses options and prints the report', async () => {
    assert.deepEqual(parseArgs([]), {
      chainRetentionBlocks: 20000, holderRetentionBlocks: 20000,
    });
    assert.deepEqual(parseArgs(['--chain-retention-blocks=50000']), {
      chainRetentionBlocks: 50000, holderRetentionBlocks: 20000,
    });
    assert.deepEqual(parseArgs(['--chain-only']), {
      chainRetentionBlocks: 20000, holderRetentionBlocks: 20000,
      includeHolderProof: false,
    });
    assert.throws(() => parseArgs(['--chain-only', '--chain-only']), /cannot be repeated/);
    assert.throws(() => parseArgs(['--apply']), /unknown argument/);
    const output = [];
    const report = await main([], { options: {},
      audit: { async inspect() { return { ready_for_pilot: false }; } },
      logger: { log(value) { output.push(value); } } });
    assert.deepEqual(JSON.parse(output[0]), report);
    const chainReport = await main(['--chain-only'], {
      auditFactory(options) {
        assert.equal(options.includeHolderProof, false);
        return { async inspect() { return { chain_events: { ready_for_pilot: true } }; } };
      },
      logger: { log() {} },
    });
    assert.equal(chainReport.chain_events.ready_for_pilot, true);
  });
});
