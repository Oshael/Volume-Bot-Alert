'use strict';

const { normalizeOptions, runPilot } = require('../services/robinhood-holder-journal-pilot');

function parseArgs(args) {
  const options = {}; const seen = new Set();
  const keys = { database: 'database', 'from-page': 'fromPage', pages: 'pages', 'timeout-ms': 'timeoutMs' };
  for (const arg of args) {
    const match = /^--(database|from-page|pages|timeout-ms)=(.+)$/.exec(arg);
    const key = arg === '--round' ? 'round' : arg === '--measure' ? 'measure' : keys[match?.[1]];
    if (!key || seen.has(key)) throw new Error('unknown or repeated pilot argument');
    seen.add(key);
    options[key] = ['measure', 'round'].includes(key) ? true : key === 'database' ? match[2] : Number(match[2]);
  }
  if (options.round && (!options.measure || options.pages !== 512 || (options.timeoutMs || 3000) > 3000)) {
    throw new Error('--round requires --measure --pages=512 and timeout <= 3000ms');
  }
  return normalizeOptions(options);
}

async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  const connectionString = process.env.HOLDER_JOURNAL_PILOT_DATABASE_URL;
  if (!connectionString) throw new Error('HOLDER_JOURNAL_PILOT_DATABASE_URL is required');
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 5000,
    application_name: `holder-journal-pilot-${process.pid}`,
    options: '-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=500' });
  const controller = new AbortController();
  pool.on('error', () => controller.abort());
  const abort = () => controller.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  try {
    const run = options.round ? require('../services/robinhood-holder-journal-round').runSustainedPilot : runPilot;
    const report = await run(pool, options, { signal: controller.signal,
      progress: (event) => console.error(JSON.stringify(event)) });
    console.log(JSON.stringify(report));
  } finally {
    process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
    await pool.end();
  }
}

if (require.main === module) main().catch((error) => {
  console.error(JSON.stringify({ status: 'failed', code: error.code || 'pilot_error', message: error.message }));
  process.exitCode = 1;
});
module.exports = { parseArgs, main };
