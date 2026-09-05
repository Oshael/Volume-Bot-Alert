'use strict';

require('dotenv').config();
const db = require('../models/db');
const {
  createRobinhoodCanonicalWalletTransferAudit,
} = require('../services/robinhood-canonical-wallet-transfer-audit');

function parseArgs(argv = []) {
  const unknown = argv.find((arg) => !arg.startsWith('--phase='));
  if (unknown) throw new Error(`unknown argument: ${unknown}`);
  const phase = argv.find((arg) => arg.startsWith('--phase='))?.slice(8) || 'preflight';
  if (!['preflight', 'cutover'].includes(phase)) {
    throw new Error('--phase must be preflight or cutover');
  }
  return Object.freeze({
    phase,
  });
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const options = deps.options || parseArgs(argv);
  const audit = deps.audit || createRobinhoodCanonicalWalletTransferAudit({
    database: deps.database || db, phase: options.phase,
  });
  const report = await audit.inspect();
  (deps.logger || console).log(JSON.stringify(report, null, 2));
  return report;
}

if (require.main === module) main().catch((error) => {
  console.error('Robinhood canonical wallet-transfer audit failed:', error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = { main, parseArgs };
