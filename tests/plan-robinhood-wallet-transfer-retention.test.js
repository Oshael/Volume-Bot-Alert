const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodWalletTransferRetentionPlanner,
  retentionCutoffDay,
} = require('../src/models/robinhood-wallet-transfer-retention-plan');
const {
  main,
  parseArgs,
} = require('../src/utils/plan-robinhood-wallet-transfer-retention');

describe('Robinhood wallet transfer retention planner', () => {
  it('keeps the current day plus 30 complete UTC days', () => {
    assert.equal(retentionCutoffDay('2099-02-15T23:59:59Z'), '2099-01-16');
    assert.throws(() => retentionCutoffDay('invalid'), /valid timestamp/);
  });

  it('is bounded, read-only and marks catalog uncertainty as blocked', async () => {
    const calls = [];
    const database = { query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [{
        partition_day: '2099-01-03', verified_at: '2099-01-05T00:00:00Z',
        watermark_version: '2', expected_partition: 'robinhood_token_transfer_events_2099_01_03',
        actual_partition: null, attached: false, partition_bound: null,
      }] };
    } };
    const planner = createRobinhoodWalletTransferRetentionPlanner({ database });
    const plan = await planner.plan({
      projectionVersion: 'rh_transfer_v1', limit: 5, now: '2099-02-15T00:00:00Z',
    });
    assert.equal(plan.destructive, false);
    assert.equal(plan.cutoffDay, '2099-01-16');
    assert.equal(plan.blocked, 1);
    assert.deepEqual(plan.candidates[0].blockedReasons, ['partition_missing']);
    assert.match(calls[0].sql, /lifecycle_state = 'verified'/);
    assert.doesNotMatch(calls[0].sql, /\b(?:DROP|DELETE|UPDATE|INSERT)\b/i);
    assert.deepEqual(calls[0].params, ['robinhood', 'rh_transfer_v1', '2099-01-16', 6]);
    await assert.rejects(planner.plan({ projectionVersion: 'v1', limit: 101 }), /between 1 and 100/);
  });

  it('exposes only a dry-run CLI with explicit version and limit', async () => {
    assert.deepEqual(parseArgs(['--projection-version=v1', '--limit=3']), {
      projectionVersion: 'v1', limit: '3',
    });
    assert.throws(() => parseArgs(['--commit']), /unknown argument/);
    const calls = [];
    const report = await main(['--projection-version=v1'], {
      database: {}, logger: { log() {} }, now: () => new Date('2099-02-15T00:00:00Z'),
      plannerFactory: () => ({ plan: async (input) => {
        calls.push(input);
        return { destructive: false, candidates: [] };
      } }),
    });
    assert.equal(report.mode, 'dry-run');
    assert.equal(report.destructive, false);
    assert.equal(calls[0].projectionVersion, 'v1');
  });
});
