const { createRobinhoodHolderJournalRetention, __private } = require('../models/robinhood-holder-journal-retention');
const { __private: ledger } = require('../models/robinhood-holder-ledger');

function parseArgs(args) {
  const before = args.filter((arg) => arg.startsWith('--before-block='));
  const batch = args.filter((arg) => arg.startsWith('--batch-limit='));
  if (before.length !== 1 || batch.length > 1
    || args.filter((arg) => arg === '--write').length !== 1
    || args.some((arg) => arg !== '--write' && !before.includes(arg) && !batch.includes(arg))) {
    throw new Error('Use --before-block=<exclusive block> [--batch-limit=1000] --write (one batch)');
  }
  const options = __private.normalizeOptions({
    beforeBlock: before[0].slice('--before-block='.length),
    batchLimit: batch.length ? Number(batch[0].slice('--batch-limit='.length)) : 1000,
  });
  if (options.batchLimit > 1000) throw new Error('Manual batch-limit must not exceed 1000 per lane');
  return options;
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const db = require('../models/db');
  const client = await db.getClient();
  try {
    const diagnostics = {};
    const result = await runBatch(client, options, diagnostics);
    console.log(JSON.stringify({ ...result, ...diagnostics }));
    if (result.status === 'blocked') process.exitCode = 2;
  } finally {
    client.release();
    await db.pool.end();
  }
}

if (require.main === module) main().catch((error) => {
  console.error(JSON.stringify(failureReport(error)));
  process.exitCode = 1;
});

module.exports = { parseArgs, runBatch, createDiagnosticClient, failureReport };
