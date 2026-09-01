#!/usr/bin/env node
require('dotenv').config();

const db = require('../models/db');
const {
  createRobinhoodBundleRedistributionControlPlane,
} = require('../models/robinhood-bundle-redistribution-control-plane');

const LEAD_PREFIX = '--lead-blocks=';

function parseArgs(argv = process.argv.slice(2)) {
  let apply = false;
  let leadBlocks = 1000;
  let leadSeen = false;
  for (const argument of argv) {
    if (argument === '--apply' && !apply) apply = true;
    else if (argument.startsWith(LEAD_PREFIX) && !leadSeen) {
      leadSeen = true;
      leadBlocks = Number(argument.slice(LEAD_PREFIX.length));
      if (!Number.isSafeInteger(leadBlocks) || leadBlocks < 100 || leadBlocks > 100_000) {
        throw new Error('--lead-blocks must be between 100 and 100000');
      }
    } else throw new Error(`unknown or repeated argument: ${argument}`);
  }
  return Object.freeze({ apply, leadBlocks });
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const options = parseArgs(argv);
  const control = deps.control || (deps.controlFactory
    || createRobinhoodBundleRedistributionControlPlane)({ database: deps.database || db });
  const report = options.apply
    ? await control.apply({ leadBlocks: options.leadBlocks })
    : await control.inspect();
  (deps.logger || console).log(JSON.stringify(report, null, 2));
  return report;
}

if (require.main === module) main().catch((error) => {
  console.error(JSON.stringify({
    error: error.code || 'bundle_redistribution_activation_failed',
    message: error.message,
  }));
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = { main, parseArgs };
