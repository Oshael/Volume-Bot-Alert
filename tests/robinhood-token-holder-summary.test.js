const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const stage111 = require('../src/utils/db-init-stage111');
const stage112 = require('../src/utils/db-init-stage112');
const stage140 = require('../src/utils/db-init-stage140');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');
const {
  createRobinhoodTokenHolderSummaryRepository,
  __private,
} = require('../src/models/robinhood-token-holder-summary');

const TOKEN = `0x${'a'.repeat(40)}`;
const OBSERVED_AT = '2026-08-10T02:00:00.000Z';

function databaseReturning(overrides = {}) {
  const calls = [];
  const row = {
    token_address: TOKEN,
    holder_count: '4424',
    source: 'blockscout',
    observed_at: OBSERVED_AT,
    checked_at: '2026-08-10T02:00:01.000Z',
    last_error_code: null,
    consecutive_failures: 0,
    retry_after_at: null,
    ...overrides,
  };
  return {
    calls,
    database: {
      query: async (sql, params) => {
        calls.push({ sql, params });
        return { rows: [row], rowCount: 1 };
      },
    },
  };
}

describe('Robinhood token holder summaries', () => {
  it('registers an additive summary table in the runtime schema guard', () => {
    const sql = stage111.STATEMENTS.join('\n');
    const group = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage111-robinhood-token-holder-summaries'
    ));

    assert.match(sql, /CREATE TABLE IF NOT EXISTS robinhood_token_holder_summaries/);
    assert.match(sql, /holder_count IS NULL OR holder_count >= 0/);
    assert.match(sql, /PRIMARY KEY \(chain, token_address\)/);
    assert.match(sql, /retry_after_at ASC NULLS FIRST/);
    assert.doesNotMatch(sql, /DROP\s+(?:TABLE|COLUMN|CONSTRAINT|INDEX)/i);
    assert.equal(group.repair, 'node src/utils/db-init-stage111.js');
    assert.equal(group.tables[0].columnTypes.holder_count.dataType, 'bigint');

    const historySql = stage112.STATEMENTS.join('\n');
    const historyGroup = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage112-robinhood-token-holder-daily-snapshots'
    ));
    assert.match(historySql, /CREATE TABLE IF NOT EXISTS robinhood_token_holder_daily_snapshots/);
    assert.match(historySql, /PRIMARY KEY \(chain, token_address, snapshot_date\)/);
    assert.match(historySql, /holder_count >= 0/);
    assert.doesNotMatch(historySql, /DROP\s+(?:TABLE|COLUMN|CONSTRAINT|INDEX)/i);
    assert.equal(historyGroup.repair, 'node src/utils/db-init-stage112.js');
    assert.equal(historyGroup.tables[0].columnTypes.snapshot_date.dataType, 'date');

    const bucketSql = stage140.STATEMENTS.join('\n');
    const bucketGroup = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage140-robinhood-token-holder-buckets'
    ));
    assert.match(bucketSql, /CREATE TABLE IF NOT EXISTS robinhood_token_holder_buckets/);
    assert.match(bucketSql, /PRIMARY KEY \(chain, token_address, bucket_start\)/);
    assert.match(bucketSql, /date_trunc\('hour',[\s\S]*AT TIME ZONE 'UTC'/);
    assert.match(bucketSql, /source IN \('blockscout', 'ledger_live'\)/);
    assert.doesNotMatch(bucketSql, /CREATE INDEX/i);
    assert.equal(bucketGroup.repair, 'node src/utils/db-init-stage140.js');
    assert.equal(bucketGroup.tables[0].columnTypes.bucket_start.dataType,
      'timestamp with time zone');
  });

  it('upserts success without allowing an older observation to replace a newer one', async () => {
    const fake = databaseReturning();
    const repository = createRobinhoodTokenHolderSummaryRepository(fake);

    const summary = await repository.recordSuccess({
      tokenAddress: TOKEN.toUpperCase(), holderCount: 4424, observedAt: OBSERVED_AT,
    });

    assert.equal(summary.holderCount, 4424);
    assert.equal(summary.observedAt, OBSERVED_AT);
    assert.deepEqual(fake.calls[0].params, [TOKEN, '4424', OBSERVED_AT]);
    assert.match(fake.calls[0].sql, /EXCLUDED\.observed_at >= robinhood_token_holder_summaries\.observed_at/);
    assert.match(fake.calls[0].sql, /THEN EXCLUDED\.holder_count ELSE robinhood_token_holder_summaries\.holder_count/);
    assert.match(fake.calls[0].sql, /GREATEST\([\s\S]*observed_at/);
    assert.match(fake.calls[0].sql, /INSERT INTO robinhood_token_holder_daily_snapshots/);
    assert.match(fake.calls[0].sql, /ON CONFLICT \(chain, token_address, snapshot_date\)/);
    assert.match(fake.calls[0].sql, /WHERE observed_at = \$3::timestamptz/);
    assert.match(fake.calls[0].sql, /source <> 'ledger_live'/);
    assert.match(fake.calls[0].sql, /INSERT INTO robinhood_token_holder_buckets/);
    assert.match(fake.calls[0].sql,
      /date_trunc\('hour', \$3::timestamptz AT TIME ZONE 'UTC'\)/);
    assert.match(fake.calls[0].sql,
      /robinhood_token_holder_buckets\.source = EXCLUDED\.source/);
  });

  it('records failures without overwriting the last valid count or observation', async () => {
    const fake = databaseReturning({
      last_error_code: 'rate_limited',
      consecutive_failures: 3,
      retry_after_at: '2026-08-10T02:01:00.000Z',
    });
    const repository = createRobinhoodTokenHolderSummaryRepository(fake);
    const summary = await repository.recordFailure({
      tokenAddress: TOKEN,
      errorCode: 'RATE_LIMITED',
      retryAfterAt: '2026-08-10T02:01:00.000Z',
    });

    assert.equal(summary.holderCount, 4424);
    assert.equal(summary.lastErrorCode, 'rate_limited');
    assert.equal(summary.consecutiveFailures, 3);
    assert.deepEqual(fake.calls[0].params, [
      TOKEN, 'rate_limited', '2026-08-10T02:01:00.000Z',
    ]);
    const updateClause = fake.calls[0].sql.split('DO UPDATE SET')[1];
    assert.doesNotMatch(updateClause, /holder_count\s*=/);
    assert.doesNotMatch(updateClause, /observed_at\s*=/);
  });

  it('reads normalized summaries in one bounded address query', async () => {
    const fake = databaseReturning();
    const repository = createRobinhoodTokenHolderSummaryRepository(fake);
    const summaries = await repository.getSummaries([TOKEN.toUpperCase(), TOKEN]);

    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].tokenAddress, TOKEN);
    assert.deepEqual(fake.calls[0].params, [[TOKEN]]);
    assert.match(fake.calls[0].sql, /token_address = ANY\(\$1::varchar\[\]\)/);
    assert.deepEqual(await repository.getSummaries([]), []);
    assert.equal(fake.calls.length, 1);
  });

  it('reads live-first published summaries without changing the raw cache reader', async () => {
    const fake = databaseReturning({ source: 'ledger_live' });
    const repository = createRobinhoodTokenHolderSummaryRepository(fake);
    const summaries = await repository.getPublishedSummaries([TOKEN]);

    assert.equal(summaries[0].source, 'ledger_live');
    assert.match(fake.calls[0].sql, /FROM robinhood_published_holder_summaries/);
    assert.deepEqual(await repository.getPublishedSummaries([]), []);
    assert.equal(fake.calls.length, 1);
  });

  it('projects bounded live counts into the UTC daily snapshot with live precedence', async () => {
    const calls = [];
    const repository = createRobinhoodTokenHolderSummaryRepository({ database: {
      async query(sql, params) {
        calls.push({ sql, params });
        return { rows: [{ saved_count: 2 }] };
      },
    } });
    const result = await repository.syncLiveDailySnapshots({
      asOf: '2026-08-10T23:59:00.000Z', limit: 250,
    });

    assert.deepEqual(result, { savedCount: 2, asOf: '2026-08-10T23:59:00.000Z' });
    assert.deepEqual(calls[0].params, ['2026-08-10T23:59:00.000Z', 250]);
    assert.match(calls[0].sql, /published\.source = 'ledger_live'/);
    assert.match(calls[0].sql, /snapshot_date = \(\$1::timestamptz AT TIME ZONE 'UTC'\)::date/);
    assert.match(calls[0].sql, /snapshot\.source <> 'ledger_live'/);
    assert.match(calls[0].sql, /LIMIT \$2::int/);
    assert.match(calls[0].sql, /source = EXCLUDED\.source/);
    assert.match(calls[0].sql, /published\.observed_at <= \$1::timestamptz/);
    assert.match(calls[0].sql, /holder_bucket\.observed_at < published\.observed_at/);
    assert.match(calls[0].sql, /INSERT INTO robinhood_token_holder_buckets/);
    assert.match(calls[0].sql,
      /date_trunc\('hour', observed_at AT TIME ZONE 'UTC'\)/);
  });

  it('rejects an unbounded live snapshot batch before querying', async () => {
    const fake = databaseReturning();
    const repository = createRobinhoodTokenHolderSummaryRepository(fake);

    await assert.rejects(repository.syncLiveDailySnapshots({ limit: 5001 }), /between 1 and 5000/);
    assert.equal(fake.calls.length, 0);
  });

  it('reads one baseline plus the requested daily range in chronological order', async () => {
    const calls = [];
    const repository = createRobinhoodTokenHolderSummaryRepository({
      database: { async query(sql, params) {
        calls.push({ sql, params });
        return { rows: [{
          snapshot_date: '2026-08-09', holder_count: '4300',
          observed_at: '2026-08-09T23:00:00.000Z',
        }] };
      } },
    });
    const rows = await repository.listDailySnapshots({
      tokenAddress: TOKEN, days: 30, asOf: '2026-08-10T05:00:00.000Z',
    });

    assert.deepEqual(rows, [{
      date: '2026-08-09', holderCount: 4300, observedAt: '2026-08-09T23:00:00.000Z',
    }]);
    assert.deepEqual(calls[0].params, [TOKEN, '2026-08-10T05:00:00.000Z', 31]);
    assert.match(calls[0].sql, /ORDER BY snapshot_date DESC/);
    assert.match(calls[0].sql, /ORDER BY snapshot_date ASC/);
  });

  it('selects due hot tokens before cold backfill candidates', async () => {
    const fake = databaseReturning({ priority: 'hot', consecutive_failures: 2 });
    const repository = createRobinhoodTokenHolderSummaryRepository(fake);
    const candidates = await repository.listRefreshCandidates({
      asOf: '2026-08-10T04:00:00.000Z',
      hotWindowMs: 3_600_000,
      hotRefreshMs: 300_000,
      coldRefreshMs: 21_600_000,
      limit: 20,
      coldQuota: 5,
    });

    assert.deepEqual(candidates, [{
      tokenAddress: TOKEN, priority: 'hot', consecutiveFailures: 2,
    }]);
    assert.deepEqual(fake.calls[0].params, [
      '2026-08-10T04:00:00.000Z',
      '2026-08-10T03:00:00.000Z',
      '2026-08-10T03:55:00.000Z',
      '2026-08-09T22:00:00.000Z',
      20,
      5,
    ]);
    assert.match(fake.calls[0].sql, /summary\.retry_after_at IS NULL/);
    assert.match(fake.calls[0].sql, /ROW_NUMBER\(\) OVER/);
    assert.match(fake.calls[0].sql, /priority_rank::numeric \/ \$6::int/);
  });

  it('rejects unsafe counts, invalid errors and oversized batches before querying', async () => {
    const repository = createRobinhoodTokenHolderSummaryRepository(databaseReturning());
    await assert.rejects(
      repository.recordSuccess({
        tokenAddress: TOKEN, holderCount: '9007199254740992', observedAt: OBSERVED_AT,
      }),
      /safe integer/
    );
    await assert.rejects(
      repository.recordFailure({ tokenAddress: TOKEN, errorCode: 'bad error!' }),
      /errorCode/
    );
    assert.throws(() => __private.addressBatch(Array(501).fill(TOKEN)), /exceeds 500/);
  });
});
