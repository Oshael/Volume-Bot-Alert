'use strict';

require('dotenv').config();
const db = require('../models/db');
const {
  createRobinhoodCanonicalDirectCreatorAudit,
} = require('../services/robinhood-canonical-direct-creator-audit');

function parseArgs(argv = []) {
  if (argv.length) throw new Error(`unknown argument: ${argv[0]}`);
  return Object.freeze({});
}

async function main(argv = process.argv.slice(2), deps = {}) {
  parseArgs(argv);
  const audit = deps.audit || createRobinhoodCanonicalDirectCreatorAudit({
    database: deps.database || db,
  });
  const report = await audit.inspect();
  (deps.logger || console).log(JSON.stringify(report, null, 2));
  return report;
}

if (require.main === module) main().then((report) => {
  if (!report.ready) process.exitCode = 2;
}).catch((error) => {
  console.error('Robinhood canonical direct-creator audit failed:', error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = { main, parseArgs };
