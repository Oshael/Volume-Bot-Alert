'use strict';

const db = require('../models/db');

const CANDIDATE_PREDICATE = `platform = 'pump'
  AND asset_raw_chain_id IS NULL
  AND asset_chain_key IS NULL
  AND asset_address_normalized IS NULL
  AND asset_resolution_status = 'unknown_chain'
  AND asset_address_original ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'`;

const COUNT_SQL = (table) => `SELECT COUNT(*)::int AS count FROM ${table}
WHERE ${CANDIDATE_PREDICATE}`;

const REPAIR_SQL = (table) => `UPDATE ${table}
SET asset_address_normalized = asset_address_original,
    asset_chain_key = 'solana',
    asset_chain_family = 'solana',
    asset_resolution_status = 'inferred_solana_address'
WHERE ${CANDIDATE_PREDICATE}`;

function parseArgs(argv = []) {
  let mode = 'dry-run';
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--mode') mode = argv[++index];
    else if (item.startsWith('--mode=')) mode = item.slice('--mode='.length);
    else throw new TypeError(`Unknown argument: ${item}`);
  }
  if (!['dry-run', 'write'].includes(mode)) {
    throw new TypeError('mode must be dry-run or write');
  }
  return Object.freeze({ mode });
}

async function candidateCounts(database) {
  const [archive, live] = await Promise.all([
    database.query(COUNT_SQL('callout_thesis_archive')),
    database.query(COUNT_SQL('callout_events')),
  ]);
  return {
    archive: Number(archive.rows[0]?.count || 0),
    live: Number(live.rows[0]?.count || 0),
  };
}

async function repairPumpSolanaCalloutChains(database = db, options = {}) {
  const mode = options.mode || 'dry-run';
  if (!['dry-run', 'write'].includes(mode)) throw new TypeError('Invalid repair mode');
  const candidates = await candidateCounts(database);
  if (mode === 'dry-run') return { mode, candidates, repaired: { archive: 0, live: 0 } };

  const client = await database.getClient();
  try {
    await client.query('BEGIN');
    const archive = await client.query(REPAIR_SQL('callout_thesis_archive'));
    const live = await client.query(REPAIR_SQL('callout_events'));
    await client.query('COMMIT');
    return {
      mode,
      candidates,
      repaired: { archive: archive.rowCount, live: live.rowCount },
    };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) { /* preserve original error */ }
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  try {
    console.log(JSON.stringify(
      await repairPumpSolanaCalloutChains(db, parseArgs(process.argv.slice(2))), null, 2
    ));
  } finally {
    await db.pool.end().catch(() => {});
  }
}

if (require.main === module) main().catch((error) => {
  console.error(JSON.stringify({ error: error.code || error.name, message: error.message }));
  process.exitCode = 1;
});

module.exports = {
  repairPumpSolanaCalloutChains,
  __private: { CANDIDATE_PREDICATE, COUNT_SQL, REPAIR_SQL, candidateCounts, parseArgs },
};
