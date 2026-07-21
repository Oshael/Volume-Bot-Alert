const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  DERIVED_DATA_CONFIRM_FLAG,
  assertReplayIsSafe,
  inspectMarketReplay,
  main,
  resetMarketReplay,
} = require('../src/utils/reset-robinhood-market-replay');

function safeRow(overrides = {}) {
  return {
    live_worker: false,
    market_next_block: '147178',
    replay_start_block: '9486',
    pools: 3853,
    market_log_rows: '22632',
    observation_rows: '21785',
    accepted_observation_rows: '0',
    minute_bucket_rows: '0',
    hourly_bucket_rows: '0',
    aggregate_bucket_rows: '0',
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
      marketLogRows: '22632',
      observationRows: '21785',
      acceptedObservationRows: '0',
      minuteBucketRows: '0',
      hourlyBucketRows: '0',
      aggregateBucketRows: '0',
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

  it('allows accepted derived data only with the destructive confirmation', () => {
    const plan = {
      liveWorker: false, marketNextBlock: '10', pools: 1,
      hasAcceptedObservations: true, hasBucketRows: true,
    };
    assert.doesNotThrow(() => assertReplayIsSafe(plan, { allowDerivedDataReset: true }));
  });

  it('resets only after transactional preflight and commits the market cleanup', async () => {
    const statements = [];
    const client = {
      query: async (sql) => {
        statements.push(sql);
        if (sql.includes('AS live_worker')) return { rows: [safeRow()] };
        if (sql.includes('deleted_market_logs')) {
          return { rows: [{
            deleted_market_logs: 22632,
            deleted_observations: 21785,
            deleted_market_cursors: 1,
          }] };
        }
        return { rows: [] };
      },
      release() { statements.push('RELEASE'); },
    };
    const result = await resetMarketReplay({ getClient: async () => client });

    assert.equal(result.replayStartBlock, '9486');
    assert.equal(result.reset.deleted_observations, 21785);
    assert.equal(result.reset.deleted_market_cursors, 1);
    assert.deepEqual(statements.slice(0, 2), ['BEGIN', "SET LOCAL statement_timeout = '30s'"]);
    assert.equal(statements[3].includes('FOR UPDATE'), true);
    assert.equal(statements.some((sql) => sql.includes("stream = 'market' RETURNING 1")), true);
    assert.deepEqual(statements.slice(-2), ['COMMIT', 'RELEASE']);
  });

  it('requires the normal confirmation alongside the destructive flag', async () => {
    await assert.rejects(
      main([DERIVED_DATA_CONFIRM_FLAG], {}),
      /requires --confirm-reset-robinhood-market/
    );
  });

  it('passes the destructive confirmation into the transactional preflight', async () => {
    const statements = [];
    const client = {
      query: async (sql) => {
        statements.push(sql);
        if (sql.includes('AS live_worker')) {
          return { rows: [safeRow({
            accepted_observation_rows: '18',
            aggregate_bucket_rows: '14',
          })] };
        }
        if (sql.includes('deleted_market_logs')) {
          return { rows: [{ deleted_market_cursors: 1 }] };
        }
        return { rows: [] };
      },
      release() {},
    };
    const database = { getClient: async () => client };

    const result = await main([
      '--confirm-reset-robinhood-market',
      DERIVED_DATA_CONFIRM_FLAG,
    ], database);

    assert.equal(result.hasAcceptedObservations, true);
    assert.equal(result.hasBucketRows, true);
    assert.equal(statements.includes('COMMIT'), true);
  });
});
