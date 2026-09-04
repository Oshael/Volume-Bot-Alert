'use strict';
const { MAX_BYTES, receive } = require('../services/robinhood-holder-journal-receiver');

async function readFrame(input, signal) {
  const chunks = []; let bytes = 0;
  const abort = () => input.destroy(signal.reason);
  signal.throwIfAborted(); signal.addEventListener('abort', abort, { once: true });
  try {
    for await (const chunk of input) {
      const buffer = Buffer.from(chunk); bytes += buffer.length;
      if (bytes > MAX_BYTES) throw new Error('receiver input exceeds 16 MiB');
      chunks.push(buffer);
    }
    signal.throwIfAborted();
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { signal.removeEventListener('abort', abort); }
}

async function main(args = process.argv.slice(2)) {
  if (args.length !== new Set(args).size || !args.includes('--database=holder_compaction')
      || args.some(arg => !['--database=holder_compaction', '--write'].includes(arg))) {
    throw new Error('use --database=holder_compaction [--write] with one JSON frame on stdin');
  }
  const connectionString = process.env.HOLDER_JOURNAL_RECEIVER_DATABASE_URL;
  if (!connectionString) throw new Error('HOLDER_JOURNAL_RECEIVER_DATABASE_URL is required; .env is not loaded');
  const controller = new AbortController(); const abort = () => controller.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  let pool;
  try {
    const inputSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]);
    const frame = await readFrame(process.stdin, inputSignal);
    const { Pool } = require('pg');
    pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5000,
      application_name: `holder-journal-receiver-${process.pid}`,
      options: '-c statement_timeout=5000 -c lock_timeout=500 -c idle_in_transaction_session_timeout=5000' });
    pool.on('error', abort);
    const result = await receive(pool, frame, { database: 'holder_compaction',
      write: args.includes('--write'), signal: controller.signal });
    console.log(JSON.stringify(result));
  } finally {
    process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
    if (pool) await pool.end();
  }
}

if (require.main === module) main().catch(error => {
  console.error(JSON.stringify({ status: 'failed', code: error.code || 'receiver_error', message: error.message }));
  process.exitCode = 1;
});
module.exports = { readFrame, main };
