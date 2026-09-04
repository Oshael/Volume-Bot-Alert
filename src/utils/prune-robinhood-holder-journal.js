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

async function runBatch(client, options) {
  // The repository owns BEGIN/COMMIT/ROLLBACK. Timeouts and the shared reorg
  // fence are installed immediately after BEGIN, before locking the live cursor.
  const database = {
    getClient: async () => ({
      async query(sql, params) {
        const result = await client.query(sql, params);
        if (sql === 'BEGIN') {
          await client.query("SET LOCAL lock_timeout = '500ms'");
          await client.query("SET LOCAL statement_timeout = '5s'");
          await client.query("SET LOCAL idle_in_transaction_session_timeout = '5s'");
          await ledger.lockReorgFence(client, 'shared');
        }
        return result;
      },
      release() {},
    }),
  };
  const result = await createRobinhoodHolderJournalRetention({ database }).pruneOnce(options);
  return { ...result, totalDeleted: result.deletedEvents + (result.discardedBufferedEvents || 0) };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const db = require('../models/db');
  const client = await db.getClient();
  try {
    const result = await runBatch(client, options);
    console.log(JSON.stringify(result));
    if (result.status === 'blocked') process.exitCode = 2;
  } finally {
    client.release();
    await db.pool.end();
  }
}

if (require.main === module) main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

module.exports = { parseArgs, runBatch };
