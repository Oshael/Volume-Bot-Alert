'use strict';

require('dotenv').config();
const db = require('../models/db');
const {
  createRobinhoodCanonicalHolderAudit,
} = require('../services/robinhood-canonical-holder-audit');

async function main(argv = process.argv.slice(2), deps = {}) {
  if (argv.length) throw new Error(`unknown argument: ${argv[0]}`);
  const audit = deps.audit || createRobinhoodCanonicalHolderAudit({
    database: deps.database || db,
  });
  const report = await audit.inspect();
  (deps.logger || console).log(JSON.stringify(report, null, 2));
  return report;
}

if (require.main === module) main().then((report) => {
  if (!report.ready) process.exitCode = 2;
}).catch((error) => {
  console.error('Robinhood canonical holder audit failed:', error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = { main };
