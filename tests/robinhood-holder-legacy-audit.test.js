'use strict';

const assert = require('node:assert/strict');
const { it } = require('node:test');
const { createRobinhoodHolderLegacyAudit } = require('../src/services/robinhood-holder-legacy-audit');
const { main } = require('../src/utils/audit-robinhood-holder-legacy');

it('classifies legacy states in one read-only snapshot without claiming readiness', async () => {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql.startsWith('BEGIN') || sql.startsWith('SET LOCAL') || sql === 'ROLLBACK') {
        return { rows: [] };
      }
      if (sql.includes('FROM robinhood_holder_cursors cursor')) return { rows: [{
        next_block: '201', checkpoint_block: '200', checkpoint_hash: '0xhash',
        capture_checkpoint_block: '205', journal_floor_block: '100',
        buffer_floor_block: '95', raw_floor_block: '90',
      }] };
      if (sql.includes('GROUP BY ledger_status, coverage')) return { rows: [{
        ledger_status: 'live', coverage: 'legacy_null', total: '2',
        missing_deployment: '0', missing_backfill_cursor: '0',
        backfill_before_deployment: '0', missing_live_checkpoint: '0',
        ahead_of_holder_checkpoint: '0', live_before_deployment: '0',
        oldest_backfill_cursor: '30', newest_backfill_cursor: '40',
      }] };
      if (sql.includes("ledger_status='backfilling'")) return { rows: [{
        token_address: '0xlegacy', ledger_status: 'backfilling',
        deployment_block: '20', backfill_next_block: '25',
        live_through_block: null, live_through_hash: null, holder_count: '1',
        checkpoint_canonical: null, oldest_pending_block: '24', applied_overlap: false,
      }] };
      if (sql.includes('LEFT JOIN LATERAL')) return { rows: [{
        total: '3', with_pending: '2', without_pending: '1',
        nonzero_holders: '0', promotable_by_current_sql: '1',
        missing_deployment: '0', missing_coverage_floor: '0',
        backfill_not_at_deployment: '1', below_buffer_floor: '0',
        below_journal_floor: '1', pending_before_deployment: '0',
        baseline_coverage_eligible: '1',
      }] };
      if (sql.startsWith('EXPLAIN')) return { rows: [{ 'QUERY PLAN': [{ Plan: {
        'Node Type': 'Limit', 'Plan Rows': 1000, 'Total Cost': 42,
        Plans: [{ 'Node Type': 'Index Scan', 'Index Name': 'states_pkey' }],
      } }] }] };
      if (sql.includes('FROM robinhood_holder_global_backfill_tokens token')) {
        return { rows: [{ active_tokens: '7', missing_barrier: '1',
          without_state: '6', state_overlap: '1' }] };
      }
      if (sql.includes('robinhood_holder_legacy_coverage_manifest manifest')) {
        return { rows: [{ legacy_states: '5', current_manifest: '3',
          missing_manifest: '1', stale_manifest: '1', invalidated_manifest: '2' }] };
      }
      if (sql.includes('WITH sample AS')) return { rows: [{
        token_address: '0xlive', ledger_status: 'live', deployment_block: '1',
        backfill_next_block: '30', live_through_block: '190',
        live_through_hash: '0xhash', holder_count: '2',
        checkpoint_canonical: true, pending_at_or_before_state: false,
        pending_anywhere: true,
      }, {
        token_address: '0xshadow', ledger_status: 'shadow', deployment_block: '2',
        backfill_next_block: '2', live_through_block: null,
        live_through_hash: null, holder_count: '0', checkpoint_canonical: null,
        pending_at_or_before_state: null, pending_anywhere: true,
      }] };
      throw new Error('unexpected query');
    },
    release() { calls.push('RELEASE'); },
  };
  const audit = createRobinhoodHolderLegacyAudit({
    database: { async getClient() { return client; } },
  });
  const result = await audit.inspect();
  assert.equal(result.mode, 'read-only');
  assert.equal(result.ready, undefined);
  assert.equal(result.stateGroups[0].total, 2);
  assert.equal(result.globalCohort.withoutState, 6);
  assert.deepEqual(result.manifestCoverage, {
    legacyStates: 5, currentManifest: 3, missingManifest: 1,
    staleManifest: 1, invalidatedManifest: 2,
  });
  assert.equal(result.legacyShadowWithoutCheckpoint.withPending, 2);
  assert.equal(result.legacyShadowWithoutCheckpoint.promotableByCurrentSql, 1);
  assert.equal(result.legacyShadowWithoutCheckpoint.baselineCoverageEligible, 1);
  assert.equal(result.legacyShadowWithoutCheckpoint.belowJournalFloor, 1);
  assert.equal(result.snapshot.bufferFloorBlock, '95');
  assert.equal(result.cohortSelectionPlan.nodes[1].indexName, 'states_pkey');
  assert.equal(result.legacyPromotedSamples[0].checkpointCanonical, true);
  assert.equal(result.legacyPromotedSamples[1].pendingAtOrBeforeState, null);
  assert.equal(result.legacyPromotedSamples[1].pendingAnywhere, true);
  assert.equal(result.legacyBackfilling[0].liveThroughBlock, null);
  assert.equal(result.legacyBackfilling[0].oldestPendingBlock, '24');
  assert.equal(result.legacyBackfilling[0].appliedOverlap, false);
  assert.match(calls[0], /REPEATABLE READ READ ONLY/);
  assert.equal(calls.at(-2), 'ROLLBACK');
  assert.equal(calls.at(-1), 'RELEASE');
  const lines = [];
  assert.deepEqual(await main({ audit, logger: { log: (line) => lines.push(line) } }), result);
  assert.deepEqual(JSON.parse(lines[0]), result);
});

it('rolls back and releases when a diagnostic query fails', async () => {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql.includes('FROM robinhood_holder_cursors cursor')) throw new Error('failed');
      return { rows: [] };
    },
    release() { calls.push('RELEASE'); },
  };
  const audit = createRobinhoodHolderLegacyAudit({
    database: { async getClient() { return client; } },
  });
  await assert.rejects(audit.inspect(), /failed/);
  assert.equal(calls.at(-2), 'ROLLBACK');
  assert.equal(calls.at(-1), 'RELEASE');
});
