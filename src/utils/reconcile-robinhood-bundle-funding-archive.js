'use strict';

require('dotenv').config();
const db = require('../models/db');
const {
  CONFIRM_FLAG, MAX_LIMIT, createRobinhoodBundleFundingArchiveReconciliation,
} = require('../models/robinhood-bundle-funding-archive-reconciliation');

function parseArgs(argv = process.argv.slice(2)) {
  const options = { apply: false, confirmed: false, limit: 100 };
  for (const argument of argv) {
    if (argument === '--apply') options.apply = true;
    else if (argument === CONFIRM_FLAG) options.confirmed = true;
    else if (/^--limit=\d+$/.test(argument)) options.limit = Number(argument.slice(8));
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > MAX_LIMIT) {
    throw new Error(`--limit must be between 1 and ${MAX_LIMIT}`);
  }
  if (options.confirmed && !options.apply) throw new Error(`${CONFIRM_FLAG} requires --apply`);
  if (options.apply && !options.confirmed) throw new Error(`--apply requires ${CONFIRM_FLAG}`);
  return Object.freeze(options);
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const options = parseArgs(argv);
  const reconciliation = deps.reconciliation
    || createRobinhoodBundleFundingArchiveReconciliation({ database: deps.database || db });
  const result = await reconciliation.run(options);
  (deps.logger || console).log(JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module) main().catch((error) => {
  console.error('[BundleFundingArchiveReconciliation] Fatal:', error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = { main, parseArgs };
