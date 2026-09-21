'use strict';

process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  loadSnapshot, main, parseArgs, probeRpc, selectProbeBlocks, summarize,
} = require('../src/utils/audit-robinhood-deployment-live-window');

const HASH = `0x${'a'.repeat(64)}`;

function snapshot(overrides = {}) {
  return {
    sampledAt: '2026-09-20T12:00:00.000Z', items: 100, archiveRequired: 2,
    leased: 1, dueNow: 90,
    older48h: 10, older72h: 2, expiringNextHour: 3, agedOutDuringSample: 0,
    newestAgeS: 5, oldestAgeS: 300000, maxAttempts: 9,
    lease: { active: true, ownerId: 'worker-1', acquiredAt: '2026-09-20T11:00:00.000Z',
      heartbeatAt: '2026-09-20T12:00:00.000Z' },
    counters: { totalRuns: 10, totalResolved: 20, totalSkipped: 5, totalDeferred: 7,
      totalArchiveRequired: 2 },
    ...overrides,
  };
}

describe('Robinhood deployment live-window audit', () => {
  it('accepts only bounded read-only options', () => {
    assert.deepEqual(parseArgs([]), { sampleSeconds: 30, probeBlocks: 1, timeoutMs: 15000 });
    assert.deepEqual(parseArgs([
      '--sample-seconds=60', '--probe-blocks=3', '--timeout-ms=30000',
    ]), { sampleSeconds: 60, probeBlocks: 3, timeoutMs: 30000 });
    assert.throws(() => parseArgs(['--apply']), /unknown/);
    assert.throws(() => parseArgs(['--sample-seconds=1']), /between/);
  });

  it('derives arrivals, completions and net drain only across the same worker lease', () => {
    const start = snapshot();
    const end = snapshot({ items: 94, archiveRequired: 3, agedOutDuringSample: 1,
      counters: { totalRuns: 14, totalResolved: 28, totalSkipped: 6, totalDeferred: 8,
        totalArchiveRequired: 3 } });
    assert.deepEqual(summarize(start, end, 10), {
      elapsedSeconds: 10, comparableWorkerCounters: true,
      arrivals: 4, completed: 9, resolved: 8, skipped: 1, archived: 1,
      arrivalsPerSecond: 0.4, completedPerSecond: 0.9,
      netDrainPerSecond: 0.6, backlogDelta: -6, agedOutDuringSample: 1,
    });
    assert.equal(summarize(start, snapshot({ lease: {
      ...start.lease, ownerId: 'worker-2',
    } }), 10).completed, null);
  });

  it('loads one read-only queue/lease snapshot and selects cheap recent probe blocks', async () => {
    const calls = [];
    const database = { async query(sql, params) {
      calls.push({ sql, params });
      if (sql.startsWith('/* deployment-live-window:snapshot */')) return { rows: [{
        items: 2, archive_required: 7, leased: 1, due_now: 1, older_48h: 1, older_72h: 0,
        expiring_next_hour: 1, aged_out_during_sample: 0, newest_age_s: '2',
        oldest_age_s: '200000', max_attempts: 3, owner_id: 'worker',
        lease_active: true, telemetry: { totalRuns: 4, totalResolved: 2 },
      }] };
      return { rows: [{ block_number: '100', block_hash: HASH, transactions: 0 }] };
    } };
    const sampledAt = new Date('2026-09-20T12:00:00Z');
    const loaded = await loadSnapshot(database, sampledAt);
    const blocks = await selectProbeBlocks(database, 1);
    assert.equal(loaded.items, 2);
    assert.equal(loaded.archiveRequired, 7);
    assert.equal(loaded.counters.totalResolved, 2);
    assert.deepEqual(blocks, [{ blockNumber: '100', blockHash: HASH, transactions: 0 }]);
    assert.match(calls[0].sql, /SELECT COUNT\(\*\)/);
    assert.match(calls[1].sql, /COUNT\(transaction\.transaction_hash\)=0/);
    assert.doesNotMatch(calls.map(({ sql }) => sql).join('\n'), /\b(INSERT|UPDATE|DELETE)\b/);
  });

  it('probes both recent trace APIs and preserves unsupported errors', async () => {
    assert.deepEqual(await probeRpc({ timeoutMs: 5000 }, [], {}), {
      status: 'no_canonical_blocks', blocks: [],
    });
    const calls = []; let clock = 0;
    const report = await probeRpc({ timeoutMs: 5000 }, [{
      blockNumber: '100', blockHash: HASH, transactions: 0,
    }], {
      env: { RH_NODE_RPC_URL: 'http://rpc.example' }, now: () => { clock += 5; return clock; },
      rpcClientFactory() { return { async request(method) {
        calls.push(method);
        if (method === 'eth_chainId') return '0x1237';
        if (method === 'eth_getBlockByNumber') return { hash: HASH };
        if (method === 'trace_block') return [];
        throw Object.assign(new Error('method unavailable'), { rpcCode: -32601 });
      } }; },
    });
    assert.equal(report.blocks[0].traceBlock.supported, true);
    assert.equal(report.blocks[0].debugTraceBlock.supported, false);
    assert.equal(report.blocks[0].debugTraceBlock.error.code, '-32601');
    assert.deepEqual(calls, ['eth_chainId', 'eth_getBlockByNumber',
      'trace_block', 'debug_traceBlockByNumber']);
  });

  it('samples without writes and reports the observed interval', async () => {
    const snapshots = [snapshot(), snapshot({ items: 99, agedOutDuringSample: 1,
      counters: { totalRuns: 11, totalResolved: 21, totalSkipped: 5, totalDeferred: 7,
        totalArchiveRequired: 2 } })];
    const times = [0, 10_000]; const output = [];
    const report = await main([], { options: { sampleSeconds: 10, probeBlocks: 1,
      timeoutMs: 5000 }, database: {}, now: () => times.shift(), pause: async () => {},
    loadSnapshot: async () => snapshots.shift(), selectProbeBlocks: async () => [],
    probeRpc: async () => ({ status: 'not_configured', blocks: [] }),
    logger: { log(value) { output.push(value); } } });
    assert.equal(report.mode, 'read-only');
    assert.equal(report.queue.sample.elapsedSeconds, 10);
    assert.equal(report.queue.sample.completed, 1);
    assert.deepEqual(JSON.parse(output[0]), report);
  });
});
