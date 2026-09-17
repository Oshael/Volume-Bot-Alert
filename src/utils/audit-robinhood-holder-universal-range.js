'use strict';

require('dotenv').config();
const db = require('../models/db');
const {
  createRobinhoodHolderUniversalCoverageAudit,
} = require('../services/robinhood-holder-universal-coverage-audit');

function parseArgs(argv = process.argv.slice(2)) {
  const options = {};
  for (const arg of argv) {
    if (arg.startsWith('--from=')) options.fromBlock = arg.slice('--from='.length);
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
  const audit = deps.audit || createRobinhoodHolderUniversalCoverageAudit({
    database: deps.database || db,
  });
  const result = await audit.inspectRange(options);
  (deps.logger || console).log(JSON.stringify(result, null, 2));
  if (!result.rangeComplete) process.exitCode = 2;
  return result;
}

if (require.main === module) main().catch((error) => {
  console.error('Robinhood holder universal range audit failed:', error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = { main, parseArgs };
