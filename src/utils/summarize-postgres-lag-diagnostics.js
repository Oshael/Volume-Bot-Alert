'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function rounded(value, digits = 2) {
  return value == null ? null : Number(Number(value).toFixed(digits));
}

function delta(before, after) {
  const left = number(before);
  const right = number(after);
  return left == null || right == null ? null : right - left;
}

function divided(value, divisor) {
  const numerator = number(value);
  const denominator = number(divisor);
  return numerator == null || denominator == null || denominator === 0
    ? null : rounded(numerator / denominator);
}

function parseArgs(argv = [], cwd = process.cwd()) {
  const values = {};
  for (const argument of argv) {
    const match = /^--(input|output|top)=(.+)$/.exec(argument);
    if (!match) throw new Error(`unknown argument: ${argument}`);
    if (values[match[1]] != null) throw new Error(`--${match[1]} cannot be repeated`);
    values[match[1]] = match[2];
  }
  if (!values.input) throw new Error('--input is required');
  const input = path.resolve(cwd, values.input);
  const output = path.resolve(cwd, values.output || `${input}.summary.json`);
  const top = Number(values.top || 8);
  if (!Number.isSafeInteger(top) || top < 1 || top > 20) {
    throw new Error('--top must be between 1 and 20');
  }
  return Object.freeze({ input, output, top });
}

function ranked(counts = {}, samples, limit, excluded = new Set()) {
  return Object.entries(counts).filter(([name]) => !excluded.has(name))
    .sort((left, right) => Number(right[1]) - Number(left[1])).slice(0, limit)
    .map(([name, count]) => ({ name, sessionSamples: Number(count),
      averageSessions: rounded(Number(count) / Math.max(1, samples)) }));
}

function compactSql(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 240);
}

function processingReport(start = {}, end = {}) {
  const startStreams = new Map((start.streams || []).map((row) => [row.stream, row]));
  return (end.streams || []).map((last) => {
    const first = startStreams.get(last.stream) || {};
    return {
      stream: last.stream,
      safeHeadStart: number(first.safe_head), safeHeadEnd: number(last.safe_head),
      reportedFloorStart: number(first.pending_block), reportedFloorEnd: number(last.pending_block),
      activeFloorStart: number(first.active_block), activeFloorEnd: number(last.active_block),
      claimableFloorStart: number(first.claimable_block),
      claimableFloorEnd: number(last.claimable_block),
      reportedLagStart: number(first.lag_blocks), reportedLagEnd: number(last.lag_blocks),
      reportedLagDelta: delta(first.lag_blocks, last.lag_blocks),
      activeLagStart: number(first.active_lag_blocks), activeLagEnd: number(last.active_lag_blocks),
      activeLagDelta: delta(first.active_lag_blocks, last.active_lag_blocks),
    };
  });
}

function workerReport(start = {}, end = {}) {
  const before = start.telemetry || {};
  const after = end.telemetry || {};
  const timing = after.lastTiming || {};
  const persistence = timing.persistence || {};
  return {
    processedDelta: delta(before.totalProcessed, after.totalProcessed),
    rejectedDelta: delta(before.totalRejected, after.totalRejected),
    lastProgressAt: after.lastProgressAt || null,
    lastTickMs: {
      claim: number(timing.claimMs), prepare: number(timing.prepareMs),
      persist: number(timing.persistMs), settle: number(timing.settleMs),
      total: number(timing.totalMs), commit: number(persistence.commitMs),
      observations: number(persistence.observationsMs), logs: number(persistence.logsMs),
    },
  };
}

function windowReport(input, summary) {
  const metadata = input.metadata || {};
  const first = input.first || {};
  const last = input.last || {};
  const startedAt = summary.startedAt || first.sampledAt || metadata.startedAt;
  const completedAt = summary.completedAt || last.sampledAt;
  const durationSeconds = startedAt && completedAt
    ? (new Date(completedAt) - new Date(startedAt)) / 1000 : null;
  const sampleCount = number(summary.samples) || input.sampleCount || 0;
  return { startedAt, completedAt, durationSeconds, sampleCount };
}

function statementReport(rows, top) {
  return (rows || []).slice(0, top).map((row) => ({
    query: compactSql(row.query), calls: number(row.calls),
    totalSeconds: divided(row.totalExecTimeMs, 1000),
    meanMs: divided(row.totalExecTimeMs, row.calls),
    walMB: divided(row.walBytes, 1048576), sharedBlocksRead: number(row.sharedBlocksRead),
    sharedBlocksDirtied: number(row.sharedBlocksDirtied),
    tempBlocksWritten: number(row.tempBlocksWritten),
  }));
}

