const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodWalletTransferRetentionReadiness,
} = require('../src/models/robinhood-wallet-transfer-retention-readiness');
const {
  createRobinhoodWalletTransferRetentionPlanner,
} = require('../src/models/robinhood-wallet-transfer-retention-plan');
const {
  main,
} = require('../src/utils/audit-robinhood-wallet-transfer-retention-readiness');

const CANDIDATE = {
  partitionDay: '2026-07-18',
  expectedPartition: 'robinhood_token_transfer_events_2026_07_18',
  actualPartition: 'robinhood_token_transfer_events_2026_07_18',
  catalogReady: true,
  rawLastBlock: '13393753',
  watermarkVersion: '0',
  blockedReasons: [],
};

function planner(candidates) {
  return { plan: async () => ({
    retentionDays: 30, cutoffDay: '2026-08-23', limit: 2,
    hasMore: false, candidates,
  }) };
}

describe('Robinhood transfer retention dependency readiness', () => {
  it('passes the verified raw block ceiling from the planner to the readiness probes', async () => {
    const database = { query: async (sql) => {
      assert.match(sql, /watermark\.raw_last_block/);
      return { rows: [{ partition_day: '2026-07-18',
        expected_partition: CANDIDATE.expectedPartition,
        actual_partition: CANDIDATE.actualPartition,
        attached: true,
        partition_bound: `FOR VALUES FROM ('2026-07-18 00:00:00+00') TO ('2026-07-19 00:00:00+00')`,
        watermark_version: '0', raw_last_block: '13393753',
        verified_at: '2026-08-30T08:22:25.049Z' }] };
    } };
    const plan = await createRobinhoodWalletTransferRetentionPlanner({ database }).plan({
      projectionVersion: 'rh_transfer_v1', now: '2026-09-23T00:00:00Z', limit: 1,
    });
    assert.equal(plan.candidates[0].catalogReady, true);
    assert.equal(plan.candidates[0].rawLastBlock, '13393753');
  });

  it('blocks partition deletion when historical raw consumers still need it', async () => {
    const calls = [];
    const database = { queryWithStatementTimeout: async (sql, params, timeout) => {
      calls.push({ sql, params, timeout });
      return { rows: [{ present: true }] };
    } };
    const audit = createRobinhoodWalletTransferRetentionReadiness({
      database, planner: planner([CANDIDATE]),
    });
    const result = await audit.inspect({ projectionVersion: 'rh_transfer_v1' });
    assert.deepEqual(result.candidates[0].blockedReasons, [
      'unpreservedUnknown_candidate', 'endpointRoleGapOnUnknown_candidate',
      'transferPositionRepairCandidate_candidate', 'sellPositionRepairCandidate_candidate',
      'canonicalCheckpointNotProven_candidate',
      'positionPreimageCoverageMissing_candidate',
    ]);
    assert.deepEqual(result.candidates[0].deferredReasons, []);
    assert.equal(result.candidates[0].readyForDrop, false);
    assert.equal(result.destructive, false);
    assert.equal(calls.length, 6);
    assert.match(calls[0].sql, /FROM public\.robinhood_token_transfer_events_2026_07_18 raw/);
    assert.match(calls[0].sql, /robinhood_wallet_transfer_pending_evidence evidence/);
    assert.match(calls[0].sql, /evidence\.amount_raw = raw\.amount_raw/);
    assert.match(calls[0].sql, /robinhood_wallet_transfer_evidence_dispositions disposition/);
    assert.match(calls[1].sql, /robinhood_wallet_endpoint_roles/);
    assert.match(calls[2].sql, /robinhood_bundle_redistribution_queue/);
    assert.match(calls[2].sql, /observation_from_block <= \$4::bigint/);
    assert.match(calls[2].sql, /edge\.first_wallet_transfer_block <= queue\.source_through_block/);
    assert.match(calls[2].sql, /position\.transaction_hash IS NULL/);
    assert.match(calls[3].sql, /swap\.block_number <= queue\.source_through_block/);
    assert.match(calls[3].sql, /position\.transaction_index IS NULL/);
    assert.match(calls[4].sql, /JOIN robinhood_chain_blocks block/);
    assert.match(calls[4].sql, /capture\.finalized_head >= watermark\.checkpoint_block/);
    assert.match(calls[5].sql, /robinhood_wallet_position_reorg_preimages marker/);
    assert.deepEqual(calls[0].params, ['robinhood']);
    assert.deepEqual(calls[1].params, ['robinhood']);
    assert.deepEqual(calls[2].params, [
      'robinhood', '2026-07-18T00:00:00.000Z', '2026-07-19T00:00:00.000Z',
      '13393753',
    ]);
    assert.deepEqual(calls[3].params, calls[2].params);
    assert.deepEqual(calls[4].params, ['robinhood', 'rh_transfer_v1', '2026-07-18', '0']);
    assert.deepEqual(calls[5].params, ['robinhood']);
    for (const call of calls) {
      assert.doesNotMatch(call.sql, /\b(?:DROP|DELETE|UPDATE|INSERT)\b/i);
    }
    assert.equal(calls[0].timeout, 120_000);
    for (const call of calls.slice(1)) assert.equal(call.timeout, 5_000);
    assert.equal(result.candidates[0].dependencies.unpreservedUnknown.status, 'candidate');
    assert.equal(result.candidates[0].dependencies.transferPositionRepairCandidate.status, 'candidate');
  });

  it('defers a role gap only when every unknown has preserved evidence', async () => {
    const database = { queryWithStatementTimeout: async (sql) => ({
      rows: [{ present: sql.includes('robinhood_wallet_endpoint_roles role') }],
    }) };
    const audit = createRobinhoodWalletTransferRetentionReadiness({
      database, planner: planner([CANDIDATE]),
    });
    const [candidate] = (await audit.inspect()).candidates;
    assert.deepEqual(candidate.blockedReasons, []);
    assert.deepEqual(candidate.deferredReasons, ['endpointRoleGapOnUnknown_candidate']);
    assert.equal(candidate.provisionalGatesClear, true);
    assert.equal(candidate.readyForDrop, false);
  });

  it('isolates a timeout to its probe and never promotes provisional clearance into drop approval', async () => {
    const timeout = createRobinhoodWalletTransferRetentionReadiness({
      database: { queryWithStatementTimeout: async (sql) => {
        if (sql.includes('robinhood_wallet_endpoint_roles')) throw new Error('statement timeout');
        return { rows: [{ present: false }] };
      } },
      planner: planner([CANDIDATE]),
    });
    const timedOut = await timeout.inspect();
    assert.deepEqual(timedOut.candidates[0].blockedReasons, ['endpointRoleGapOnUnknown_unknown']);
    assert.deepEqual(timedOut.candidates[0].deferredReasons, []);
    assert.equal(timedOut.candidates[0].dependencies.unpreservedUnknown.status, 'absent');
    assert.equal(timedOut.candidates[0].dependencies.transferPositionRepairCandidate.status, 'absent');
    assert.equal(timedOut.candidates[0].dependencies.sellPositionRepairCandidate.status, 'absent');
    assert.equal(timedOut.candidates[0].dependencies.endpointRoleGapOnUnknown.error, 'statement timeout');
    const incomplete = createRobinhoodWalletTransferRetentionReadiness({
      database: { queryWithStatementTimeout: async () => ({ rows: [{}] }) },
      planner: planner([CANDIDATE]),
    });
    assert.deepEqual((await incomplete.inspect()).candidates[0].blockedReasons, [
      'unpreservedUnknown_unknown', 'endpointRoleGapOnUnknown_unknown',
      'transferPositionRepairCandidate_unknown', 'sellPositionRepairCandidate_unknown',
      'canonicalCheckpointNotProven_unknown',
      'positionPreimageCoverageMissing_unknown',
    ]);
    const clear = createRobinhoodWalletTransferRetentionReadiness({
      database: { queryWithStatementTimeout: async () => ({ rows: [{ present: false }] }) },
      planner: planner([CANDIDATE]),
    });
    const result = await clear.inspect();
    assert.equal(result.candidates[0].provisionalGatesClear, true);
    assert.equal(result.candidates[0].readyForDrop, false);
    assert.equal(result.requiresCanonicalRevalidation, true);
  });

  it('blocks when the recorded canonical checkpoint is no longer provable', async () => {
    const database = { queryWithStatementTimeout: async (sql) => ({
      rows: [{ present: sql.includes('FROM robinhood_wallet_transfer_compaction_watermarks watermark') }],
    }) };
    const audit = createRobinhoodWalletTransferRetentionReadiness({
      database, planner: planner([CANDIDATE]),
    });
    const [candidate] = (await audit.inspect({ projectionVersion: 'rh_transfer_v1' })).candidates;
    assert.deepEqual(candidate.blockedReasons, ['canonicalCheckpointNotProven_candidate']);
    assert.equal(candidate.provisionalGatesClear, false);
    assert.equal(candidate.readyForDrop, false);
  });

  it('blocks when recent unified position batches have no preimage coverage', async () => {
    const database = { queryWithStatementTimeout: async (sql) => ({
      rows: [{ present: sql.includes('WITH state AS') }],
    }) };
    const audit = createRobinhoodWalletTransferRetentionReadiness({
      database, planner: planner([CANDIDATE]),
    });
    const [candidate] = (await audit.inspect({ projectionVersion: 'rh_transfer_v1' })).candidates;
    assert.deepEqual(candidate.blockedReasons, ['positionPreimageCoverageMissing_candidate']);
    assert.equal(candidate.readyForDrop, false);
  });

  it('does not query an unverified catalog row or trust a mismatched partition identity', async () => {
    const database = { queryWithStatementTimeout: async () => {
      throw new Error('unexpected query');
    } };
    const blocked = createRobinhoodWalletTransferRetentionReadiness({
      database,
      planner: planner([{ ...CANDIDATE, catalogReady: false, blockedReasons: ['partition_not_attached'] }]),
    });
    assert.deepEqual((await blocked.inspect()).candidates[0].blockedReasons, ['partition_not_attached']);
    const mismatch = createRobinhoodWalletTransferRetentionReadiness({
      database,
      planner: planner([{ ...CANDIDATE, actualPartition: 'other_partition' }]),
    });
    await assert.rejects(mismatch.inspect(), /partition identity mismatch/);
  });

  it('exposes a read-only CLI', async () => {
    const report = await main(['--projection-version=rh_transfer_v1', '--limit=1'], {
      logger: { log() {} }, database: {},
      auditorFactory: () => ({ inspect: async (input) => {
        assert.equal(input.projectionVersion, 'rh_transfer_v1');
        assert.equal(input.limit, '1');
        return { mode: 'read-only', destructive: false };
      } }),
    });
    assert.equal(report.destructive, false);
    await assert.rejects(main(['--commit'], { logger: { log() {} } }), /unknown argument/);
  });
});
