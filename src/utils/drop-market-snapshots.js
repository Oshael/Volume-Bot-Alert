const db = require('../models/db');

const CONFIRM_FLAG = '--confirm-drop';

async function main() {
  if (!process.argv.includes(CONFIRM_FLAG)) {
    console.log('Snapshot drop not executed.');
    console.log(`Run with ${CONFIRM_FLAG} to drop token_market_snapshots and its indexes.`);
    return;
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await client.query('DROP INDEX IF EXISTS idx_token_market_snapshots_addr_ts');
    await client.query('DROP INDEX IF EXISTS idx_token_market_snapshots_ts');
    await client.query('DROP TABLE IF EXISTS token_market_snapshots');
    await client.query('COMMIT');
    console.log('Dropped token_market_snapshots and legacy indexes.');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await db.pool.end();
  }
}

main().catch((err) => {
  console.error('Failed to drop token_market_snapshots:', err.message);
  process.exitCode = 1;
});
