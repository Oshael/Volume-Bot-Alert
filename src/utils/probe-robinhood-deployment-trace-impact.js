'use strict';

require('dotenv').config();

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const os = require('node:os');
const db = require('../models/db');
const { createEvmJsonRpcClient } = require('../services/evm-json-rpc-client');

const execFileAsync = promisify(execFile);
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
    const match = /^--(phase-seconds|traces|sample-seconds|max-transactions|timeout-ms|max-extra-lag-blocks)=(\d+)$/.exec(arg);
    if (!match || values[match[1]] != null) throw new Error(`unknown or repeated argument: ${arg}`);
    values[match[1]] = match[2];
  }
  const phaseSeconds = bounded(values['phase-seconds'], 60, 10, 300, '--phase-seconds');
  const traces = bounded(values.traces, 6, 1, 120, '--traces');
  const sampleSeconds = bounded(values['sample-seconds'], 10, 5, 30, '--sample-seconds');
  if (traces > phaseSeconds) throw new Error('--traces cannot exceed one trace per second');
  if (sampleSeconds >= phaseSeconds) {
    throw new Error('--sample-seconds must be shorter than --phase-seconds');
  }
  return {
    full: values.full === true,
    phaseSeconds, traces,
    sampleSeconds,
    maxTransactions: bounded(values['max-transactions'], 25, 1, 50, '--max-transactions'),
    timeoutMs: bounded(values['timeout-ms'], 3000, 1000, 10000, '--timeout-ms'),
    maxExtraLagBlocks: bounded(values['max-extra-lag-blocks'], 100, 10, 500,
      '--max-extra-lag-blocks'),
  };
}

function rpcTarget(env = process.env) {
  const url = new URL(String(env.RH_NODE_RPC_URL || '').trim());
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.port !== '8547') {
    throw new Error('RH_NODE_RPC_URL must target the VPS pruned node on loopback port 8547');
  }
  return url;
}

async function dockerSnapshot() {
  const { stdout } = await execFileAsync('docker', [
    'stats', '--no-stream', '--format', '{{json .}}', 'rh-node',
  ], { timeout: 7000, maxBuffer: 64 * 1024 });
  const data = JSON.parse(stdout.trim());
  if (data.Name !== 'rh-node') throw new Error('docker stats did not identify rh-node');
  return { cpu: data.CPUPerc, memory: data.MemUsage, memoryPercent: data.MemPerc,
    blockIo: data.BlockIO, pids: data.PIDs };
}

async function captureSnapshot(database, rpc, nodeStats, now = Date.now) {
  const timed = async (operation) => {
    const started = now();
    const value = await operation();
    return { value, latencyMs: Math.max(0, now() - started) };
  };
  const [query, head, stats] = await Promise.all([
    timed(() => database.query(`SELECT checkpoint_block::text, node_head::text,
        finalized_head::text, updated_at, recovery_state
      FROM robinhood_chain_capture_cursor WHERE chain='robinhood'`)),
    timed(() => rpc.request('eth_blockNumber')), timed(nodeStats),
  ]);
  const row = query.value.rows[0];
  if (!row?.checkpoint_block) throw new Error('Robinhood capture cursor is unavailable');
  const checkpoint = BigInt(row.checkpoint_block);
  return { at: new Date(now()).toISOString(), rpcHead: BigInt(head.value).toString(),
    checkpoint: checkpoint.toString(), nodeHead: row.node_head,
    finalizedHead: row.finalized_head,
    captureLagBlocks: Number(BigInt(head.value) - checkpoint),
    recoveryState: row.recovery_state,
    queryMs: query.latencyMs, rpcHeadMs: head.latencyMs,
    dockerStatsMs: stats.latencyMs, node: stats.value,
    hostLoad: os.loadavg().map((value) => Number(value.toFixed(2))) };
}

