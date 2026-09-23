'use strict';

require('dotenv').config();

const db = require('../models/db');
const {
  createRobinhoodWalletTransferEvidenceMigration,
} = require('../models/robinhood-wallet-transfer-evidence-migration');

const CONFIRM_FLAG = '--confirm-migrate-robinhood-wallet-transfer-evidence';

function parseArgs(argv) {
  const input = {};
  for (const argument of argv) {
    if (argument.startsWith('--day=')) input.day = argument.slice(6);
    else if (argument.startsWith('--batch-size=')) input.batchSize = argument.slice(13);
    else if (argument.startsWith('--max-batches=')) input.maxBatches = argument.slice(14);
    else if (argument.startsWith('--after=')) input.after = argument.slice(8);
    else if (argument === '--apply') input.apply = true;
    else if (argument === CONFIRM_FLAG) input.confirmed = true;
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (input.apply === true && input.confirmed !== true) {
    throw new Error(`--apply requires ${CONFIRM_FLAG}`);
  }
  if (input.confirmed === true && input.apply !== true) {
    throw new Error(`${CONFIRM_FLAG} requires --apply`);
  }
  return input;
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const input = parseArgs(argv);
  const logger = deps.logger || console;
  const migration = (deps.migrationFactory || createRobinhoodWalletTransferEvidenceMigration)({
    database: deps.database || db,
  });
  const result = await migration.run({ ...input, onBatch: (batch) => {
    logger.log(JSON.stringify(batch));
  } });
  logger.log(JSON.stringify(result));
  return result;
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Robinhood transfer evidence migration failed:', error.message);
    process.exitCode = 1;
  }).finally(() => db.pool.end().catch(() => {}));
}

module.exports = { CONFIRM_FLAG, main, parseArgs };
