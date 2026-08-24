require('dotenv').config();

const db = require('../models/db');
const {
  createRobinhoodWalletPositionCoverageAuditor,
} = require('../models/robinhood-wallet-position-coverage-audit');

function parseArgs(argv = []) {
  if (argv.length > 0) throw new Error(`unknown argument: ${argv[0]}`);
  return Object.freeze({});
}

async function main(argv = process.argv.slice(2), deps = {}) {
  parseArgs(argv);
  const auditor = (deps.auditorFactory || createRobinhoodWalletPositionCoverageAuditor)({
    database: deps.database || db,
  });
  const result = await auditor.audit();
  (deps.logger || console).log(JSON.stringify(result, null, 2));
  return result;
}

if (require.main === module) main().catch((error) => {
  console.error('Robinhood wallet-position coverage audit failed:', error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = { main, parseArgs };
