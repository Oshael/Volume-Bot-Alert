const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  formatSummary, loadSnapshot, parseArgs, summarize,
} = require('../src/utils/monitor-robinhood-wallet-transfer-token-repair');

function snapshot(seconds, overrides = {}) {
  return {
    sampledAt: new Date(seconds * 1000), frontierBlock: 1000n,
    total: 10, published: 2, pending: 7, activeLeased: 1,
    expiredLeased: 0, awaitingPublish: 0, failed: 0,
    effectiveRemaining: 1000n, processed: 0n, progressAgeSeconds: 2,
    ...overrides,
  };
}

describe('Robinhood token repair monitor', () => {
  it('computes ETA from frontier-aware net drain', () => {
    const report = summarize([
      snapshot(0),
      snapshot(60, { effectiveRemaining: 400n, processed: 600n }),
    ], 15);

    assert.equal(report.advanced, 600n);
    assert.equal(report.drained, 600n);
    assert.equal(report.rate, 10);
    assert.equal(report.etaSeconds, 40);
    assert.match(formatSummary(report), /effective_remaining=400/);
    assert.match(formatSummary(report), /eta=40s/);
  });

  it('withholds ETA while frontier growth exceeds processing', () => {
    const report = summarize([
      snapshot(0),
      snapshot(60, { effectiveRemaining: 1200n, processed: 100n }),
    ], 15);

    assert.equal(report.drained, -200n);
    assert.equal(report.etaSeconds, null);
    assert.match(formatSummary(report), /eta=sampling/);
  });

  it('parses bounded monitor cadence', () => {
    assert.deepEqual(parseArgs(['--interval-seconds=30', '--window-minutes=10']), {
      once: false, intervalSeconds: 30, windowMinutes: 10,
    });
    assert.throws(() => parseArgs(['--interval-seconds=1']), /between 5 and 3600/);
  });

  it('loads effective remaining work against the live frontier', async () => {
    let query;
    const database = { async query(sql, params) {
      query = { sql, params };
      return { rows: [{
        sampled_at: '2026-08-28T21:00:00.000Z', frontier_block: '1000',
        total: 10, published: 2, pending: 7, active_leased: 1,
        expired_leased: 0, awaiting_publish: 0, failed: 0,
        effective_remaining_token_blocks: '400', processed_token_blocks: '600',
        progress_age_seconds: 2,
      }] };
    } };

    const result = await loadSnapshot(database);

    assert.equal(result.effectiveRemaining, 400n);
    assert.equal(result.frontierBlock, 1000n);
    assert.deepEqual(query.params, ['rh_transfer_v1']);
    assert.match(query.sql, /frontier\.checkpoint_block - coverage\.next_block \+ 1/);
  });
});
