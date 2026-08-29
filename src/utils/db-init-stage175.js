/** Stage 175 - public token-scoped BUNDLED holder tag contract. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `ALTER TABLE robinhood_holder_classifications
     DROP CONSTRAINT IF EXISTS rh_holder_classifications_reason_check,
     ADD CONSTRAINT rh_holder_classifications_reason_check CHECK (
       (tag = 'lp' AND reason_code IN ('registered_token_pool', 'registered_v4_pool_manager'))
       OR (tag = 'cex' AND reason_code = 'known_cex_address')
       OR (tag = 'sniper' AND reason_code = 'early_launch_buy')
       OR (tag = 'bundled' AND reason_code = 'connected_funding_launch_cluster')
       OR (tag = 'fresh' AND reason_code = 'new_wallet_at_first_buy')
       OR (tag = 'insider' AND reason_code IN (
         'creator_token_distribution', 'creator_direct_funding'
       ))
     )`,
  `ALTER TABLE robinhood_holder_classification_states
     DROP CONSTRAINT IF EXISTS rh_holder_classification_states_classifier_check,
     ADD CONSTRAINT rh_holder_classification_states_classifier_check CHECK (
       classifier IN ('lp', 'cex', 'sniper', 'bundled', 'fresh', 'insider')
     )`,
]);

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 175 Robinhood public BUNDLED contract created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 175:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
