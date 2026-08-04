const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { __private } = require('../src/utils/backfill-robinhood-market-aggregates');
const { buildTargets, parseCliArgs, queryRunner, runBackfill } = __private;
const TOKEN = '0x1111111111111111111111111111111111111111';
const TOKEN_B = '0x2222222222222222222222222222222222222222';
function options(overrides = {}) {
  return {
    mode: 'dry-run', from: null, to: new Date('2026-07-18T13:00:00.000Z'),
    checkpointFile: null, tokenLimit: 25, maxChunks: 1, statementTimeoutMs: 5000,
    lockTimeoutMs: 750,
    sleepMs: 0, fineWindowHours: 1, hourlyWindowHours: 24, coarseWindowHours: 24,
    ...overrides,
  };
}
function fakeDatabase(sourceRows = [], bounds = {}) {
  const calls = [];
  return {
    calls,
    async queryWithStatementTimeout(sql, params, timeoutMs) {
      calls.push({ sql, params, timeoutMs });
      if (/MIN\(bucket_ts\)/.test(sql)) {
        return {
          rows: [{
            min_ts: bounds.min || '2026-07-18T12:00:00.000Z',
            max_ts: bounds.max || '2026-07-18T12:59:00.000Z',
          }],
        };
      }
      return { rows: sourceRows.shift() || [] };
    },
  };
}
describe('Robinhood aggregate backfill', () => {
  it('defaults to a bounded dry-run and requires a checkpoint for writes', () => {
    const parsed = parseCliArgs([]);
    assert.equal(parsed.mode, 'dry-run');
    assert.equal(parsed.maxChunks, 1);
    assert.equal(parsed.tokenLimit, 25);
    assert.equal(parsed.statementTimeoutMs, 10_000);
    assert.equal(parsed.lockTimeoutMs, 1000);
    assert.equal(parsed.hourlyWindowHours, 24);
    assert.throws(
      () => parseCliArgs(['--mode', 'write']),
      /write mode requires --checkpoint/
    );
    assert.equal(parseCliArgs([
      '--mode', 'write', '--checkpoint', './progress.json', '--maxChunks', '7',
    ]).maxChunks, 7);
  });
  it('applies statement and lock timeouts inside each database transaction', async () => {
    const calls = [];
    let released = false;
    const execute = queryRunner({
      async getClient() {
        return {
          async query(sql, params) {
            calls.push({ sql, params });
            return { rows: [{ ok: true }] };
          },
          release() { released = true; },
        };
      },
    }, 5000, 750);

    const result = await execute('SELECT $1::int AS ok', [1]);

    assert.deepEqual(result.rows, [{ ok: true }]);
    assert.deepEqual(calls.map((call) => call.sql), [
      'BEGIN',
      "SET LOCAL statement_timeout = '5000ms'",
      "SET LOCAL lock_timeout = '750ms'",
      'SELECT $1::int AS ok',
      'COMMIT',
    ]);
    assert.deepEqual(calls[3].params, [1]);
    assert.equal(released, true);
  });
  it('derives fine and permanent parent buckets without duplicate targets', () => {
    const rows = [
      { token_address: TOKEN, bucket_ts: '2026-07-18T12:01:00.000Z' },
      { token_address: TOKEN, bucket_ts: '2026-07-18T12:04:00.000Z' },
    ];
    assert.deepEqual(buildTargets(rows, 'fine').map((target) => (
      [target.granularityMinutes, target.bucketTs]
    )), [
      [5, '2026-07-18T12:00:00.000Z'],
      [15, '2026-07-18T12:00:00.000Z'],
      [30, '2026-07-18T12:00:00.000Z'],
    ]);
    assert.deepEqual(buildTargets(rows, 'coarse').map((target) => target.granularityMinutes).sort((a, b) => a - b), [
      60, 240, 1440,
    ]);
  });
  it('scans one bounded token/time chunk in dry-run without writing aggregates', async () => {
    const database = fakeDatabase([[
      { token_address: TOKEN, bucket_ts: '2026-07-18T12:01:00.000Z' },
      { token_address: TOKEN, bucket_ts: '2026-07-18T12:04:00.000Z' },
    ]]);
    const writes = [];
    const checkpoints = [];
    const summary = await runBackfill(options(), {
      database,
      repository: { async refreshBucket(target) { writes.push(target); } },
      readCheckpoint: async () => null,
      writeCheckpoint: async (_file, checkpoint) => checkpoints.push(structuredClone(checkpoint)),
    });

    assert.equal(summary.scanned, 2);
    assert.equal(summary.skipped, 3);
    assert.equal(summary.written, 0);
    assert.equal(summary.chunks, 1);
    assert.equal(writes.length, 0);
    assert.equal(checkpoints.at(-1).cursor.windowStart, '2026-07-18T13:00:00.000Z');
    assert.ok(database.calls.every((call) => call.timeoutMs === 5000));
    assert.match(database.calls.at(-1).sql, /candidate_tokens[\s\S]*LIMIT \$4/);
  });
  it('starts fine aggregation at the oldest available 1m source bucket', async () => {
    const oldest = '2025-01-01T00:00:00.000Z';
    const database = fakeDatabase([[]], {
      min: oldest,
      max: '2026-07-18T12:59:00.000Z',
    });

    await runBackfill(options(), {
      database,
      readCheckpoint: async () => null,
      writeCheckpoint: async () => {},
    });

    const sourceCall = database.calls.find((call) => /candidate_tokens/.test(call.sql));
    assert.equal(sourceCall.params[0], oldest);
  });
  it('rejects checkpoints created with the former 14-day fine-history scope', async () => {
    await assert.rejects(
      runBackfill(options(), {
        database: fakeDatabase(),
        readCheckpoint: async () => ({
          version: 1,
          asOf: '2026-07-18T13:00:00.000Z',
          cursor: { phase: 'fine', windowStart: null, afterToken: null },
        }),
      }),
      /checkpoint is incompatible/
    );
  });
  it('paginates a coarse set-based window and resumes at the next window', async () => {
    const database = fakeDatabase();
    const written = [];
    let saved;
    const times = [1000, 1010, 1010, 1025];
    const checkpoint = {
      version: 2,
      asOf: '2026-07-18T13:00:00.000Z',
      cursor: { phase: 'coarse', windowStart: '2026-07-18T12:00:00.000Z', afterToken: TOKEN },
    };
    const summary = await runBackfill(options({
      mode: 'write',
      checkpointFile: '/tmp/rh.json',
      tokenLimit: 1,
      maxChunks: 2,
    }), {
      database,
      repository: {
        async refreshAggregateRange(range) {
          written.push(range);
          return written.length === 1
            ? {
              sourceBuckets: 1,
              targetBuckets: 3,
              writtenBuckets: 3,
              lastToken: TOKEN_B,
              hasMoreTokens: true,
            }
            : {
              sourceBuckets: 1,
              targetBuckets: 3,
              writtenBuckets: 2,
              lastToken: null,
              hasMoreTokens: false,
            };
        },
      },
      now: () => times.shift(),
      readCheckpoint: async () => structuredClone(checkpoint),
      writeCheckpoint: async (_file, value) => { saved = structuredClone(value); },
    });

    assert.equal(summary.scanned, 2);
    assert.equal(summary.written, 5);
    assert.equal(summary.aggregateWindows, 2);
    assert.deepEqual(written, [
      {
        from: '2026-07-18T12:00:00.000Z',
        to: '2026-07-18T13:00:00.000Z',
        granularities: [60, 240, 1440],
        afterToken: TOKEN,
        tokenLimit: 1,
      },
      {
        from: '2026-07-18T12:00:00.000Z',
        to: '2026-07-18T13:00:00.000Z',
        granularities: [60, 240, 1440],
        afterToken: TOKEN_B,
        tokenLimit: 1,
      },
    ]);
    assert.equal(saved.cursor.phase, 'coarse');
    assert.equal(saved.cursor.windowStart, '2026-07-18T13:00:00.000Z');
    assert.equal(saved.cursor.afterToken, null);
    assert.equal(summary.totalBatchDurationMs, 25);
    assert.equal(summary.maxBatchDurationMs, 15);
    assert.deepEqual(summary.lastBatch, {
      phase: 'coarse',
      windowStart: '2026-07-18T12:00:00.000Z',
      afterToken: TOKEN_B,
      sourceBuckets: 1,
      writtenBuckets: 2,
      durationMs: 15,
    });
    assert.equal(database.calls.some((call) => /candidate_tokens/.test(call.sql)), false);
  });

  it('does not advance the checkpoint when a set-based window fails', async () => {
    const checkpoint = {
      version: 2,
      asOf: '2026-07-18T13:00:00.000Z',
      cursor: { phase: 'coarse', windowStart: '2026-07-18T12:00:00.000Z', afterToken: null },
    };
    const saved = [];
    await assert.rejects(
      runBackfill(options({ mode: 'write', checkpointFile: '/tmp/rh.json' }), {
        database: fakeDatabase(),
        repository: {
          async refreshAggregateRange() { throw new Error('set-based write failed'); },
        },
        readCheckpoint: async () => structuredClone(checkpoint),
        writeCheckpoint: async (_file, value) => saved.push(structuredClone(value)),
      }),
      (error) => {
        assert.equal(error.message, 'set-based write failed');
        assert.equal(error.summary.failed, 1);
        return true;
      }
    );
    assert.equal(saved.length, 0);
  });

  it('rebuilds each closed hourly window with one set-based repository call', async () => {
    const database = fakeDatabase([], {
      min: '2026-07-18T12:17:00.000Z',
      max: '2026-07-18T14:42:00.000Z',
    });
    const ranges = [];
    let saved;
    const checkpoint = {
      version: 2,
      asOf: '2026-07-18T14:30:00.000Z',
      cursor: { phase: 'hourly', windowStart: null, afterToken: null },
    };
    const summary = await runBackfill(options({
      mode: 'write',
      checkpointFile: '/tmp/rh.json',
      hourlyWindowHours: 1,
    }), {
      database,
      repository: {
        async refreshHourlyRange(range) {
          ranges.push(range);
          return {
            sourceBuckets: 8,
            writtenBuckets: 6,
            lastToken: TOKEN,
            hasMoreTokens: true,
          };
        },
      },
      readCheckpoint: async () => structuredClone(checkpoint),
      writeCheckpoint: async (_file, value) => { saved = structuredClone(value); },
    });

    assert.deepEqual(ranges, [{
      from: '2026-07-18T12:00:00.000Z',
      to: '2026-07-18T13:00:00.000Z',
      afterToken: null,
      tokenLimit: 25,
    }]);
    assert.equal(summary.hourlyWindows, 1);
    assert.equal(summary.hourlySourceBuckets, 8);
    assert.equal(summary.hourlyWrittenBuckets, 6);
    assert.equal(saved.cursor.phase, 'hourly');
    assert.equal(saved.cursor.windowStart, '2026-07-18T12:00:00.000Z');
    assert.equal(saved.cursor.afterToken, TOKEN);
  });

  it('refreshes coarse source bounds after rebuilding older hourly buckets', async () => {
    let hourlyBoundsReads = 0;
    const database = {
      async queryWithStatementTimeout(sql) {
        if (!/MIN\(bucket_ts\)/.test(sql)) return { rows: [] };
        if (/robinhood_market_buckets_1h/.test(sql)) {
          hourlyBoundsReads += 1;
          return { rows: [{
            min_ts: hourlyBoundsReads === 1
              ? '2026-07-10T00:00:00.000Z'
              : '2026-07-01T00:00:00.000Z',
            max_ts: '2026-07-18T12:00:00.000Z',
          }] };
        }
        return { rows: [{
          min_ts: '2026-07-18T12:00:00.000Z',
          max_ts: '2026-07-18T12:59:00.000Z',
        }] };
      },
    };
    const ranges = [];
    const checkpoint = {
      version: 2,
      asOf: '2026-07-18T13:00:00.000Z',
      cursor: { phase: 'hourly', windowStart: '2026-07-18T13:00:00.000Z', afterToken: null },
    };

    await runBackfill(options({
      mode: 'write', checkpointFile: '/tmp/rh.json', maxChunks: 1,
    }), {
      database,
      repository: {
        async refreshAggregateRange(range) {
          ranges.push(range);
          return {
            sourceBuckets: 1, targetBuckets: 3, writtenBuckets: 3,
            lastToken: TOKEN, hasMoreTokens: false,
          };
        },
      },
      readCheckpoint: async () => structuredClone(checkpoint),
      writeCheckpoint: async () => {},
    });

    assert.equal(hourlyBoundsReads, 2);
    assert.equal(ranges.length, 1);
    assert.equal(ranges[0].from, '2026-07-01T00:00:00.000Z');
  });
});
