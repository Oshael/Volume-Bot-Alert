'use strict';

const db = require('../models/db');
const { inspectScopeBaseline, prepareScopeBaseline } = require('../models/robinhood-wallet-transfer-scope-membership');

async function main(argv = process.argv.slice(2), database = db) {
  const options = {};
  let commit = false;
  for (const argument of argv) {
    if (argument === '--commit') { commit = true; continue; }
    const match = /^--(stream|projection-version|batch-size)=(.+)$/.exec(argument);
    if (!match) throw new Error(`unknown argument: ${argument}`);
    const key = { stream: 'stream', 'projection-version': 'projectionVersion', 'batch-size': 'batchSize' }[match[1]];
    if (Object.hasOwn(options, key)) throw new Error(`repeated argument: ${match[1]}`);
    options[key] = match[2];
  }
  const result = commit
    ? await prepareScopeBaseline(database, options) : await inspectScopeBaseline(database, options);
  console.log(JSON.stringify({ mode: commit ? 'one-batch' : 'inspection', ...result }, null, 2));
  return result;
}

if (require.main === module) main().catch((error) => {
  console.error('Transfer scope baseline failed:', error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end());
module.exports = { main };
