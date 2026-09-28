'use strict';

process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  captureSnapshot, countCreations, main, parseArgs, rpcTarget, selectBlocks, traceBlock,
} = require('../src/utils/probe-robinhood-deployment-trace-impact');

const HASH = `0x${'a'.repeat(64)}`;
const BLOCK = { blockNumber: '100', blockHash: HASH, transactions: 2 };

describe('Robinhood deployment trace impact probe', () => {
  it('rejects unbounded options and non-pruned RPC targets', () => {
    assert.deepEqual(parseArgs([]), { phaseSeconds: 60, traces: 6,
      sampleSeconds: 10, maxTransactions: 25, timeoutMs: 3000,
      maxExtraLagBlocks: 100 });
    assert.equal(parseArgs(['--phase-seconds=300', '--traces=120']).traces, 120);
    assert.throws(() => parseArgs(['--traces=121']), /between/);
    assert.throws(() => parseArgs(['--phase-seconds=10', '--traces=11']), /one trace per second/);
    assert.throws(() => parseArgs(['--phase-seconds=10']), /sample-seconds must be shorter/);
    assert.throws(() => parseArgs(['--apply']), /unknown/);
    assert.throws(() => rpcTarget({ RH_NODE_RPC_URL: 'http://127.0.0.1:18547' }), /8547/);
    assert.equal(rpcTarget({ RH_NODE_RPC_URL: 'http://127.0.0.1:8547' }).port, '8547');
  });

  it('selects only capped, committed canonical blocks with transactions', async () => {
    let call;
    const blocks = await selectBlocks({ async query(sql, params) {
      call = { sql, params };
      return { rows: [{ block_number: '100', block_hash: HASH, transactions: 2 }] };
    } }, { maxTransactions: 10, traces: 1 });
    assert.deepEqual(blocks, [BLOCK]);
    assert.deepEqual(call.params, [10, 1]);
    assert.match(call.sql, /canonical/);
    assert.match(call.sql, /BETWEEN 1 AND/);
    assert.doesNotMatch(call.sql, /\b(INSERT|UPDATE|DELETE)\b/);
  });

  it('samples node head and capture lag without writing to PostgreSQL', async () => {
    let sql;
    const snapshot = await captureSnapshot({ async query(statement) {
      sql = statement;
      return { rows: [{ checkpoint_block: '100', node_head: '102',
        finalized_head: '99', recovery_state: 'healthy' }] };
    } }, { request: async () => '0x69' }, async () => ({ cpu: '5%' }), () => 1000);
    assert.equal(snapshot.captureLagBlocks, 5);
    assert.equal(snapshot.node.cpu, '5%');
    assert.equal(snapshot.rpcHeadMs, 0);
    assert.match(sql, /^SELECT/);
  });

  it('checks journal hash and transaction count before tracing the complete block', async () => {
    const calls = [];
    const rpc = { async request(method, params) {
      calls.push({ method, params });
      if (method === 'eth_getBlockByNumber') {
        return { hash: HASH, transactions: ['tx1', 'tx2'] };
      }
      return [{ result: { type: 'CALL', calls: [{ type: 'CREATE2' }] } },
        { result: { type: 'CREATE' } }];
    } };
    const result = await traceBlock(rpc, BLOCK, { timeoutMs: 3000 }, () => 100);
    assert.equal(result.creations, 2);
    assert.equal(result.tracedTransactions, 2);
    assert.deepEqual(calls.map((call) => call.method), [
      'eth_getBlockByNumber', 'debug_traceBlockByNumber',
    ]);
    assert.equal(calls[1].params[1].reexec, 0);
    assert.equal(countCreations([{ result: { type: 'CALL' } }]), 0);
    await assert.rejects(traceBlock({ request: async () => ({ hash: 'wrong' }) },
      BLOCK, { timeoutMs: 3000 }), /differs/);
  });

  it('reports matched baseline and impact windows and stops on capture lag', async () => {
    let current = 0;
    let snapshots = 0;
    const outputs = [];
    const options = { phaseSeconds: 10, traces: 1, sampleSeconds: 5,
      maxTransactions: 10,
      timeoutMs: 3000, maxExtraLagBlocks: 10 };
    const report = await main([], { options, database: {},
      url: new URL('http://127.0.0.1:8547'),
      rpc: { request: async () => '0x1237' }, nodeStats: async () => ({}),
      selectBlocks: async () => [BLOCK],
      now: () => current, pause: async (ms) => { current += ms; },
      captureSnapshot: async () => {
        snapshots += 1;
        return { at: new Date(current).toISOString(), rpcHead: String(100 + snapshots),
          checkpoint: '100', captureLagBlocks: snapshots === 5 ? 20 : 0,
          node: {} };
      },
      traceBlock: async () => ({ ...BLOCK, traceMs: 20, creations: 1 }),
      logger: { log: (value) => outputs.push(JSON.parse(value)) },
    });
    assert.equal(report.mode, 'read-only');
    assert.equal(report.baseline.delta.elapsedSeconds, 10);
    assert.equal(report.baseline.samples.length, 1);
    assert.equal(report.impact.traces.length, 1);
    assert.equal(report.impact.stoppedReason, 'capture_lag_guardrail');
    assert.deepEqual(outputs[0], report);
    assert.equal(process.exitCode, 2);
    process.exitCode = 0;
  });

  it('paces traces across a longer phase and samples independently of trace count', async () => {
    let current = 0;
    const options = { phaseSeconds: 30, traces: 3, sampleSeconds: 5,
      maxTransactions: 10, timeoutMs: 3000, maxExtraLagBlocks: 100 };
    const report = await main([], { options, database: {},
      url: new URL('http://127.0.0.1:8547'),
      rpc: { request: async () => '0x1237' }, nodeStats: async () => ({}),
      selectBlocks: async () => [BLOCK, { ...BLOCK, blockNumber: '101' },
        { ...BLOCK, blockNumber: '102' }],
      now: () => current, pause: async (ms) => { current += ms; },
      captureSnapshot: async () => ({ at: new Date(current).toISOString(),
        rpcHead: String(100 + Math.floor(current / 1000)), checkpoint: '100',
        captureLagBlocks: Math.floor(current / 1000), node: {} }),
      traceBlock: async (_rpc, block) => {
        current += 1000;
        return { ...block, traceMs: 1000, creations: 0 };
      },
      logger: { log() {} },
    });
    assert.equal(report.baseline.delta.elapsedSeconds, 30);
    assert.equal(report.impact.delta.elapsedSeconds, 30);
    assert.equal(report.baseline.samples.length, 5);
    assert.equal(report.impact.samples.length, 5);
    assert.equal(report.impact.traces.length, 3);
    assert.equal(report.impact.tracedFractionOfNewBlocks, 0.1);
    assert.equal(report.impact.stoppedReason, null);
  });
});
