#!/usr/bin/env node
require('dotenv').config();
const db = require('../models/db');
const {
  createRobinhoodFreshWalletLiveQueueRepository,
} = require('../models/robinhood-fresh-wallet-live-queue');
const {
  createRobinhoodFreshWalletSeedRepository,
} = require('../models/robinhood-fresh-wallet-seed');
const {
  createRobinhoodFreshWalletShadowRepository,
} = require('../models/robinhood-fresh-wallet-shadow');
const { executeSeed, runPreflight } = require('../services/robinhood-fresh-wallet-seed-runner');

function parseArgs(argv = process.argv.slice(2)) {
  const allowed = new Set(['samples', 'concurrency', 'batch-size', 'max-hours',
    'max-minutes', 'timeout-ms']);
  if (argv.some((arg) => arg !== '--apply' && (!arg.startsWith('--')
      || !arg.includes('=') || !allowed.has(arg.slice(2, arg.indexOf('=')))))) {
    throw new Error('unexpected argument');
  }
  const values = Object.fromEntries(argv.filter((arg) => arg.startsWith('--') && arg.includes('='))
    .map((arg) => { const index = arg.indexOf('='); return [arg.slice(2, index), arg.slice(index + 1)]; }));
  const number = (key, fallback) => values[key] == null ? fallback : Number(values[key]);
  const options = {
    apply: argv.includes('--apply'), sampleCount: number('samples', 3),
    concurrency: number('concurrency', 2), batchSize: number('batch-size', 10),
    maxHours: number('max-hours', 5), maxMinutes: number('max-minutes', 285),
    timeoutMs: number('timeout-ms', 60_000),
  };
  return options;
}

async function main() {
  const options = parseArgs();
  const repository = createRobinhoodFreshWalletSeedRepository({ database: db });
  const rpc = { ...options, repository, env: process.env };
  const preflight = await runPreflight(rpc, options);
  console.log(JSON.stringify({ phase: 'preflight', ...preflight }));
  if (!options.apply) return;
  const progress = await executeSeed({ ...rpc,
    queue: createRobinhoodFreshWalletLiveQueueRepository({ database: db }),
    shadow: createRobinhoodFreshWalletShadowRepository({ database: db }),
  }, { ...options, preflight, onProgress: (value) => console.log(JSON.stringify(value)) });
  console.log(JSON.stringify({ phase: 'complete', ...progress }));
}

if (require.main === module) main().catch((error) => {
  console.error(JSON.stringify({ error: error.code || 'fresh_seed_failed', message: error.message }));
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = { main, parseArgs };
