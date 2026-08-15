require('dotenv').config();

const db = require('../models/db');
const {
  createRobinhoodWalletTransferLiveSourceRepository,
} = require('../models/robinhood-wallet-transfer-live-source');
const {
  createRobinhoodWalletTransferReclassificationRepository,
} = require('../models/robinhood-wallet-transfer-reclassification');
const {
  runRobinhoodWalletTransferReclassification,
} = require('../services/robinhood-wallet-transfer-reclassification');

const CONFIRM_FLAG = '--confirm-reclassify-robinhood-wallet-transfers';
const DAY_PREFIX = '--day=';
const LIMIT_PREFIX = '--limit=';

function parseArgs(argv = []) {
  const days = argv.filter((arg) => arg.startsWith(DAY_PREFIX));
  const limits = argv.filter((arg) => arg.startsWith(LIMIT_PREFIX));
  const unknown = argv.filter((arg) => (
    arg !== CONFIRM_FLAG && !arg.startsWith(DAY_PREFIX) && !arg.startsWith(LIMIT_PREFIX)
  ));
  if (unknown.length) throw new Error(`unknown argument: ${unknown[0]}`);
  if (days.length !== 1) throw new Error('--day must be provided exactly once');
  if (limits.length > 1) throw new Error('--limit cannot be repeated');
  if (argv.filter((arg) => arg === CONFIRM_FLAG).length > 1) {
    throw new Error(`${CONFIRM_FLAG} cannot be repeated`);
  }
  const day = days[0].slice(DAY_PREFIX.length);
  const date = new Date(`${day}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(date.getTime())
      || date.toISOString().slice(0, 10) !== day) throw new Error('--day must be a valid UTC day');
  const limit = limits.length ? Number(limits[0].slice(LIMIT_PREFIX.length)) : 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error('--limit must be between 1 and 1000');
  }
  return Object.freeze({ confirm: argv.includes(CONFIRM_FLAG), day, limit });
}

async function buildRuntime(deps = {}) {
  if (!String((deps.env || process.env).DATABASE_URL || '').trim()) {
    throw new Error('missing required env DATABASE_URL');
  }
  const database = deps.database || db;
  const schema = await database.query(
    `SELECT to_regclass('robinhood_token_transfer_events') AS events,
            to_regclass('robinhood_wallet_endpoint_roles') AS roles,
            to_regclass('robinhood_wallet_transfer_reclassifications') AS audits,
            to_regclass('robinhood_wallet_transfer_edges') AS edges,
            to_regclass('robinhood_wallet_relationship_evidence') AS evidence,
            to_regclass('robinhood_wallet_transfer_daily_summaries') AS summaries,
            to_regclass('robinhood_wallet_transfer_compaction_watermarks') AS watermarks`
  );
  const tables = Object.values(schema.rows[0] || {});
  if (tables.length !== 7 || tables.some((value) => !value)) {
    throw new Error('schema not ready: apply Stages 128, 129, 131, 132, 135 and 136');
  }
  return Object.freeze({
    repository: (deps.repositoryFactory
      || createRobinhoodWalletTransferReclassificationRepository)({ database }),
    source: (deps.sourceFactory
      || createRobinhoodWalletTransferLiveSourceRepository)({ database }),
  });
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const args = parseArgs(argv);
  const runtime = deps.runtime || await (deps.runtimeFactory || buildRuntime)(deps);
  const result = await (deps.runReclassification
    || runRobinhoodWalletTransferReclassification)(runtime, {
    day: args.day, limit: args.limit, commit: args.confirm,
  });
  const report = Object.freeze({ mode: args.confirm ? 'confirmed' : 'dry-run', result });
  const logger = deps.logger || console;
  logger.log(JSON.stringify(report, null, 2));
  if (!args.confirm) {
    logger.log(`No data changed. Re-run with ${CONFIRM_FLAG} after review.`);
  }
  return report;
}

if (require.main === module) main().catch((error) => {
  console.error('Robinhood wallet transfer reclassification failed:', error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = { CONFIRM_FLAG, buildRuntime, main, parseArgs };
