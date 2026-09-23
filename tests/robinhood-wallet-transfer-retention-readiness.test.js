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
      return { rows: [{
        endpoint_role_missing: true,
        unknown_transfer_present: true,
        redistribution_raw_dependency: true,
      }] };
    } };
    const audit = createRobinhoodWalletTransferRetentionReadiness({
      database, planner: planner([CANDIDATE]),
    });
    const result = await audit.inspect();
    assert.deepEqual(result.candidates[0].blockedReasons, [
      'endpoint_role_missing', 'unknown_transfer_present', 'redistribution_raw_dependency',
    ]);
    assert.equal(result.candidates[0].readyForDrop, false);
    assert.equal(result.destructive, false);
    assert.match(calls[0].sql, /FROM public\.robinhood_token_transfer_events_2026_07_18 raw/);
    assert.match(calls[0].sql, /robinhood_wallet_endpoint_roles/);
    assert.match(calls[0].sql, /robinhood_bundle_redistribution_queue/);
    assert.doesNotMatch(calls[0].sql, /\b(?:DROP|DELETE|UPDATE|INSERT)\b/i);
    assert.deepEqual(calls[0].params, [
      'robinhood', '2026-07-18T00:00:00.000Z', '2026-07-19T00:00:00.000Z',
    ]);
    assert.equal(calls[0].timeout, 30_000);
  });

  it('fails closed on timeout and never promotes provisional clearance into drop approval', async () => {
    const timeout = createRobinhoodWalletTransferRetentionReadiness({
      database: { queryWithStatementTimeout: async () => { throw new Error('statement timeout'); } },
      planner: planner([CANDIDATE]),
    });
    const timedOut = await timeout.inspect();
    assert.deepEqual(timedOut.candidates[0].blockedReasons, ['dependency_audit_failed']);
    const incomplete = createRobinhoodWalletTransferRetentionReadiness({
      database: { queryWithStatementTimeout: async () => ({ rows: [{}] }) },
      planner: planner([CANDIDATE]),
    });
    assert.deepEqual((await incomplete.inspect()).candidates[0].blockedReasons, ['dependency_audit_failed']);
    const clear = createRobinhoodWalletTransferRetentionReadiness({
      database: { queryWithStatementTimeout: async () => ({ rows: [{
        endpoint_role_missing: false,
        unknown_transfer_present: false,
        redistribution_raw_dependency: false,
      }] }) },
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
