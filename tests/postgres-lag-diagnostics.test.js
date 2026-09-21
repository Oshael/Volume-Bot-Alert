'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  nonnegativeDelta, parseArgs, processingSql, sampleRates, statementDeltas, summarize, tableDeltas,
} = require('../src/utils/collect-postgres-lag-diagnostics');

function sample(at, overrides = {}) {
  return {
    sampledAt: at,
    system: { wal: { walBytes: '1000' }, database: { xactCommit: '10' } },
    activity: { waits: [] }, vacuums: [], errors: [],
    processing: { streams: [{ stream: 'market', lag_blocks: 10 }] },
    tables: [], rates: {}, ...overrides,
  };
}

describe('PostgreSQL lag diagnostics', () => {
  it('parses bounded duration, interval, and output', () => {
    const result = parseArgs([
      '--duration=2h', '--interval=10s', '--output=result.jsonl',
    ], '/tmp/diagnostic-test');

    assert.equal(result.durationMs, 7_200_000);
    assert.equal(result.intervalMs, 10_000);
    assert.equal(result.output, '/tmp/diagnostic-test/result.jsonl');
    assert.throws(() => parseArgs(['--duration=10s']), /between 30s and 24h/);
    assert.throws(() => parseArgs(['--duration=5m', '--interval=1s']), /between 2s and 60s/);
    assert.throws(() => parseArgs(['--wat=1m']), /unknown argument/);
  });

  it('computes interval rates and treats statistics reset as unknown', () => {
    const first = sample('2026-09-17T10:00:00.000Z');
    const second = sample('2026-09-17T10:00:10.000Z', {
      system: { wal: { walBytes: '21000' }, database: { xactCommit: '60' } },
    });

    assert.deepEqual(sampleRates(first, second), {
      intervalSeconds: 10, walBytesPerSecond: 2000, transactionsPerSecond: 5,
    });
    assert.equal(nonnegativeDelta('20', '5'), null);
  });

  it('ranks statement and table deltas inside the observed window', () => {
    const statements = statementDeltas(
      { rows: [{ queryid: '1', calls: 2, total_exec_time: 10, wal_bytes: 100 }] },
      { rows: [
        { queryid: '1', query: 'UPDATE a', calls: 5, total_exec_time: 40, wal_bytes: 300 },
        { queryid: '2', query: 'SELECT b', calls: 1, total_exec_time: 50, wal_bytes: 0 },
      ] }
    );
    assert.deepEqual(statements.map(({ queryId, totalExecTimeMs }) => (
      [queryId, totalExecTimeMs]
    )), [['2', 50], ['1', 30]]);

    const tables = tableDeltas(
      [{ relname: 'a', n_tup_ins: '10', n_tup_upd: '20', n_tup_del: '5' }],
      [{ relname: 'a', n_tup_ins: '20', n_tup_upd: '50', n_tup_del: '7', n_dead_tup: '8' }]
    );
    assert.deepEqual(tables[0], {
      table: 'a', inserted: 10, updated: 30, deleted: 2, writes: 42, deadTuples: 8,
    });
  });

  it('summarizes simultaneous waits, vacuums, WAL, and processing endpoints', () => {
    const first = sample('2026-09-17T10:00:00.000Z', {
      activity: { waits: [{ wait_event_type: 'IO', wait_event: 'DataFileRead', sessions: 2 }] },
      vacuums: [{ relation: 'public.queue' }], tables: [],
    });
    const last = sample('2026-09-17T10:00:10.000Z', {
      rates: { walBytesPerSecond: 1024 },
      processing: { streams: [{ stream: 'market', lag_blocks: 20 }] },
      activity: { waits: [{ wait_event_type: 'IO', wait_event: 'DataFileRead', sessions: 1 }] },
      vacuums: [{ relation: 'public.queue' }], tables: [],
    });
    const emptyStatements = { available: false, rows: [] };
    const result = summarize([first, last], emptyStatements, emptyStatements);

    assert.equal(result.averageWalBytesPerSecond, 1024);
    assert.equal(result.waitSampleCounts['IO:DataFileRead'], 3);
    assert.equal(result.vacuumSampleCounts['public.queue'], 2);
    assert.equal(result.processingStart.streams[0].lag_blocks, 10);
    assert.equal(result.processingEnd.streams[0].lag_blocks, 20);
  });

  it('summarizes distinct wallet-transfer phase and catch-up samples', () => {
    const worker = (sampledAt, lagBlocks, sourceMs, netRate) => ({
      walletTransfer: { lagBlocks, telemetry: {
        lastCompletedAt: sampledAt,
        lastResult: {
          timing: { sourceReadMs: sourceMs, totalMs: sourceMs + 10,
            processedBlocksPerSecond: 5 },
          progress: { sampledAt, sourceBlocksPerSecond: 2,
            cursorBlocksPerSecond: 2 + netRate, netCatchupBlocksPerSecond: netRate },
        },
      } },
    });
    const samples = [
      sample('2026-09-17T10:00:00.000Z', {
        processing: worker('2026-09-17T10:00:00.000Z', '100', 20, 1),
      }),
      sample('2026-09-17T10:00:05.000Z', {
        processing: worker('2026-09-17T10:00:00.000Z', '90', 20, 1),
      }),
      sample('2026-09-17T10:00:10.000Z', {
        processing: worker('2026-09-17T10:00:10.000Z', '80', 40, 3),
      }),
    ];
    const emptyStatements = { available: false, rows: [] };
    const result = summarize(samples, emptyStatements, emptyStatements).walletTransfer;

    assert.equal(result.lagDeltaBlocks, -20);
    assert.equal(result.distinctResults, 2);
    assert.deepEqual(result.phaseMs.sourceReadMs, {
      average: 30, p50: 20, p95: 40, max: 40,
    });
    assert.equal(result.netCatchupBlocksPerSecond.average, 2);
  });

  it('measures reported, active, and immediately claimable processing frontiers', () => {
    const sql = processingSql('state');
    assert.match(sql, /processing_status IN \('pending','leased','blocked'\)/);
    assert.match(sql, /processing_status IN \('pending','leased'\)/);
    assert.match(sql, /processing_status='pending' AND item\.next_attempt_at <= NOW\(\)/);
    assert.match(sql, /active_lag_blocks/);
    assert.match(sql, /robinhood_wallet_transfer_cursors/);
    assert.match(sql, /robinhood-wallet-transfer-live-worker/);
    assert.match(sql, /'walletTransfer'/);
  });
});
