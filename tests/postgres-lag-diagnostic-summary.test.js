'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');
const { buildReport, parseArgs, readDiagnostic } = require(
  '../src/utils/summarize-postgres-lag-diagnostics'
);

describe('PostgreSQL lag diagnostic compact summary', () => {
  it('requires a bounded compact-report request', () => {
    const options = parseArgs(['--input=raw.jsonl', '--top=4'], '/tmp/diagnostic-summary');
    assert.equal(options.input, '/tmp/diagnostic-summary/raw.jsonl');
    assert.equal(options.output, '/tmp/diagnostic-summary/raw.jsonl.summary.json');
    assert.equal(options.top, 4);
    assert.throws(() => parseArgs([]), /--input is required/);
    assert.throws(() => parseArgs(['--input=x', '--top=21']), /between 1 and 20/);
  });

  it('compresses processing, waits, tables, statements, and collection errors', () => {
    const report = buildReport({
      source: '/tmp/raw.jsonl', sampleCount: 2,
      activity: { maxActive: 3, maxBlocked: 1 },
      errors: { 'tables: timeout': 2 },
      summary: {
        startedAt: '2026-09-18T00:00:00.000Z', completedAt: '2026-09-18T00:00:10.000Z',
        samples: 2, sampleErrors: 2, averageWalBytesPerSecond: 1048576,
        walletTransfer: {
          startLagBlocks: 100, endLagBlocks: 80, lagDeltaBlocks: -20,
          phaseMs: { sourceReadMs: { p95: 40 } },
        },
        chainCapture: { capturedBlocks: 10, timingTotals: { commitMs: 200 } },
        processingStart: {
          streams: [{ stream: 'market', safe_head: 100, pending_block: 80,
            active_block: 81, claimable_block: 82, lag_blocks: 21, active_lag_blocks: 20 }],
          telemetry: { totalProcessed: 10, totalRejected: 2 },
        },
        processingEnd: {
          streams: [{ stream: 'market', safe_head: 120, pending_block: 80,
            active_block: 90, claimable_block: 91, lag_blocks: 41, active_lag_blocks: 31 }],
          telemetry: { totalProcessed: 40, totalRejected: 3,
            lastTiming: { claimMs: 12, persistence: { commitMs: 5 } } },
        },
        waitSampleCounts: { 'Client:ClientRead': 20, 'IO:DataFileRead': 4 },
        vacuumSampleCounts: { 'public.queue': 2 },
        topTableWriteDeltas: [{ table: 'queue', inserted: 5, updated: 5,
          deleted: 0, writes: 10, deadTuples: 3 }],
        topStatementDeltas: [{ query: 'SELECT   *\nFROM queue', calls: 2,
          totalExecTimeMs: 100, walBytes: 1048576, sharedBlocksRead: 4 }],
        statementStatsAvailable: true, statementStatsErrors: [],
      },
    }, 1);

    assert.equal(report.processing[0].activeLagDelta, 11);
    assert.equal(report.worker.processedDelta, 30);
    assert.equal(report.walletTransfer.lagDeltaBlocks, -20);
    assert.equal(report.walletTransfer.phaseMs.sourceReadMs.p95, 40);
    assert.equal(report.chainCapture.timingTotals.commitMs, 200);
    assert.equal(report.database.averageWalMBps, 1);
    assert.equal(report.database.walIoTimingEnabled, null);
    assert.equal(report.database.topResourceWaits[0].name, 'IO:DataFileRead');
    assert.equal(report.topTablesByWrites[0].writesPerSecond, 1);
    assert.equal(report.topStatementsByExecutionTime[0].query, 'SELECT * FROM queue');
    assert.equal(report.collectionErrors[0].count, 2);
  });

  it('correlates capture waits with WAL and checkpoint deltas by minute', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'postgres-lag-summary-'));
    const input = path.join(directory, 'diagnostic.jsonl');
    const sample = (sampledAt, wal, checkpoint, head, extra = {}) => ({
      type: 'sample', sampledAt,
      system: { wal: { ...wal, statsReset: wal.reset },
        checkpointer: { buffers_written: checkpoint, write_time: checkpoint * 2,
          sync_time: checkpoint / 2, stats_reset: wal.reset } },
      capture: { checkpoint_block: String(checkpoint), metadata: { nodeHead: head } },
      activity: { waits: [] }, errors: [], ...extra,
    });
    const records = [
      { type: 'metadata', capabilities: { track_wal_io_timing: 'on' } },
      sample('2026-09-29T21:38:55Z', { walBytes: 0, walWrite: 10, walSync: 8,
        walBuffersFull: 1, walWriteTimeMs: 100, walSyncTimeMs: 50, reset: 'a' }, 100, 200),
      sample('2026-09-29T21:39:00Z', { walBytes: 1048576, walWrite: 12, walSync: 9,
        walBuffersFull: 2, walWriteTimeMs: 120, walSyncTimeMs: 55, reset: 'a' }, 105, 210,
      { captureCommit: { waitEventType: 'Lock', waitEvent: 'object', blockers: [
        { waitEventType: 'LWLock', waitEvent: 'WALWrite', blockedByCount: 0 },
      ] }, activity: { waits: [
        { wait_event_type: 'LWLock', wait_event: 'WALWrite', sessions: 3 },
        { wait_event_type: 'IO', wait_event: 'DataFileWrite', sessions: 2 },
      ] } }),
      sample('2026-09-29T21:39:05Z', { walBytes: 3145728, walWrite: 15, walSync: 11,
        walBuffersFull: 2, walWriteTimeMs: 180, walSyncTimeMs: 65, reset: 'a' }, 110, 225,
      { captureCommit: { waitEventType: 'LWLock', waitEvent: 'WALWrite', blockers: [] },
        activity: { waits: [{ wait_event_type: 'LWLock', wait_event: 'WALWrite', sessions: 5 }] } }),
      sample('2026-09-29T21:40:00Z', { walBytes: 4194304, walWrite: 16, walSync: 12,
        walBuffersFull: 3, walWriteTimeMs: 190, walSyncTimeMs: 70, reset: 'b' }, 115, 230),
      { type: 'summary', samples: 4 },
    ];
    try {
      await fs.writeFile(input, records.map((row) => JSON.stringify(row)).join('\n') + '\n');
      const report = buildReport(await readDiagnostic(input));
      const minute = report.database.minuteTimeline[1];
      assert.equal(report.database.walIoTimingEnabled, true);
      assert.equal(minute.minute, '2026-09-29T21:39Z');
      assert.equal(minute.captureCommitSamples, 2);
      assert.deepEqual(minute.captureWaitSamples,
        { 'Lock:object': 1, 'LWLock:WALWrite': 1 });
      assert.deepEqual(minute.rootBlockerWaitSamples, { 'LWLock:WALWrite': 1 });
      assert.equal(minute.lagDeltaBlocks, 15);
      assert.equal(minute.walMB, 3);
      assert.equal(minute.walWrites, 5);
      assert.equal(minute.walWriteTimeMs, 80);
      assert.equal(minute.checkpointBuffersWritten, 10);
      assert.equal(minute.averageWalWriteWaitingSessions, 4);
      assert.equal(minute.averageDataFileWriteWaitingSessions, 1);
      assert.equal(report.database.minuteTimeline[2].walMB, null);
      assert.equal(report.database.minuteTimeline[2].checkpointBuffersWritten, null);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
