require('dotenv').config();

const db = require('../models/db');
const { createRobinhoodWalletPositionRepository } = require('../models/robinhood-wallet-position');
const {
  DEFAULT_PROJECTION_VERSION,
  createRobinhoodWalletPositionProjector,
} = require('../services/robinhood-wallet-position-projector');

function required(value, label) {
  const result = String(value ?? '').trim();
  if (!result) throw new Error(`${label} is required when the cursor does not exist`);
  return result;
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 10_000) : fallback;
}

async function main() {
  const commit = process.argv.includes('--commit');
  const projectionVersion = process.env.ROBINHOOD_WALLET_POSITION_PROJECTION_VERSION
    || DEFAULT_PROJECTION_VERSION;
  const repository = createRobinhoodWalletPositionRepository();
  let cursor = await repository.loadCursor(projectionVersion, 'seed');
  if (!cursor) {
    const initial = {
      projectionVersion, stream: 'seed',
      nextBlock: required(process.env.ROBINHOOD_WALLET_POSITION_FROM_BLOCK, 'FROM_BLOCK'),
      nextBlockTime: required(process.env.ROBINHOOD_WALLET_POSITION_FROM_TIME, 'FROM_TIME'),
      safeHead: required(process.env.ROBINHOOD_WALLET_POSITION_SAFE_HEAD, 'SAFE_HEAD'),
      version: 0,
    };
    cursor = commit ? await repository.initCursor(initial) : initial;
  }
  const projector = createRobinhoodWalletPositionProjector({ repository });
  const maxBatches = positiveInteger(
    process.env.ROBINHOOD_WALLET_POSITION_MAX_BATCHES, commit ? 100 : 1
  );
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const report = await projector.runBatch({
      cursor, projectionVersion, stream: 'seed', commit,
      maxBlocks: process.env.ROBINHOOD_WALLET_POSITION_MAX_BLOCKS,
    });
    console.log(JSON.stringify({ batch: batch + 1, ...report }));
    if (!commit || report.complete || report.persisted?.committed !== true) break;
    cursor = report.persisted.cursor;
  }
  if (!commit) console.log('Dry-run only. Re-run with --commit to persist this batch.');
}

if (require.main === module) main().catch((error) => {
  console.error(`[RobinhoodWalletPositionBackfill] fatal: ${error.message}`);
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = { main };
