require('dotenv').config();

const db = require('../models/db');
const {
  createRobinhoodWalletTransferRetentionReadiness,
} = require('../models/robinhood-wallet-transfer-retention-readiness');
const { parseArgs } = require('./plan-robinhood-wallet-transfer-retention');

async function main(argv = process.argv.slice(2), deps = {}) {
  const input = parseArgs(argv);
  const auditor = (deps.auditorFactory || createRobinhoodWalletTransferRetentionReadiness)({
    database: deps.database || db,
  });
  const report = await auditor.inspect({
    ...input,
    now: typeof deps.now === 'function' ? deps.now() : new Date(),
  });
  (deps.logger || console).log(JSON.stringify(report, null, 2));
  return report;
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Robinhood transfer retention readiness audit failed:', error.message);
    process.exitCode = 1;
  }).finally(() => db.pool.end().catch(() => {}));
}

module.exports = { main };
