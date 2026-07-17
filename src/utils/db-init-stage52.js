/**
 * Stage 52 - Additive chain identity for user token, risk, and alert domains.
 * Run with: node src/utils/db-init-stage52.js
 */
const db = require('../models/db');

const CHAIN_TABLES = Object.freeze([
  'user_tokens',
  'user_blocklist',
  'user_starred_tokens',
  'user_pinned_monitored_tokens',
  'user_bootstrap_tokens',
  'user_token_folder_items',
  'token_risk_enrichment',
  'token_risk_reviews',
  'token_junk_evidence',
  'bid_zone_results',
  'user_alert_rule_state',
  'user_alert_events',
  'admin_block_evidence',
  'monitored_token_exit_events',
  'user_custom_alert_rules',
  'admin_token_review_alerts',
]);

const STATEMENTS = [
  `DO $migration$
   DECLARE table_name TEXT;
   DECLARE chain_not_null BOOLEAN;
   BEGIN
     FOREACH table_name IN ARRAY ARRAY[
       'user_tokens', 'user_blocklist', 'user_starred_tokens',
       'user_pinned_monitored_tokens', 'user_bootstrap_tokens',
       'user_token_folder_items', 'token_risk_enrichment',
       'token_risk_reviews', 'token_junk_evidence', 'bid_zone_results',
       'user_alert_rule_state', 'user_alert_events', 'admin_block_evidence',
       'monitored_token_exit_events', 'user_custom_alert_rules',
       'admin_token_review_alerts'
     ] LOOP
       EXECUTE format(
         'ALTER TABLE %I ADD COLUMN IF NOT EXISTS chain VARCHAR(16) NOT NULL DEFAULT ''solana''',
         table_name
       );
       SELECT attribute.attnotnull INTO chain_not_null
         FROM pg_attribute attribute
        WHERE attribute.attrelid = table_name::regclass
          AND attribute.attname = 'chain'
          AND NOT attribute.attisdropped;
       IF NOT chain_not_null THEN
         EXECUTE format('UPDATE %I SET chain = ''solana'' WHERE chain IS NULL', table_name);
       END IF;
       EXECUTE format(
         'ALTER TABLE %I ALTER COLUMN chain SET DEFAULT ''solana'', ALTER COLUMN chain SET NOT NULL',
         table_name
       );
     END LOOP;
   END
   $migration$`,
  `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_user_tokens_chain_identity
     ON user_tokens(user_id, chain, address)`,
  `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_user_blocklist_chain_identity
     ON user_blocklist(user_id, chain, address)`,
  `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_user_starred_tokens_chain_identity
     ON user_starred_tokens(user_id, chain, address)`,
  `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_user_pinned_tokens_chain_identity
     ON user_pinned_monitored_tokens(user_id, chain, address)`,
  `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_user_bootstrap_tokens_chain_identity
     ON user_bootstrap_tokens(user_id, chain, address)`,
  `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_user_token_folder_items_chain_identity
     ON user_token_folder_items(user_id, folder_id, chain, address)`,
  `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_token_risk_enrichment_chain_identity
     ON token_risk_enrichment(chain, token_address)`,
  `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_token_risk_reviews_chain_identity
     ON token_risk_reviews(chain, token_address)`,
  `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_token_junk_evidence_chain_identity
     ON token_junk_evidence(chain, token_address, assessment_fingerprint)`,
  `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_bid_zone_results_chain_identity
     ON bid_zone_results(run_id, chain, token_address)`,
  `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_user_alert_rule_state_chain_identity
     ON user_alert_rule_state(user_id, rule_key, chain, token_address)`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_alert_events_chain_token
     ON user_alert_events(user_id, chain, token_address, triggered_at DESC, id DESC)`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_admin_block_evidence_chain_token
     ON admin_block_evidence(chain, token_address, created_at DESC, id DESC)`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_monitored_exit_events_chain_token
     ON monitored_token_exit_events(chain, token_address, created_at DESC, id DESC)`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_custom_alert_rules_chain_token
     ON user_custom_alert_rules(user_id, chain, token_address, status, updated_at DESC)`,
  `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_admin_review_alerts_open_chain_token_kind
     ON admin_token_review_alerts(chain, token_address, alert_kind)
     WHERE status = 'open'`,
  `DO $migration$
   BEGIN
     IF to_regclass('admin_blocked_tokens') IS NOT NULL THEN
       ALTER TABLE admin_blocked_tokens
         ADD COLUMN IF NOT EXISTS chain VARCHAR(16) NOT NULL DEFAULT 'solana';
       UPDATE admin_blocked_tokens SET chain = 'solana' WHERE chain IS NULL;
       ALTER TABLE admin_blocked_tokens
         ALTER COLUMN chain SET DEFAULT 'solana',
         ALTER COLUMN chain SET NOT NULL;
       CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_blocked_tokens_chain_address
         ON admin_blocked_tokens(chain, address);
     END IF;
   END
   $migration$`,
];

async function init(options = {}) {
  const closePool = options.closePool !== false;
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 52 chain-aware user, risk, and alert schema applied successfully');
  } catch (error) {
    console.error('Failed to apply stage 52 chain-aware schema:', error.message);
    process.exitCode = 1;
    throw error;
  } finally {
    if (closePool) {
      try { await db.pool.end(); } catch (_) {}
    }
  }
}

if (require.main === module) {
  init().catch(() => {});
}

module.exports = { CHAIN_TABLES, STATEMENTS, init };
