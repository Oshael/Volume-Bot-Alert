'use strict';

process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  callV3Balances, loadPool, main, parseArgs,
} = require('../src/utils/probe-robinhood-v3-balance-impact');

const POOL = '0x1111111111111111111111111111111111111111';
const TOKEN = '0x2222222222222222222222222222222222222222';
const QUOTE = '0x3333333333333333333333333333333333333333';
const DETAILS = { address: POOL, token: TOKEN, quote: QUOTE };

function options(overrides = {}) {
  return { pool: POOL, full: false, phaseSeconds: 15, calls: 2,
    sampleSeconds: 5, ageBlocks: 2, timeoutMs: 3000,
    maxExtraLagBlocks: 10, ...overrides };
}

function harness(config = {}) {
  let current = 0;
  const output = [];
  const calls = [];
  return { output, calls,
    deps: { options: options(config.options), database: {},
      url: new URL('http://127.0.0.1:8547'),
      rpc: { request: async (method) => {
        assert.equal(method, 'eth_chainId'); return '0x1237';
      } },
      nodeStats: async () => ({ cpu: '10%', memory: '1GiB / 2GiB' }),
      loadPool: async () => DETAILS,
      now: () => current, pause: async (ms) => { current += ms; },
      captureSnapshot: async () => {
        const lag = config.lag?.(current) || 0;
        const head = 100 + Math.floor(current / 1000);
        return { at: new Date(current).toISOString(), rpcHead: String(head),
          checkpoint: String(head - lag), captureLagBlocks: lag,
          node: { cpu: '10%', memory: '1GiB / 2GiB' },
          hostLoad: [1], queryMs: 1, rpcHeadMs: 1 };
      },
      callV3Balances: async (_rpc, _pool, _options) => {
        calls.push(current);
        current += config.callMs || 10;
        return { blockNumber: String(100 + Math.floor(current / 1000)),
          callMs: config.callMs || 10 };
      },
      logger: { log: (value) => output.push(JSON.parse(value)) },
    } };
}

describe('Robinhood V3 balance impact probe', () => {
  it('requires a pool and bounds RPC load and window age', () => {
    assert.equal(parseArgs([`--pool=${POOL}`]).calls, 6);
    assert.throws(() => parseArgs([]), /pool/);
    assert.throws(() => parseArgs([`--pool=${POOL}`, '--calls=121',
      '--phase-seconds=60']), /two per second/);
    assert.throws(() => parseArgs([`--pool=${POOL}`, '--age-blocks=121']), /age-blocks/);
    assert.throws(() => parseArgs([`--pool=${POOL}`, '--phase-seconds=15',
      '--sample-seconds=15']), /sample-seconds/);
  });

  it('loads only an active V3 pool and probes balances near the current RPC head', async () => {
    let sql;
    const pool = await loadPool({ query: async (statement, params) => {
      sql = statement;
      assert.deepEqual(params, [POOL]);
      return { rows: [{ pool_address: POOL, token_address: TOKEN, quote_address: QUOTE }] };
    } }, POOL);
    assert.match(sql, /active=TRUE/);
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE)\b/);
    const methods = [];
    const result = await callV3Balances({ request: async (method, params) => {
      methods.push({ method, params });
      return method === 'eth_blockNumber' ? '0x64' : '0x';
    } }, pool, options(), () => 100,
    () => [{ success: true, returnData: `0x${'0'.repeat(64)}` },
      { success: true, returnData: `0x${'1'.repeat(64)}` }]);
    assert.equal(result.blockNumber, '98');
    assert.equal(methods[1].method, 'eth_call');
    assert.equal(methods[1].params[1], '0x62');
    assert.equal(methods[1].params[0].to, '0xca11bde05977b3631167028862be2a173976ca11');
  });

  it('reports comparable baseline and load windows with compact output', async () => {
    const { deps, output, calls } = harness();
    const report = await main([], deps);
    assert.equal(report.baseline.delta.elapsedSeconds, 15);
    assert.equal(report.impact.delta.elapsedSeconds, 15);
    assert.equal(report.impact.calls.length, 2);
    assert.deepEqual(calls, [15000, 22500]);
    assert.equal(output[0].impact.callsCompleted, 2);
    assert.equal(output[0].impact.calls, undefined);
  });

  it('sends no balance RPC load when baseline lag grows beyond the guardrail', async () => {
    const { deps, calls } = harness({ lag: (ms) => (ms >= 10000 ? 20 : 0) });
    await assert.rejects(main([], deps), /no balance calls sent/);
    assert.equal(calls.length, 0);
  });

  it('stops balance calls when capture lag grows during the load window', async () => {
    const { deps, output, calls } = harness({ options: { calls: 3 },
      lag: (ms) => (ms >= 20000 ? 20 : 0) });
    const report = await main([], deps);
    assert.equal(calls.length, 1);
    assert.equal(report.impact.stoppedReason, 'capture_lag_guardrail');
    assert.equal(output[0].impact.stoppedReason, 'capture_lag_guardrail');
    assert.equal(process.exitCode, 2);
    process.exitCode = 0;
  });
});
