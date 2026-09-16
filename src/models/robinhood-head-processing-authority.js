'use strict';

const db = require('./db');
const {
  createRobinhoodHeadProcessingRepository,
} = require('./robinhood-head-processing');
const {
  createRobinhoodHeadProcessingStateRepository,
} = require('./robinhood-head-processing-state');

const CHAIN = 'robinhood';
const AUTHORITY_LOCK_KEY = 'robinhood-head-processing-authority';
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

async function inspectStateRuntimePrerequisites(database, options = {}) {
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
              AS trigger_insert_only,
            COALESCE((SELECT definition ~* 'AFTER INSERT OR UPDATE' FROM mirror), false)
              AS trigger_full_mirror`,
    [REQUIRED_STATE_INDEXES]
  );
  const row = result.rows[0] || {};
  const blockers = [];
  if ((row.invalid_indexes || []).length) {
    blockers.push(`invalid indexes: ${row.invalid_indexes.join(', ')}`);
  }
  if (!row.trigger_enabled) blockers.push('head state sync trigger is disabled or missing');
  const expectedTrigger = options.triggerMode === 'full-mirror' ? 'full-mirror' : 'insert-only';
  if (expectedTrigger === 'insert-only' && !row.trigger_insert_only) {
    blockers.push('head state sync trigger is not insert-only');
  }
  if (expectedTrigger === 'full-mirror' && !row.trigger_full_mirror) {
    blockers.push('head state sync trigger is not a full lifecycle mirror');
  }
  return { safe: blockers.length === 0, blockers };
}

async function assertLegacyHeadProcessingAuthority(database) {
  const authority = await loadHeadProcessingAuthority(database);
  if (authority.authority !== 'legacy') {
    throw new Error('Legacy head lifecycle repair is disabled after state authority activation');
  }
  return authority;
}

async function selectHeadProcessingRepository(options = {}) {
  const database = options.database || db;
  const client = await database.getClient();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock_shared(hashtext($1))', [AUTHORITY_LOCK_KEY]);
    const authority = await loadHeadProcessingAuthority(client);
    let factory = options.legacyFactory || createRobinhoodHeadProcessingRepository;
    if (authority.authority === 'state') {
      if (!authority.activated_at || !authority.activation_report) {
        throw new Error('State authority is missing its durable activation evidence');
      }
      const gate = await inspectStateRuntimePrerequisites(client);
      if (!gate.safe) {
        throw new Error(`State authority runtime gate failed: ${gate.blockers.join('; ')}`);
      }
      factory = options.stateFactory || createRobinhoodHeadProcessingStateRepository;
    }
    await client.query('COMMIT');
    return { authority, repository: factory({ database }) };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function resolveHeadProcessingRepository(options = {}) {
  return (await selectHeadProcessingRepository(options)).repository;
}

module.exports = {
  AUTHORITY_LOCK_KEY, REQUIRED_STATE_INDEXES, assertLegacyHeadProcessingAuthority,
  inspectStateRuntimePrerequisites,
  loadHeadProcessingAuthority, resolveHeadProcessingRepository,
  selectHeadProcessingRepository,
};
