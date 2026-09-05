'use strict';

require('dotenv').config();
const db = require('../models/db');
const {
  PHASES, createRobinhoodCanonicalHolderAudit,
} = require('../services/robinhood-canonical-holder-audit');

function parseArgs(argv = []) {
  const unknown = argv.find((arg) => !arg.startsWith('--phase='));
  if (unknown) throw new Error(`unknown argument: ${unknown}`);
  const phaseArg = argv.find((arg) => arg.startsWith('--phase='));
  const phase = phaseArg ? phaseArg.slice('--phase='.length).trim().toLowerCase() : 'preflight';
  if (!PHASES.includes(phase)) throw new Error(`--phase must be ${PHASES.join(' or ')}`);
  return Object.freeze({ phase });
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const options = deps.options || parseArgs(argv);
  const audit = deps.audit || createRobinhoodCanonicalHolderAudit({
    database: deps.database || db, phase: options.phase,
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

module.exports = { main, parseArgs };
