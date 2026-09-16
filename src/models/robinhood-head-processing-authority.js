'use strict';

const {
  createRobinhoodHeadProcessingRepository,
} = require('./robinhood-head-processing');
const {
  createRobinhoodHeadProcessingStateRepository,
} = require('./robinhood-head-processing-state');

const CHAIN = 'robinhood';
const REQUIRED_STATE_INDEXES = Object.freeze([
  'idx_rh_head_capture_states_claim',
  'idx_rh_head_capture_states_lease',
  'idx_rh_head_capture_states_retention_v2',
  'idx_rh_head_capture_states_v4_active_frontier',
  'idx_rh_head_capture_states_market_independent_claim',
  'idx_rh_head_capture_states_discovery_claim',
  'idx_rh_head_capture_states_active_frontier',
  'idx_rh_head_capture_states_blocked_recovery',
]);

async function loadHeadProcessingAuthority(database) {
  const result = await database.query(
    `SELECT authority, generation, activated_at, activation_report
       FROM robinhood_head_processing_authority WHERE chain=$1`,
    [CHAIN]
  );
  const row = result.rows[0];
  if (!row || !['legacy', 'state'].includes(row.authority)) {
    throw new Error('Robinhood head processing authority is missing or invalid');
  }
  return row;
}

async function inspectStateRuntimePrerequisites(database) {
  const result = await database.query(
    `WITH expected(name) AS (SELECT unnest($1::text[])), indexes AS (
       SELECT expected.name, index.indisvalid, index.indisready
         FROM expected
         LEFT JOIN pg_class relation ON relation.relname=expected.name
           AND relation.relnamespace='public'::regnamespace
         LEFT JOIN pg_index index ON index.indexrelid=relation.oid
     ), mirror AS (
       SELECT item.tgenabled, pg_get_triggerdef(item.oid) AS definition
         FROM pg_trigger item
        WHERE item.tgname='rh_head_capture_state_sync'
          AND item.tgrelid=to_regclass('public.robinhood_head_captures')
          AND NOT item.tgisinternal
     )
     SELECT ARRAY(SELECT name FROM indexes
                   WHERE NOT COALESCE(indisvalid, false) OR NOT COALESCE(indisready, false)
                   ORDER BY name) AS invalid_indexes,
            COALESCE((SELECT tgenabled <> 'D' FROM mirror), false) AS trigger_enabled,
            COALESCE((SELECT definition ~* 'AFTER INSERT ON' FROM mirror), false)
              AS trigger_insert_only`,
    [REQUIRED_STATE_INDEXES]
  );
  const row = result.rows[0] || {};
  const blockers = [];
  if ((row.invalid_indexes || []).length) {
    blockers.push(`invalid indexes: ${row.invalid_indexes.join(', ')}`);
  }
  if (!row.trigger_enabled) blockers.push('head state sync trigger is disabled or missing');
  if (!row.trigger_insert_only) blockers.push('head state sync trigger is not insert-only');
  return { safe: blockers.length === 0, blockers };
}

async function selectHeadProcessingRepository(options = {}) {
  const { database } = options;
  if (!database) throw new Error('database is required');
  const authority = await loadHeadProcessingAuthority(database);
  if (authority.authority === 'legacy') {
    const factory = options.legacyFactory || createRobinhoodHeadProcessingRepository;
    return { authority, repository: factory({ database }) };
  }
  if (!authority.activated_at || !authority.activation_report) {
    throw new Error('State authority is missing its durable activation evidence');
  }
  const gate = await inspectStateRuntimePrerequisites(database);
  if (!gate.safe) {
    throw new Error(`State authority runtime gate failed: ${gate.blockers.join('; ')}`);
  }
  const factory = options.stateFactory || createRobinhoodHeadProcessingStateRepository;
  return { authority, repository: factory({ database }) };
}

module.exports = {
  REQUIRED_STATE_INDEXES, inspectStateRuntimePrerequisites,
  loadHeadProcessingAuthority, selectHeadProcessingRepository,
};
