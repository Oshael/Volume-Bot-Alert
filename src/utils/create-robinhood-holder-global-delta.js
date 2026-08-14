require('dotenv').config();

const db = require('../models/db');
const {
  createRobinhoodHolderGlobalDeltaRepository,
} = require('../models/robinhood-holder-global-delta');

async function backfillLeaseActive(database) {
  const result = await database.query(
    `SELECT lease_until > NOW() AS active
       FROM worker_leases
      WHERE lease_key = 'robinhood-holder-backfill-worker'`
  );
  return result.rows[0]?.active === true;
}

async function runGlobalHolderDelta(input = {}) {
  const database = input.database || db;
  const repository = input.repository
    || createRobinhoodHolderGlobalDeltaRepository({ database });
  const preview = await repository.previewRun({ catalogCutoff: input.catalogCutoff });
  const incrementalBackfillActive = await backfillLeaseActive(database);
  if (input.confirm !== true) {
    return Object.freeze({ mode: 'dry-run', incrementalBackfillActive, preview });
  }
  if (incrementalBackfillActive) {
    const error = new Error('Stop the incremental holder backfill lease before confirming delta');
    error.code = 'holder_global_delta_incremental_active';
    throw error;
  }
  return Object.freeze({
    mode: 'confirmed', before: preview,
    created: await repository.createRun({ catalogCutoff: input.catalogCutoff }),
  });
}

async function main() {
  try {
    console.log(JSON.stringify(await runGlobalHolderDelta({
      catalogCutoff: process.env.ROBINHOOD_HOLDER_GLOBAL_DELTA_CATALOG_CUTOFF,
      confirm: process.argv.includes('--confirm-create'),
    }), null, 2));
  } finally {
    await db.pool.end().catch(() => {});
  }
}

if (require.main === module) main().catch((error) => {
  console.error(`[RobinhoodGlobalHolderDelta] Failed [${error.code || 'error'}]:`, error.message);
  process.exitCode = 1;
});

module.exports = { runGlobalHolderDelta, __private: { backfillLeaseActive } };
