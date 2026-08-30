require('dotenv').config();

const db = require('../models/db');
const {
  createRobinhoodWalletTransferSummaryRepair,
} = require('../models/robinhood-wallet-transfer-summary-repair');

const APPLY_FLAG = '--apply';
const CONFIRM_FLAG = '--confirm-rebuild-robinhood-transfer-summary';
const FLAGS = Object.freeze({
  '--day=': 'partitionDay',
  '--projection-version=': 'projectionVersion',
  '--statement-timeout-ms=': 'statementTimeoutMs',
});

function parseArgs(argv = []) {
  const parsed = { apply: false, confirm: false };
  for (const arg of argv) {
    if (arg === APPLY_FLAG || arg === CONFIRM_FLAG) {
      const key = arg === APPLY_FLAG ? 'apply' : 'confirm';
      if (parsed[key]) throw new Error(`${arg} cannot be repeated`);
      parsed[key] = true;
      continue;
    }
    const prefix = Object.keys(FLAGS).find((candidate) => arg.startsWith(candidate));
    if (!prefix) throw new Error(`unknown argument: ${arg}`);
    const key = FLAGS[prefix];
    if (parsed[key] != null) throw new Error(`${prefix.slice(0, -1)} cannot be repeated`);
    const value = arg.slice(prefix.length).trim();
    if (!value) throw new Error(`${prefix.slice(0, -1)} requires a value`);
    parsed[key] = value;
  }
  if (!parsed.partitionDay) throw new Error('--day is required');
  if (!parsed.projectionVersion) throw new Error('--projection-version is required');
  if (parsed.apply !== parsed.confirm) {
    throw new Error(`${APPLY_FLAG} and ${CONFIRM_FLAG} must be provided together`);
  }
  return parsed;
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const input = parseArgs(argv);
  const repair = (deps.repairFactory || createRobinhoodWalletTransferSummaryRepair)({
    database: deps.database || db,
  });
  const operation = input.apply ? repair.rebuildDay : repair.inspectDay;
  const result = await operation(input);
  const report = { mode: input.apply ? 'apply' : 'dry-run', ...result };
  (deps.logger || console).log(JSON.stringify(report, null, 2));
  if (!input.apply) {
    (deps.logger || console).log(
      `No data changed. Re-run with ${APPLY_FLAG} ${CONFIRM_FLAG} after review.`
    );
  }
  return report;
}

if (require.main === module) main().catch((error) => {
  console.error('Robinhood transfer summary repair failed:', error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = { APPLY_FLAG, CONFIRM_FLAG, main, parseArgs };
