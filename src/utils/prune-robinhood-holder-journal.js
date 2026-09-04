const { createRobinhoodHolderJournalRetention, __private } = require('../models/robinhood-holder-journal-retention');
const { __private: ledger } = require('../models/robinhood-holder-ledger');

function parseArgs(args) {
  const before = args.filter((arg) => arg.startsWith('--before-block='));
  const batch = args.filter((arg) => arg.startsWith('--batch-limit='));
  const maxBatches = args.filter((arg) => arg.startsWith('--max-batches='));
  const pause = args.filter((arg) => arg.startsWith('--pause-ms='));
  if (before.length !== 1 || batch.length > 1 || maxBatches.length > 1 || pause.length > 1
    || args.filter((arg) => arg === '--write').length !== 1
    || args.some((arg) => arg !== '--write' && !before.includes(arg) && !batch.includes(arg)
      && !maxBatches.includes(arg) && !pause.includes(arg))) {
    throw new Error('Use --before-block=<exclusive block> [--batch-limit=1000] '
      + '[--max-batches=1] [--pause-ms=1000] --write');
  }
  const options = __private.normalizeOptions({
    beforeBlock: before[0].slice('--before-block='.length),
    batchLimit: batch.length ? Number(batch[0].slice('--batch-limit='.length)) : 1000,
  });
  if (options.batchLimit > 1000) throw new Error('Manual batch-limit must not exceed 1000 total events');
  const maxBatchesValue = maxBatches.length
    ? Number(maxBatches[0].slice('--max-batches='.length)) : 1;
  const pauseMs = pause.length ? Number(pause[0].slice('--pause-ms='.length)) : 1000;
  if (!Number.isInteger(maxBatchesValue) || maxBatchesValue < 1 || maxBatchesValue > 100) {
    throw new Error('Manual max-batches must be an integer from 1 to 100');
  }
  if (!Number.isInteger(pauseMs) || pauseMs < 100 || pauseMs > 60000) {
    throw new Error('Manual pause-ms must be an integer from 100 to 60000');
  }
  return { ...options, maxBatches: maxBatchesValue, pauseMs };
}

function createDiagnosticClient(client) {
  const started = performance.now();
  const timingMs = {};
  let failedStep = null;
  let transaction = 'not_started';

  async function query(step, sql, params) {
    const before = performance.now();
    try {
      const result = await client.query(sql, params);
      if (step === 'begin') transaction = 'open';
      if (step === 'commit') transaction = 'committed';
      if (step === 'rollback') transaction = failedStep === 'commit' ? 'unknown' : 'rolled_back';
      return result;
    } catch (error) {
      failedStep ||= step;
      if (step === 'commit' || step === 'rollback') transaction = 'unknown';
      throw error;
    } finally {
      timingMs[step] = (timingMs[step] || 0) + Math.round(performance.now() - before);
    }
  }

  function snapshot() {
    return { failedStep, transaction, elapsedMs: Math.round(performance.now() - started),
      timingMs: { ...timingMs } };
  }
  return { query, snapshot };
}

function failureReport(error) {
  return { status: 'error', code: error.code || null, message: error.message,
    ...(error.batchProgress ? { progress: error.batchProgress } : {}),
    ...(error.pruneDiagnostics || {}) };
}

async function runBatch(client, options, diagnostics = {}) {
  const measured = createDiagnosticClient(client);
  // The repository owns BEGIN/COMMIT/ROLLBACK. Timeouts and the shared reorg
  // fence are installed immediately after BEGIN, before locking the live cursor.
  const database = {
    getClient: async () => ({
      async query(sql, params) {
        const step = sql.match(/^\/\* holder-prune:([a-z_]+) \*\//)?.[1]
          || ({ BEGIN: 'begin', COMMIT: 'commit', ROLLBACK: 'rollback' }[sql]) || 'query';
        const result = await measured.query(step, sql, params);
        if (sql === 'BEGIN') {
          await measured.query('configure', "SET LOCAL lock_timeout = '500ms'");
          await measured.query('configure', "SET LOCAL statement_timeout = '5s'");
          await measured.query('configure', "SET LOCAL idle_in_transaction_session_timeout = '5s'");
          await ledger.lockReorgFence({
            query: (text, values) => measured.query('reorg_fence', text, values),
          }, 'shared');
        }
        return result;
      },
      release() {},
    }),
  };
  try {
    const result = await createRobinhoodHolderJournalRetention({ database }).pruneOnce(options);
    return { ...result, totalDeleted: result.deletedEvents + (result.discardedBufferedEvents || 0) };
  } catch (error) {
    error.pruneDiagnostics = measured.snapshot();
    throw error;
  } finally {
    Object.assign(diagnostics, measured.snapshot());
  }
}

function runSummary(state, stopReason, lastResult = null) {
  return {
    status: 'finished',
    stopReason,
    batches: state.batches,
    totalDeleted: state.totalDeleted,
    deletedEvents: state.deletedEvents,
    discardedBufferedEvents: state.discardedBufferedEvents,
    journalFloorBlock: lastResult?.journalFloorBlock || state.journalFloorBlock || null,
    lastStatus: lastResult?.status || null,
  };
}

async function runBatches(client, options, dependencies = {}) {
  const execute = dependencies.runBatch || runBatch;
  const pause = dependencies.pause || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const shouldStop = dependencies.shouldStop || (() => false);
  const progress = dependencies.progress || (() => {});
  const state = {
    batches: 0,
    totalDeleted: 0,
    deletedEvents: 0,
    discardedBufferedEvents: 0,
    journalFloorBlock: null,
  };
  let lastResult = null;

  for (let index = 0; index < options.maxBatches; index += 1) {
    if (shouldStop()) return runSummary(state, 'signal', lastResult);
    const diagnostics = {};
    try {
      lastResult = await execute(client, options, diagnostics);
    } catch (error) {
      error.batchProgress = runSummary(state, 'error', lastResult);
      throw error;
    }
    state.batches += 1;
    state.totalDeleted += lastResult.totalDeleted || 0;
    state.deletedEvents += lastResult.deletedEvents || 0;
    state.discardedBufferedEvents += lastResult.discardedBufferedEvents || 0;
    state.journalFloorBlock = lastResult.journalFloorBlock || state.journalFloorBlock;
    progress({ phase: 'batch', batch: state.batches, ...lastResult, ...diagnostics });

    if (lastResult.status !== 'draining') {
      return runSummary(state, lastResult.status, lastResult);
    }
    if (index + 1 < options.maxBatches) await pause(options.pauseMs);
  }
  return runSummary(state, 'batch_limit', lastResult);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const db = require('../models/db');
  const client = await db.getClient();
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const result = await runBatches(client, options, {
      shouldStop: () => stopping,
      progress: (entry) => console.log(JSON.stringify(entry)),
    });
    console.log(JSON.stringify({ phase: 'summary', ...result }));
    if (result.lastStatus === 'blocked') process.exitCode = 2;
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    client.release();
    await db.pool.end();
  }
}

if (require.main === module) main().catch((error) => {
  console.error(JSON.stringify(failureReport(error)));
  process.exitCode = 1;
});

module.exports = {
  parseArgs, runBatch, runBatches, createDiagnosticClient, failureReport,
};
