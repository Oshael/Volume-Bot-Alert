'use strict';

require('dotenv').config();

const { readFileSync } = require('node:fs');
const db = require('../models/db');
const { PILOT_DAY, createRobinhoodWalletTransferRetentionPilot } =
  require('../models/robinhood-wallet-transfer-retention-pilot');

const CONFIRM_FLAG = '--confirm-drop-robinhood-transfer-raw-2026-07-19';

function parseArgs(argv) {
  const input = {};
  for (const argument of argv) {
    if (argument.startsWith('--day=')) input.day = argument.slice(6);
    else if (argument.startsWith('--expected-watermark-version=')) {
      input.expectedWatermarkVersion = argument.slice(29);
    } else if (argument.startsWith('--expected-checkpoint-hash=')) {
      input.expectedCheckpointHash = argument.slice(27);
    } else if (argument.startsWith('--pilot-report=')) input.pilotReportPath = argument.slice(15);
    else if (argument === '--apply') input.apply = true;
    else if (argument === CONFIRM_FLAG) input.confirmed = true;
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (input.day !== PILOT_DAY || input.apply !== true || input.confirmed !== true
      || !input.pilotReportPath || !input.expectedWatermarkVersion
      || !input.expectedCheckpointHash) {
    throw new Error(`pilot requires --day=${PILOT_DAY}, watermark version, checkpoint hash, `
      + `--pilot-report=FILE, --apply and ${CONFIRM_FLAG}`);
  }
  return input;
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const input = parseArgs(argv);
  const pilotReport = JSON.parse((deps.readFile || readFileSync)(input.pilotReportPath, 'utf8'));
  const pilot = (deps.pilotFactory || createRobinhoodWalletTransferRetentionPilot)({
    database: deps.database || db,
  });
  const result = await pilot.drop({ ...input, pilotReport });
  (deps.logger || console).log(JSON.stringify(result));
  return result;
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Robinhood transfer retention pilot failed:', error.message);
    process.exitCode = 1;
  }).finally(() => db.pool.end().catch(() => {}));
}

module.exports = { CONFIRM_FLAG, main, parseArgs };
