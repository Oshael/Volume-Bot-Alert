'use strict';

require('dotenv').config();
const db = require('../models/db');
const {
  createRobinhoodHolderUniversalRestore,
} = require('../services/robinhood-holder-universal-restore');

function parseArgs(argv = process.argv.slice(2)) {
  const options = { apply: false };
  for (const arg of argv) {
    if (arg === '--apply') options.apply = true;
    else if (arg.startsWith('--from=')) options.fromBlock = arg.slice('--from='.length);
    else if (arg.startsWith('--to=')) options.toBlock = arg.slice('--to='.length);
    else throw new Error(`unknown option: ${arg}`);
  }
  if (options.fromBlock == null || options.toBlock == null) {
    throw new Error('--from and --to are required');
  }
  return options;
}

async function main(deps = {}) {
  const options = parseArgs(deps.argv);
  const restore = deps.restore || createRobinhoodHolderUniversalRestore({
    database: deps.database || db,
  });
  const result = await restore.restoreRange(options);
  (deps.logger || console).log(JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module) main().catch((error) => {
  console.error('Robinhood holder universal restore failed:', error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = { main, parseArgs };