async function selectBlocks(database, options) {
  const { rows } = await database.query(`/* deployment-trace-impact:candidates */
    WITH recent AS (
      SELECT block_number, block_hash FROM robinhood_chain_blocks
      WHERE chain='robinhood' AND canonical ORDER BY block_number DESC LIMIT 128
    )
    SELECT recent.block_number::text, recent.block_hash,
      COUNT(tx.transaction_hash)::int AS transactions
    FROM recent LEFT JOIN robinhood_chain_transactions tx
      ON tx.chain='robinhood' AND tx.block_hash=recent.block_hash
    GROUP BY recent.block_number, recent.block_hash
    HAVING COUNT(tx.transaction_hash) BETWEEN 1 AND $1::int
    ORDER BY transactions DESC, recent.block_number DESC LIMIT $2::int`,
  [options.maxTransactions, options.traces]);
  return rows.map((row) => ({ blockNumber: row.block_number,
    blockHash: row.block_hash, transactions: row.transactions }));
}

function countCreations(traces) {
  let creations = 0;
  const stack = Array.isArray(traces) ? traces.map((entry) => entry?.result || entry) : [];
  while (stack.length) {
    const frame = stack.pop();
    if (!frame || typeof frame !== 'object') continue;
    if (['CREATE', 'CREATE2'].includes(String(frame.type).toUpperCase())) creations += 1;
    if (Array.isArray(frame.calls)) stack.push(...frame.calls);
  }
  return creations;
}

async function traceBlock(rpc, block, options, now = Date.now) {
  const tag = `0x${BigInt(block.blockNumber).toString(16)}`;
  const canonical = await rpc.request('eth_getBlockByNumber', [tag, false]);
  if (String(canonical?.hash || '').toLowerCase() !== block.blockHash
      || canonical.transactions?.length !== block.transactions) {
    throw new Error(`block ${block.blockNumber} differs from the committed journal`);
  }
  const started = now();
  const traces = await rpc.request('debug_traceBlockByNumber', [tag, {
    tracer: 'callTracer', reexec: 0, timeout: `${options.timeoutMs}ms`,
  }]);
  if (!Array.isArray(traces) || traces.length !== block.transactions) {
    throw new Error(`block ${block.blockNumber} trace has incomplete transactions`);
  }
  return { ...block, traceMs: Math.max(0, now() - started),
    tracedTransactions: traces.length, creations: countCreations(traces) };
}

function phaseDelta(start, end) {
  return { elapsedSeconds: (Date.parse(end.at) - Date.parse(start.at)) / 1000,
    rpcBlocks: Number(BigInt(end.rpcHead) - BigInt(start.rpcHead)),
    capturedBlocks: Number(BigInt(end.checkpoint) - BigInt(start.checkpoint)),
    lagChangeBlocks: end.captureLagBlocks - start.captureLagBlocks };
}

function numberStats(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  return { min: sorted[0], p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1], max: sorted.at(-1) };
}

function phaseSummary(phase) {
  const snapshots = [phase.start, ...phase.samples, phase.end];
  return { seconds: phase.delta.elapsedSeconds,
    rpcBlocks: phase.delta.rpcBlocks, capturedBlocks: phase.delta.capturedBlocks,
    captureLagBlocks: { start: phase.start.captureLagBlocks,
      end: phase.end.captureLagBlocks,
      max: Math.max(...snapshots.map((item) => item.captureLagBlocks)) },
    nodeCpuPct: numberStats(snapshots.map((item) => Number.parseFloat(item.node?.cpu))),
    nodeMemory: { start: phase.start.node?.memory, end: phase.end.node?.memory },
    hostLoad1: { start: phase.start.hostLoad?.[0], end: phase.end.hostLoad?.[0] },
    rpcHeadMs: numberStats(snapshots.map((item) => item.rpcHeadMs)),
    dbMs: numberStats(snapshots.map((item) => item.queryMs)),
    samples: snapshots.length };
}

function summarizeReport(report) {
  const traces = report.impact.traces;
  return { mode: report.mode, target: report.target, options: report.options,
    baseline: phaseSummary(report.baseline),
    impact: { ...phaseSummary(report.impact), candidates: report.impact.candidateCount,
      tracesCompleted: traces.length,
      traceMs: numberStats(traces.map((item) => item.traceMs)),
      tracedTransactions: traces.reduce((sum, item) => sum + item.tracedTransactions, 0),
      creations: traces.reduce((sum, item) => sum + item.creations, 0),
      ratePerSecond: report.impact.attemptedRatePerSecond,
      fractionOfNewBlocks: report.impact.tracedFractionOfNewBlocks,
      stoppedReason: report.impact.stoppedReason,
      failedBlock: report.impact.failedBlock } };
}

