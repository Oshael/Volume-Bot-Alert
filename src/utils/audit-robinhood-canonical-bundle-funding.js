'use strict';

require('dotenv').config();
const db = require('../models/db');
const {
  createRobinhoodCanonicalBundleFundingAudit,
} = require('../services/robinhood-canonical-bundle-funding-audit');

function parseArgs(argv = []) {
  let phase = 'preflight';
  for (const arg of argv) {
    if (!arg.startsWith('--phase=')) throw new Error(`unknown argument: ${arg}`);
    phase = arg.slice('--phase='.length);
  }
  if (!['preflight', 'cutover'].includes(phase)) throw new Error(`invalid phase: ${phase}`);
  return Object.freeze({ phase });
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const options = parseArgs(argv);
  const audit = deps.audit || createRobinhoodCanonicalBundleFundingAudit({
    database: deps.database || db,
  });
  const report = await audit.inspect(options);
  (deps.logger || console).log(JSON.stringify(report, null, 2));
  return report;
}

if (require.main === module) main().then((report) => {
  if (!report.ready) process.exitCode = 2;
}).catch((error) => {
  console.error('Robinhood canonical bundle-funding audit failed:', error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = { main, parseArgs };
