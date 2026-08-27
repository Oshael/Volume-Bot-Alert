const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  CONFIRM_FLAG, assertRecoveryIsSafe, main, parseArgs, planFromRow,
} = require('../src/utils/recover-robinhood-bundle-funding-v1');

function row(overrides = {}) {
  return {
    id: '1', status: 'running', evidence_version: 'rh_native_funding_v1',
    range_count: 4496, candidate_count: 24997, total_ranges: 4496,
    pending: 4077, leased: 0, active_leases: 0, completed: 419, failed: 0,
    scoped_evidence_rows: 0, v2_edges_exist: false, ...overrides,
  };
}

describe('Robinhood bundle funding v1 recovery', () => {
  it('is read-only by default and requires a strong apply confirmation', () => {
    assert.deepEqual(parseArgs(['--run-id=1']), {
      apply: false, confirmed: false, runId: '1',
    });
    assert.throws(() => parseArgs(['--run-id=1', '--apply']), new RegExp(CONFIRM_FLAG));
    assert.throws(() => parseArgs(['--run-id=1', CONFIRM_FLAG]), /requires --apply/);
    assert.throws(() => parseArgs(['--run-id=1', '--apply', '--apply']), /repeated/);
    assert.throws(() => parseArgs([]), /run-id is required/);
  });

  it('approves only an untouched v1 lineage with no active leases', () => {
    const plan = planFromRow(row());
    assert.equal(plan.ready, true);
    assert.deepEqual(plan.reasons, []);
    for (const [overrides, reason] of [
      [{ active_leases: 1 }, 'active_range_leases'],
      [{ scoped_evidence_rows: 2 }, 'scoped_evidence_already_exists'],
      [{ v2_edges_exist: true }, 'v2_global_edges_already_exist'],
      [{ evidence_version: 'rh_native_funding_v2' }, 'run_is_not_v1'],
      [{ total_ranges: 4495 }, 'frozen_range_count_mismatch'],
    ]) {
      const unsafe = planFromRow(row(overrides));
      assert.equal(unsafe.ready, false);
      assert.ok(unsafe.reasons.includes(reason));
      assert.throws(() => assertRecoveryIsSafe(unsafe), new RegExp(reason));
    }
  });

  it('prints a read-only report without acquiring a write client', async () => {
    let writeClientRequested = false;
    const database = {
      async query(sql) {
        if (sql.includes('to_regclass')) return { rows: [{ runs: 'runs', ranges: 'ranges',
          evidence: 'evidence', edges: 'edges' }] };
        return { rows: [row()] };
      },
      async getClient() { writeClientRequested = true; },
    };
    const messages = [];
    const report = await main(['--run-id=1'], {
      database,
      logger: { log(message) { messages.push(message); } },
    });
    assert.equal(report.mode, 'read-only');
    assert.equal(report.ready, true);
    assert.equal(writeClientRequested, false);
    assert.match(messages[1], /No data changed/);
  });
});
