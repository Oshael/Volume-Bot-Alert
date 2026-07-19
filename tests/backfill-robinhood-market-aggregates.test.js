const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { __private } = require('../src/utils/backfill-robinhood-market-aggregates');
const { buildTargets, parseCliArgs, runBackfill } = __private;
const TOKEN = '0x1111111111111111111111111111111111111111';
function options(overrides = {}) {
  return {
    mode: 'dry-run', from: null, to: new Date('2026-07-18T13:00:00.000Z'),
    checkpointFile: null, tokenLimit: 25, maxChunks: 1, statementTimeoutMs: 5000,
    sleepMs: 0, fineWindowHours: 1, coarseWindowHours: 24, ...overrides,
  };
}
function fakeDatabase(sourceRows = []) {
  const calls = [];
  return {
    calls,
    async queryWithStatementTimeout(sql, params, timeoutMs) {
      calls.push({ sql, params, timeoutMs });
      if (/MIN\(bucket_ts\)/.test(sql)) {
        return {
          rows: [{
            min_ts: '2026-07-18T12:00:00.000Z',
            max_ts: '2026-07-18T12:59:00.000Z',
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
    assert.throws(
      () => parseCliArgs(['--mode', 'write']),
      /write mode requires --checkpoint/
    );
    assert.equal(parseCliArgs([
      '--mode', 'write', '--checkpoint', './progress.json', '--maxChunks', '7',
    ]).maxChunks, 7);
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
  it('writes a coarse chunk and preserves its resume cursor after success', async () => {
    const database = fakeDatabase([[
      { token_address: TOKEN, bucket_ts: '2026-07-18T12:00:00.000Z' },
    ]]);
    const written = [];
    let saved;
    const checkpoint = {
      version: 1,
      asOf: '2026-07-18T13:00:00.000Z',
      cursor: { phase: 'coarse', windowStart: '2026-07-18T12:00:00.000Z', afterToken: null },
    };
    const summary = await runBackfill(options({ mode: 'write', checkpointFile: '/tmp/rh.json', tokenLimit: 1 }), {
      database,
      repository: { async refreshBucket(target) { written.push(target); return { ...target, updated_at: 'now' }; } },
      readCheckpoint: async () => structuredClone(checkpoint),
      writeCheckpoint: async (_file, value) => { saved = structuredClone(value); },
    });

    assert.equal(summary.written, 3);
    assert.deepEqual(written.map((target) => target.granularityMinutes).sort((a, b) => a - b), [60, 240, 1440]);
    assert.equal(saved.cursor.phase, 'coarse');
    assert.equal(saved.cursor.afterToken, TOKEN);
    assert.equal(summary.nextCursor.afterToken, TOKEN);
  });
});
