const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  assertReplayIsSafe,
  inspectMarketReplay,
  resetMarketReplay,
} = require('../src/utils/reset-robinhood-market-replay');

function safeRow(overrides = {}) {
  return {
    live_worker: false,
    market_next_block: '147178',
    replay_start_block: '9486',
    pools: 3853,
    has_market_logs: true,
    has_observations: true,
    has_accepted_observations: false,
    has_bucket_rows: false,
    ...overrides,
  };
}

describe('Robinhood market replay reset', () => {
  it('builds a dry-run plan without mutating market state', async () => {
    let calls = 0;
    const database = { query: async () => { calls += 1; return { rows: [safeRow()] }; } };
    const plan = await inspectMarketReplay(database);

    assert.equal(calls, 1);
    assert.deepEqual(plan, {
      liveWorker: false,
      marketNextBlock: '147178',
      replayStartBlock: '9486',
      pools: 3853,
      hasMarketLogs: true,
      hasObservations: true,
      hasAcceptedObservations: false,
      hasBucketRows: false,
    });
  });

  it('refuses active workers, missing registries and accepted market data', () => {
    const base = {
      liveWorker: false, marketNextBlock: '10', pools: 1,
      hasAcceptedObservations: false, hasBucketRows: false,
    };
    assert.throws(() => assertReplayIsSafe({ ...base, liveWorker: true }), /still active/);
    assert.throws(() => assertReplayIsSafe({ ...base, marketNextBlock: null }), /already absent/);
    assert.throws(() => assertReplayIsSafe({ ...base, pools: 0 }), /registry is empty/);
    assert.throws(() => assertReplayIsSafe({ ...base, hasAcceptedObservations: true }), /accepted/);
    assert.throws(() => assertReplayIsSafe({ ...base, hasBucketRows: true }), /accepted/);
  });

  it('resets only after transactional preflight and commits the market cleanup', async () => {
    const statements = [];
    const client = {
      query: async (sql) => {
        statements.push(sql);
        if (sql.includes('AS live_worker')) return { rows: [safeRow()] };
        if (sql.includes('deleted_market_logs')) {
          return { rows: [{ deleted_market_logs: 22632, deleted_market_cursors: 1 }] };
        }
        return { rows: [] };
      },
      release() { statements.push('RELEASE'); },
    };
    const result = await resetMarketReplay({ getClient: async () => client });

    assert.equal(result.replayStartBlock, '9486');
    assert.equal(result.reset.deleted_market_cursors, 1);
    assert.deepEqual(statements.slice(0, 2), ['BEGIN', "SET LOCAL statement_timeout = '30s'"]);
    assert.equal(statements[3].includes('FOR UPDATE'), true);
    assert.equal(statements.some((sql) => sql.includes("stream = 'market' RETURNING 1")), true);
    assert.deepEqual(statements.slice(-2), ['COMMIT', 'RELEASE']);
  });
});
