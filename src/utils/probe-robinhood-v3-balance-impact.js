'use strict';

require('dotenv').config();

const db = require('../models/db');
const { createEvmJsonRpcClient } = require('../services/evm-json-rpc-client');
const {
  MULTICALL3_ADDRESS, decodeAggregate3, encodeAggregate3, encodeBalanceOf,
} = require('../services/evm-erc20-metadata');
const {
  captureSnapshot, dockerSnapshot, numberStats, phaseDelta, phaseSummary, rpcTarget,
} = require('./probe-robinhood-deployment-trace-impact');

const CHAIN_ID = 4663n;

function bounded(raw, fallback, min, max, label) {
  const value = Number(raw ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be between ${min} and ${max}`);
  }
  return value;
}

function parseArgs(argv = []) {
  const values = {};
  for (const arg of argv) {
    if (arg === '--full' && values.full == null) { values.full = true; continue; }
    const match = /^--(pool|phase-seconds|calls|sample-seconds|age-blocks|timeout-ms|max-extra-lag-blocks)=(.+)$/.exec(arg);
    if (!match || values[match[1]] != null) throw new Error(`unknown or repeated argument: ${arg}`);
    values[match[1]] = match[2];
  }
  const pool = String(values.pool || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(pool)) throw new Error('--pool must be a V3 pool address');
  const phaseSeconds = bounded(values['phase-seconds'], 60, 15, 300, '--phase-seconds');
  const calls = bounded(values.calls, 6, 1, 600, '--calls');
  const sampleSeconds = bounded(values['sample-seconds'], 10, 5, 30, '--sample-seconds');
  if (calls > phaseSeconds * 2) throw new Error('--calls cannot exceed two per second');
  if (sampleSeconds >= phaseSeconds) {
    throw new Error('--sample-seconds must be shorter than --phase-seconds');
  }
  return { pool, full: values.full === true, phaseSeconds, calls, sampleSeconds,
    ageBlocks: bounded(values['age-blocks'], 2, 0, 120, '--age-blocks'),
    timeoutMs: bounded(values['timeout-ms'], 3000, 1000, 10000, '--timeout-ms'),
    maxExtraLagBlocks: bounded(values['max-extra-lag-blocks'], 50, 10, 500,
      '--max-extra-lag-blocks') };
}

async function loadPool(database, address) {
  const { rows } = await database.query(`SELECT pool_address, token_address, quote_address
    FROM robinhood_pool_registry
    WHERE chain='robinhood' AND protocol='uniswap-v3'
      AND active=TRUE AND pool_address=$1`, [address]);
  if (rows.length !== 1) throw new Error(`active V3 pool ${address} is not in the registry`);
  return { address: rows[0].pool_address.toLowerCase(),
    token: rows[0].token_address.toLowerCase(),
    quote: rows[0].quote_address.toLowerCase() };
}

async function callV3Balances(rpc, pool, options, now = Date.now,
  decode = decodeAggregate3) {
  const head = BigInt(await rpc.request('eth_blockNumber'));
  if (head < BigInt(options.ageBlocks)) throw new Error('RPC head precedes requested age');
  const blockNumber = head - BigInt(options.ageBlocks);
  const calls = [pool.token, pool.quote].map((target) => ({
    target, allowFailure: true, callData: encodeBalanceOf(pool.address),
  }));
  const startedAt = now();
  let results;
  try {
    const raw = await rpc.request('eth_call', [{
      to: MULTICALL3_ADDRESS, data: encodeAggregate3(calls),
    }, `0x${blockNumber.toString(16)}`]);
    results = decode(raw, 2);
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    failure.blockNumber = blockNumber.toString();
    throw failure;
  }
  if (!results.every((item) => item.success === true
      && /^0x[0-9a-fA-F]{64}$/.test(String(item.returnData)))) {
    throw new Error(`V3 balanceOf failed at block ${blockNumber}`);
  }
  return { blockNumber: blockNumber.toString(), callMs: Math.max(0, now() - startedAt) };
}

async function runBaseline({ snapshot, options, now, pause }) {
  const start = await snapshot();
  const endAt = Date.parse(start.at) + options.phaseSeconds * 1000;
  const samples = [];
  for (let dueAt = Date.parse(start.at) + options.sampleSeconds * 1000;
    dueAt < endAt;
    dueAt = Math.max(dueAt + options.sampleSeconds * 1000,
      now() + options.sampleSeconds * 1000)) {
    await pause(Math.max(0, dueAt - now()));
    samples.push(await snapshot());
  }
  await pause(Math.max(0, endAt - now()));
  const end = await snapshot();
  return { start, samples, end, delta: phaseDelta(start, end) };
}

async function runImpact({ snapshot, options, rpc, pool, now, pause, runCall }) {
  const start = await snapshot();
  const endAt = Date.parse(start.at) + options.phaseSeconds * 1000;
  const samples = []; const calls = [];
  let stoppedReason = null; let failedCall = null;
  let nextSampleAt = Date.parse(start.at) + options.sampleSeconds * 1000;
  async function sampleUntil(deadline) {
    while (nextSampleAt < endAt && nextSampleAt <= deadline) {
      await pause(Math.max(0, nextSampleAt - now()));
      const current = await snapshot();
      samples.push(current);
      nextSampleAt = Math.max(nextSampleAt + options.sampleSeconds * 1000,
        now() + options.sampleSeconds * 1000);
      if (current.captureLagBlocks - start.captureLagBlocks > options.maxExtraLagBlocks) {
        stoppedReason = 'capture_lag_guardrail';
        break;
      }
    }
  }
  for (let index = 0; index < options.calls; index += 1) {
    const dueAt = Date.parse(start.at)
      + (index * options.phaseSeconds * 1000 / options.calls);
    await sampleUntil(dueAt);
    if (stoppedReason) break;
    await pause(Math.max(0, dueAt - now()));
    if (now() >= endAt) { stoppedReason = 'phase_deadline'; break; }
    const attemptedAt = now();
    try {
      calls.push(await runCall(rpc, pool, options, now));
    } catch (error) {
      stoppedReason = `balance_error:${String(error.message || error).slice(0, 200)}`;
      failedCall = { attempt: index + 1, blockNumber: error.blockNumber || null,
        elapsedMs: Math.max(0, now() - attemptedAt) };
      break;
    }
    await sampleUntil(now());
    if (stoppedReason) break;
  }
  if (!stoppedReason) {
    await sampleUntil(endAt);
    if (!stoppedReason) await pause(Math.max(0, endAt - now()));
  }
  const end = await snapshot();
  const delta = phaseDelta(start, end);
  return { start, samples, end, delta, calls, stoppedReason, failedCall,
    callsPerSecond: calls.length / Math.max(1, delta.elapsedSeconds),
    fractionOfNewBlocks: delta.rpcBlocks > 0 ? calls.length / delta.rpcBlocks : null };
}

function summarize(report) {
  return { mode: report.mode, target: report.target, pool: report.pool,
    options: report.options, baseline: phaseSummary(report.baseline),
    impact: { ...phaseSummary(report.impact), callsCompleted: report.impact.calls.length,
      callMs: numberStats(report.impact.calls.map((item) => item.callMs)),
      callsPerSecond: report.impact.callsPerSecond,
      fractionOfNewBlocks: report.impact.fractionOfNewBlocks,
      stoppedReason: report.impact.stoppedReason,
      failedCall: report.impact.failedCall } };
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const options = deps.options || parseArgs(argv);
  const database = deps.database || db;
  const now = deps.now || Date.now;
  const pause = deps.pause || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const nodeStats = deps.nodeStats || dockerSnapshot;
  const url = deps.url || rpcTarget(deps.env);
  const rpc = deps.rpc || createEvmJsonRpcClient({
    providers: [{ name: 'rh-pruned-v3-balance-impact', url: url.toString() }],
    timeoutMs: options.timeoutMs, maxRetries: 0,
  });
  if (BigInt(await rpc.request('eth_chainId')) !== CHAIN_ID) {
    throw new Error('RPC is not Robinhood Chain');
  }
  await nodeStats();
  const pool = await (deps.loadPool || loadPool)(database, options.pool);
  const snapshot = () => (deps.captureSnapshot || captureSnapshot)(database, rpc, nodeStats, now);
  const baseline = await runBaseline({ snapshot, options, now, pause });
  const baselineMaxLag = Math.max(baseline.start.captureLagBlocks,
    ...baseline.samples.map((item) => item.captureLagBlocks), baseline.end.captureLagBlocks);
  if (baselineMaxLag - baseline.start.captureLagBlocks > options.maxExtraLagBlocks) {
    throw new Error(`baseline capture lag grew beyond guardrail: start=${baseline.start.captureLagBlocks}, max=${baselineMaxLag}, end=${baseline.end.captureLagBlocks}; no balance calls sent`);
  }
  const impact = await runImpact({ snapshot, options, rpc, pool, now, pause,
    runCall: deps.callV3Balances || callV3Balances });
  const report = { mode: 'read-only', target: `${url.hostname}:${url.port}`,
    pool: pool.address, options, baseline, impact };
  (deps.logger || console).log(JSON.stringify(options.full ? report : summarize(report),
    null, options.full ? 2 : 0));
  if (impact.stoppedReason) process.exitCode = 2;
  return report;
}

if (require.main === module) main().catch((error) => {
  console.error('Robinhood V3 balance impact probe failed:', error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = { callV3Balances, loadPool, main, parseArgs, runBaseline, runImpact, summarize };