function tableReport(rows, top, durationSeconds) {
  return (rows || []).slice(0, top).map((row) => ({
    ...row, writesPerSecond: divided(row.writes, durationSeconds),
  }));
}

function databaseReport(input, summary, top, window) {
  const waits = summary.waitSampleCounts || {};
  const walRate = number(summary.averageWalBytesPerSecond);
  return {
    averageWalMBps: divided(walRate, 1048576),
    estimatedWalGB: window.durationSeconds > 0
      ? rounded(walRate * window.durationSeconds / 1073741824) : null,
    activity: input.activity || {},
    idleClientReadSessionSamples: number(waits['Client:ClientRead']) || 0,
    topResourceWaits: ranked(waits, window.sampleCount, top, new Set(['Client:ClientRead'])),
    vacuumPresence: ranked(summary.vacuumSampleCounts, window.sampleCount, top),
  };
}

function buildReport(input, top = 8) {
  const summary = input.summary || {};
  const window = windowReport(input, summary);
  return {
    source: input.source,
    window: { startedAt: window.startedAt, completedAt: window.completedAt,
      durationSeconds: rounded(window.durationSeconds), samples: window.sampleCount,
      sampleErrors: number(summary.sampleErrors) || 0 },
    processing: processingReport(summary.processingStart, summary.processingEnd),
    worker: workerReport(summary.processingStart, summary.processingEnd),
    database: databaseReport(input, summary, top, window),
    topTablesByWrites: tableReport(
      summary.topTableWriteDeltas, top, window.durationSeconds
    ),
    topStatementsByExecutionTime: statementReport(summary.topStatementDeltas, top),
    statementStats: { available: summary.statementStatsAvailable === true,
      errors: summary.statementStatsErrors || [] },
    collectionErrors: Object.entries(input.errors || {})
      .map(([error, count]) => ({ error, count })),
  };
}

function recordSample(state, item) {
  state.first ||= item;
  state.last = item;
  state.sampleCount += 1;
  const activity = item.activity || {};
  state.activity.maxActive = Math.max(state.activity.maxActive, number(activity.active) || 0);
  state.activity.maxWaiting = Math.max(state.activity.maxWaiting, number(activity.waiting) || 0);
  state.activity.maxBlocked = Math.max(state.activity.maxBlocked, number(activity.blocked) || 0);
  if ((number(activity.blocked) || 0) > 0) state.activity.samplesWithBlockers += 1;
  state.activity.maxOldestQueryMs = Math.max(
    state.activity.maxOldestQueryMs, number(activity.oldestQueryMs) || 0
  );
  state.activity.maxOldestTransactionMs = Math.max(
    state.activity.maxOldestTransactionMs, number(activity.oldestTransactionMs) || 0
  );
  for (const error of item.errors || []) {
    const key = `${error.probe || 'unknown'}: ${error.message || 'unknown'}`;
    state.errors[key] = (state.errors[key] || 0) + 1;
  }
}

function recordItem(state, item) {
  if (item.type === 'metadata') state.metadata = item;
  else if (item.type === 'summary') state.summary = item;
  else if (item.type === 'sample') recordSample(state, item);
}

async function readDiagnostic(input) {
  const state = { source: input, sampleCount: 0, errors: {}, activity: {
    maxActive: 0, maxWaiting: 0, maxBlocked: 0, samplesWithBlockers: 0,
    maxOldestQueryMs: 0, maxOldestTransactionMs: 0,
  } };
  const lines = readline.createInterface({ input: fs.createReadStream(input), crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (!line.trim()) continue;
    let item;
    try { item = JSON.parse(line); } catch (_) {
      throw new Error(`invalid JSON on line ${lineNumber}`);
    }
    recordItem(state, item);
  }
  if (!state.summary) throw new Error('diagnostic is incomplete: final summary is missing');
  return state;
}

async function summarizeFile(options) {
  const state = await readDiagnostic(options.input);
  const report = buildReport(state, options.top);
  await fsp.writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArgs(argv, dependencies.cwd);
  const report = await summarizeFile(options);
  (dependencies.logger || console).log(JSON.stringify({ output: options.output, report }, null, 2));
  return report;
}

if (require.main === module) main().catch((error) => {
  console.error('PostgreSQL lag summary failed:', error.message);
  process.exitCode = 1;
});

module.exports = { buildReport, main, parseArgs, readDiagnostic, summarizeFile };
