require('dotenv').config();

const db = require('../models/db');
const {
  createRobinhoodWalletTransferRetentionPlanner,
} = require('../models/robinhood-wallet-transfer-retention-plan');

const FLAGS = Object.freeze({
  '--projection-version=': 'projectionVersion',
  '--limit=': 'limit',
});

function parseArgs(argv = []) {
  const parsed = {};
  for (const arg of argv) {
    const prefix = Object.keys(FLAGS).find((candidate) => arg.startsWith(candidate));
    if (!prefix) throw new Error(`unknown argument: ${arg}`);
    const key = FLAGS[prefix];
    if (parsed[key] != null) throw new Error(`${prefix.slice(0, -1)} cannot be repeated`);
    const value = arg.slice(prefix.length).trim();
    if (!value) throw new Error(`${prefix.slice(0, -1)} requires a value`);
    parsed[key] = value;
  }
  if (!parsed.projectionVersion) throw new Error('--projection-version is required');
  return parsed;
}
async function main(argv = process.argv.slice(2), deps = {}) {
  const input = parseArgs(argv);
  const planner = (deps.plannerFactory || createRobinhoodWalletTransferRetentionPlanner)({
    database: deps.database || db,
  });
  const plan = await planner.plan({
    ...input,
    now: typeof deps.now === 'function' ? deps.now() : new Date(),
  });
  const report = { mode: 'dry-run', ...plan };
  (deps.logger || console).log(JSON.stringify(report, null, 2));
  return report;
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Robinhood transfer retention plan failed:', error.message);
    process.exitCode = 1;
  }).finally(() => db.pool.end().catch(() => {}));
}

module.exports = { main, parseArgs };
