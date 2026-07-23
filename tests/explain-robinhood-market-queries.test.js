const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const collector = require('../src/utils/explain-robinhood-market-queries');
const {
  buildPlanSpecs, explainSql, parseCliArgs,
} = collector.__private;

const TOKEN = '0x1111111111111111111111111111111111111111';

function options(overrides = {}) {
  return {
    mode: 'plan',
    token: TOKEN,
    from: '2026-07-20T00:00:00.000Z',
    to: '2026-07-23T00:00:00.000Z',
    tokenLimit: 25,
    statementTimeoutMs: 30_000,
    lockTimeoutMs: 1000,
    only: null,
    output: null,
    ...overrides,
  };
}

function fakeDatabase() {
  const calls = [];
  return {
    calls,
    async getClient() {
      return {
        async query(sql) {
          calls.push(sql);
          if (/pg_stat_user_tables/.test(sql)) {
            return { rows: [{ relname: 'robinhood_market_buckets_1m' }] };
          }
          if (/^EXPLAIN/.test(sql)) {
            return { rows: [{ 'QUERY PLAN': [{ Plan: { 'Node Type': 'Result' } }] }] };
          }
          return { rows: [] };
        },
        release() {},
      };
    },
  };
}

describe('Robinhood EXPLAIN collector', () => {
  it('defaults to a non-executing three-day plan and validates controls', () => {
    assert.deepEqual(
      parseCliArgs([], new Date('2026-07-23T15:00:00.000Z')),
      options({ token: null })
    );
    assert.throws(() => parseCliArgs(['--mode', 'unsafe']), /plan or analyze/);
    assert.throws(
      () => parseCliArgs(['--from', '2026-07-20T01:00:00Z']),
      /align to UTC days/
    );
    assert.throws(() => parseCliArgs(['--token', 'bad']), /token is invalid/);
  });

  it('covers write, audit, history, and retention plans with real repository SQL', async () => {
    const specs = await buildPlanSpecs(options(), TOKEN);
    const byName = new Map(specs.map((spec) => [spec.name, spec]));

    assert.equal(specs.length, 12);
    assert.match(byName.get('backfill-hourly-upsert').sql, /INSERT INTO/);
    assert.match(byName.get('backfill-fine-upsert').sql, /robinhood_market_buckets_1m/);
    assert.match(byName.get('backfill-coarse-upsert').sql, /robinhood_market_buckets_1h/);
    assert.match(byName.get('audit-hourly').sql, /FULL JOIN actual/);
    assert.match(byName.get('history-legacy-5m').sql, /robinhood_market_buckets_1m/);
    assert.match(byName.get('retention-delete-1m').sql, /DELETE FROM/);
    assert.equal(byName.get('retention-delete-1m').readOnly, false);
  });

  it('never adds ANALYZE to mutating statements', () => {
    const write = { readOnly: false, sql: 'DELETE FROM example' };
    const read = { readOnly: true, sql: 'SELECT 1' };

    assert.doesNotMatch(explainSql(write, 'plan'), /ANALYZE/);
    assert.match(explainSql(read, 'analyze'), /ANALYZE, BUFFERS, WAL/);
  });

  it('skips writes in analyze mode and executes read plans sequentially', async () => {
    const database = fakeDatabase();
    const report = await collector.runCollector(options({
      mode: 'analyze',
      only: new Set(['backfill-hourly-upsert', 'audit-token-page']),
    }), { database });

    assert.deepEqual(report.plans.map((plan) => [plan.name, plan.status]), [
      ['backfill-hourly-upsert', 'skipped'],
      ['audit-token-page', 'ok'],
    ]);
    assert.equal(database.calls.some((sql) => (
      /^EXPLAIN.*ANALYZE[\s\S]*(?:INSERT|UPDATE|DELETE)/.test(sql)
    )), false);
    assert.equal(database.calls.filter((sql) => /^EXPLAIN/.test(sql)).length, 1);
  });
});