function formatReport(report) {
  return report.options.full
    ? JSON.stringify(report, null, 2)
    : JSON.stringify(summarizeReport(report));
}

async function runImpact({ candidates, options, snapshot, rpc, now, pause, runTrace }) {
  const start = await snapshot();
  const endAt = Date.parse(start.at) + options.phaseSeconds * 1000;
  const traces = [];
  const samples = [];
  let stoppedReason = null;
  let failedBlock = null;
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
  for (const [index, block] of candidates.entries()) {
    const dueAt = Date.parse(start.at)
      + (index * options.phaseSeconds * 1000 / candidates.length);
    await sampleUntil(dueAt);
    if (stoppedReason) break;
    await pause(Math.max(0, dueAt - now()));
    if (now() >= endAt) { stoppedReason = 'phase_deadline'; break; }
    const attemptedAt = now();
    try {
      traces.push(await runTrace(rpc, block, options, now));
    } catch (error) {
      stoppedReason = `trace_error:${String(error.message || error).slice(0, 200)}`;
      failedBlock = { blockNumber: block.blockNumber,
        transactions: block.transactions, elapsedMs: Math.max(0, now() - attemptedAt) };
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
  return { start, samples, end, delta, traces, stoppedReason, failedBlock,
    candidateCount: candidates.length,
    attemptedRatePerSecond: traces.length / Math.max(1, delta.elapsedSeconds),
    tracedFractionOfNewBlocks: delta.rpcBlocks > 0
      ? traces.length / delta.rpcBlocks : null };
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const options = deps.options || parseArgs(argv);
  const database = deps.database || db;
  const now = deps.now || Date.now;
  const pause = deps.pause || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const nodeStats = deps.nodeStats || dockerSnapshot;
  const url = deps.url || rpcTarget(deps.env);
  const rpc = deps.rpc || createEvmJsonRpcClient({
    providers: [{ name: 'rh-pruned-trace-impact', url: url.toString() }],
    timeoutMs: options.timeoutMs, maxRetries: 0,
  });
  if (BigInt(await rpc.request('eth_chainId')) !== CHAIN_ID) {
    throw new Error('RPC is not Robinhood Chain');
  }
  // Require resource telemetry before sending any trace to the production node.
  await nodeStats();
  const snapshot = () => (deps.captureSnapshot || captureSnapshot)(database, rpc, nodeStats, now);
  const baselineStart = await snapshot();
  const baselineSamples = [];
  const baselineEndAt = Date.parse(baselineStart.at) + options.phaseSeconds * 1000;
  for (let dueAt = Date.parse(baselineStart.at) + options.sampleSeconds * 1000;
    dueAt < baselineEndAt;
    dueAt = Math.max(dueAt + options.sampleSeconds * 1000,
      now() + options.sampleSeconds * 1000)) {
    await pause(Math.max(0, dueAt - now()));
    baselineSamples.push(await snapshot());
  }
  await pause(Math.max(0, baselineEndAt - now()));
  const baselineEnd = await snapshot();
  const candidates = await (deps.selectBlocks || selectBlocks)(database, options);
  if (!candidates.length) throw new Error('no recent committed block fits the transaction cap');
  const impact = await runImpact({ candidates, options, snapshot, rpc, now, pause,
    runTrace: deps.traceBlock || traceBlock });
  const report = { mode: 'read-only', target: `${url.hostname}:${url.port}`, options,
    baseline: { start: baselineStart, samples: baselineSamples, end: baselineEnd,
      delta: phaseDelta(baselineStart, baselineEnd) },
    impact };
  (deps.logger || console).log(formatReport(report));
  if (impact.stoppedReason) process.exitCode = 2;
  return report;
}

if (require.main === module) main().catch((error) => {
  console.error('Robinhood deployment trace impact probe failed:', error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = { captureSnapshot, countCreations, main, parseArgs, phaseDelta,
  rpcTarget, selectBlocks, summarizeReport, traceBlock };
