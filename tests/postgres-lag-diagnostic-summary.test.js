'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { buildReport, parseArgs } = require('../src/utils/summarize-postgres-lag-diagnostics');

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
    assert.equal(report.database.averageWalMBps, 1);
    assert.equal(report.database.topResourceWaits[0].name, 'IO:DataFileRead');
    assert.equal(report.topTablesByWrites[0].writesPerSecond, 1);
    assert.equal(report.topStatementsByExecutionTime[0].query, 'SELECT * FROM queue');
    assert.equal(report.collectionErrors[0].count, 2);
  });
});
