const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodWalletTransferRetentionReadiness,
} = require('../src/models/robinhood-wallet-transfer-retention-readiness');
const {
  main,
} = require('../src/utils/audit-robinhood-wallet-transfer-retention-readiness');

const CANDIDATE = {
  partitionDay: '2026-07-18',
  expectedPartition: 'robinhood_token_transfer_events_2026_07_18',
  actualPartition: 'robinhood_token_transfer_events_2026_07_18',
  catalogReady: true,
  blockedReasons: [],
};

function planner(candidates) {
  return { plan: async () => ({
    retentionDays: 30, cutoffDay: '2026-08-23', limit: 2,
    hasMore: false, candidates,
  }) };
}

describe('Robinhood transfer retention dependency readiness', () => {
  it('blocks partition deletion when historical raw consumers still need it', async () => {
    const calls = [];
    const database = { queryWithStatementTimeout: async (sql, params, timeout) => {
      calls.push({ sql, params, timeout });
      return { rows: [{ present: true }] };
    } };
    const audit = createRobinhoodWalletTransferRetentionReadiness({
      database, planner: planner([CANDIDATE]),
    });
    const result = await audit.inspect();
    assert.deepEqual(result.candidates[0].blockedReasons, [
      'unknownTransfer_candidate', 'endpointRoleGapOnUnknown_candidate',
      'transferPositionRepairCandidate_candidate', 'sellPositionRepairCandidate_candidate',
    ]);
    assert.equal(result.candidates[0].readyForDrop, false);
    assert.equal(result.destructive, false);
    assert.equal(calls.length, 4);
    assert.match(calls[0].sql, /FROM public\.robinhood_token_transfer_events_2026_07_18 raw/);
    assert.match(calls[1].sql, /robinhood_wallet_endpoint_roles/);
    assert.match(calls[2].sql, /robinhood_bundle_redistribution_queue/);
    assert.match(calls[2].sql, /position\.transaction_hash IS NULL/);
    assert.match(calls[3].sql, /position\.transaction_index IS NULL/);
    assert.deepEqual(calls[0].params, ['robinhood']);
    assert.deepEqual(calls[1].params, ['robinhood']);
    assert.deepEqual(calls[2].params, [
      'robinhood', '2026-07-18T00:00:00.000Z', '2026-07-19T00:00:00.000Z',
    ]);
    assert.deepEqual(calls[3].params, calls[2].params);
    for (const call of calls) {
      assert.doesNotMatch(call.sql, /\b(?:DROP|DELETE|UPDATE|INSERT)\b/i);
      assert.equal(call.timeout, 5_000);
    }
    assert.equal(result.candidates[0].dependencies.unknownTransfer.status, 'candidate');
    assert.equal(result.candidates[0].dependencies.transferPositionRepairCandidate.status, 'candidate');
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
    assert.equal(timedOut.candidates[0].dependencies.unknownTransfer.status, 'absent');
    assert.equal(timedOut.candidates[0].dependencies.transferPositionRepairCandidate.status, 'absent');
    assert.equal(timedOut.candidates[0].dependencies.sellPositionRepairCandidate.status, 'absent');
    assert.equal(timedOut.candidates[0].dependencies.endpointRoleGapOnUnknown.error, 'statement timeout');
    const incomplete = createRobinhoodWalletTransferRetentionReadiness({
      database: { queryWithStatementTimeout: async () => ({ rows: [{}] }) },
      planner: planner([CANDIDATE]),
    });
    assert.deepEqual((await incomplete.inspect()).candidates[0].blockedReasons, [
      'unknownTransfer_unknown', 'endpointRoleGapOnUnknown_unknown',
      'transferPositionRepairCandidate_unknown', 'sellPositionRepairCandidate_unknown',
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
