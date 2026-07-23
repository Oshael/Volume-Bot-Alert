const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const audit = require('../src/utils/audit-robinhood-market-aggregate-coverage');
const {
  buildAggregateAuditSql, buildHourlyAuditSql, defaultBounds, parseCliArgs,
} = audit.__private;

const TOKEN_A = '0x1111111111111111111111111111111111111111';
const TOKEN_B = '0x2222222222222222222222222222222222222222';

function options(overrides = {}) {
  return {
    from: '2026-07-20T00:00:00.000Z',
    to: '2026-07-23T00:00:00.000Z',
    afterToken: null,
    tokenLimit: 1,
    statementTimeoutMs: 5000,
    ...overrides,
  };
}

describe('Robinhood aggregate coverage auditor', () => {
  it('defaults to the last three closed UTC days and validates bounded pages', () => {
    assert.deepEqual(defaultBounds(new Date('2026-07-23T15:00:00.000Z')), {
      from: '2026-07-20T00:00:00.000Z',
      to: '2026-07-23T00:00:00.000Z',
    });
    assert.deepEqual(parseCliArgs([], new Date('2026-07-23T15:00:00.000Z')), options({
      tokenLimit: 25,
      statementTimeoutMs: 10_000,
    }));
    assert.throws(
      () => parseCliArgs(['--from', '2026-07-20T01:00:00Z']),
      /aligned to UTC days/
    );
    assert.throws(() => parseCliArgs(['--token-limit', '251']), /between 1 and 250/);
  });

  it('recomputes hourly and aggregate contracts without writing', () => {
    const hourly = buildHourlyAuditSql();
    const fine = buildAggregateAuditSql(5);
    const coarse = buildAggregateAuditSql(240);

    assert.match(hourly, /FROM robinhood_market_buckets_1m minute/);
    assert.match(hourly, /FULL JOIN actual/);
    assert.match(hourly, /source_minute_buckets/);
    assert.match(fine, /FROM robinhood_market_buckets_1m bucket/);
    assert.match(fine, /COUNT\(DISTINCT \(bucket\.protocol, bucket\.market_key\)\)/);
    assert.match(fine, /bucket\.protocol::text/);
    assert.match(coarse, /FROM robinhood_market_buckets_1h bucket/);
    assert.match(coarse, /240::smallint\s+AS granularity_minutes/);
    assert.doesNotMatch(`${hourly}${fine}${coarse}`, /\b(?:INSERT|UPDATE|DELETE)\b/);
  });

  it('reports the minimum proven watermark and a resumable token cursor', async () => {
    const calls = [];
    const database = {
      async queryWithStatementTimeout(sql, params, timeoutMs) {
        calls.push({ sql, params, timeoutMs });
        if (calls.length === 1) {
          return { rows: [{ token_address: TOKEN_A }, { token_address: TOKEN_B }] };
        }
        const granularity = calls.length === 2 ? 60 : [5, 15, 30, 60, 240, 1440][calls.length - 3];
        const divergent = granularity === 30;
        return { rows: [{
          token_address: TOKEN_A,
          matched_buckets: divergent ? 2 : 3,
          missing_buckets: divergent ? 1 : 0,
          orphan_buckets: 0,
          divergent_buckets: 0,
          first_mismatch_at: divergent ? '2026-07-21T00:00:00.000Z' : null,
          watermark: divergent
            ? '2026-07-21T00:00:00.000Z' : '2026-07-23T00:00:00.000Z',
        }] };
      },
    };

    const report = await audit.runAudit(options(), { database });

    assert.equal(report.tokens, 1);
    assert.equal(report.nextAfterToken, TOKEN_A);
    assert.equal(report.pageComplete, false);
    assert.equal(report.pageWatermark, '2026-07-21T00:00:00.000Z');
    assert.equal(report.results.length, 7);
    assert.equal(report.results.find((row) => (
      row.level === 'aggregate' && row.granularityMinutes === 30
    )).missingBuckets, 1);
    assert.ok(calls.every((call) => call.timeoutMs === 5000));
    assert.deepEqual(calls[1].params, [[TOKEN_A], options().from, options().to]);
  });
});
