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

async function latestCompletedCatalogCutoff(database) {
  const result = await database.query(
    `SELECT catalog_cutoff
       FROM robinhood_holder_global_backfill_runs
      WHERE chain = 'robinhood' AND status = 'completed'
      ORDER BY id DESC
      LIMIT 1`
  );
  if (!result.rowCount) {
    const error = new Error('A completed Robinhood holder global run is required for this delta');
    error.code = 'holder_global_delta_completed_run_missing';
    throw error;
  }
  return new Date(result.rows[0].catalog_cutoff).toISOString();
}

async function runGlobalHolderDelta(input = {}) {
  const database = input.database || db;
  const repository = input.repository
    || createRobinhoodHolderGlobalDeltaRepository({ database });
  const catalogFloor = input.sinceLatestCompletedRun === true
    ? await latestCompletedCatalogCutoff(database) : input.catalogFloor;
  const candidateInput = {
    catalogCutoff: input.catalogCutoff,
    includeUnseeded: input.includeUnseeded !== false,
  };
  if (catalogFloor != null) candidateInput.catalogFloor = catalogFloor;
  if (input.maximumGapBlocks != null) {
    candidateInput.maximumGapBlocks = input.maximumGapBlocks;
  }
  const preview = await repository.previewRun(candidateInput);
  const incrementalBackfillActive = await backfillLeaseActive(database);
  if (input.confirm !== true) {
    return Object.freeze({
      mode: 'dry-run',
      selection: candidateInput.includeUnseeded
        ? 'unseeded-and-backfilling' : 'backfilling-only',
      catalogFloor: candidateInput.catalogFloor || null,
      maxScanBlocks: candidateInput.maximumGapBlocks == null
        ? null : Number(candidateInput.maximumGapBlocks),
      incrementalBackfillActive,
      preview,
    });
  }
  if (incrementalBackfillActive) {
    const error = new Error('Stop the incremental holder backfill lease before confirming delta');
    error.code = 'holder_global_delta_incremental_active';
    throw error;
  }
  return Object.freeze({
    mode: 'confirmed', before: preview,
    created: await repository.createRun(candidateInput),
  });
}

async function main() {
  try {
    const maximumGapArgument = process.argv.find(
      (argument) => argument.startsWith('--max-scan-blocks=')
    );
    console.log(JSON.stringify(await runGlobalHolderDelta({
      catalogCutoff: process.env.ROBINHOOD_HOLDER_GLOBAL_DELTA_CATALOG_CUTOFF,
      includeUnseeded: !process.argv.includes('--backfilling-only'),
      sinceLatestCompletedRun: process.argv.includes('--since-latest-completed-run'),
      maximumGapBlocks: maximumGapArgument?.slice('--max-scan-blocks='.length),
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

module.exports = {
  runGlobalHolderDelta,
  __private: { backfillLeaseActive, latestCompletedCatalogCutoff },
};
