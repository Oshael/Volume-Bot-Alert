'use strict';

/** Stage 251: reuse durable redistribution anchors after raw block retention. */
const db = require('../models/db');
const { CAPTURE_ANCHOR_SQL } = require('./db-init-stage241');

const STATEMENTS = Object.freeze([
  CAPTURE_ANCHOR_SQL,
  `UPDATE robinhood_bundle_redistribution_activations activation
      SET observation_from_hash = observation_from_hash
    WHERE activation.chain = 'robinhood'
      AND activation.status IN ('active', 'retired')
      AND activation.observation_from_hash IS NULL
      AND 1 = (SELECT COUNT(*) FROM robinhood_chain_block_anchors anchor
        WHERE anchor.chain = activation.chain
          AND anchor.block_number = activation.activation_block + 1)`,
  `UPDATE robinhood_bundle_redistribution_queue queue
      SET observation_from_block = observation_from_block
    WHERE queue.chain = 'robinhood'
      AND queue.observation_from_hash IS NULL
      AND 1 = (SELECT COUNT(*) FROM robinhood_chain_block_anchors anchor
        WHERE anchor.chain = queue.chain
          AND anchor.block_number = queue.observation_from_block)`,
]);

async function init(options = {}) {
  const database = options.database || db;
  let client;
  try {
    client = await database.getClient();
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    const counts = [];
    for (const statement of STATEMENTS) {
      const result = await client.query(statement);
      counts.push(result.rowCount || 0);
    }
    await client.query('COMMIT');
    return { activationsHydrated: counts[1], queuesHydrated: counts[2] };
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client?.release();
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().then((result) => {
  console.log(JSON.stringify(result));
}).catch((error) => {
  console.error('Failed to apply Stage 251:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
