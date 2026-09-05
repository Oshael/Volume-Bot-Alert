'use strict';

require('dotenv').config();
const db = require('../models/db');
const {
  createRobinhoodCanonicalSignedOriginAudit,
} = require('../services/robinhood-canonical-signed-origin-audit');

function parseArgs(argv = []) {
  const unknown = argv.find((arg) => !arg.startsWith('--phase='));
  if (unknown) throw new Error(`unknown argument: ${unknown}`);
  return Object.freeze({
    phase: argv.find((arg) => arg.startsWith('--phase='))?.slice(8) || 'preflight',
  });
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const options = deps.options || parseArgs(argv);
  const audit = deps.audit || createRobinhoodCanonicalSignedOriginAudit({
    database: deps.database || db, phase: options.phase,
  });
  const report = await audit.inspect();
  (deps.logger || console).log(JSON.stringify(report, null, 2));
  return report;
}

if (require.main === module) main().then((report) => {
  if (!report.ready) process.exitCode = 2;
}).catch((error) => {
  console.error('Robinhood canonical signed-origin audit failed:', error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = { main, parseArgs };
