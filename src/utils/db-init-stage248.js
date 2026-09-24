'use strict';

/** Stage 248: empty outbox candidate with an exact FK to partitioned events. */
const db = require('../models/db');
const { tablespaceName } = require('./db-init-stage247');

const TABLE = 'public.robinhood_chain_domain_outbox_shadow';
const INDEXES = Object.freeze([
  ['idx_rh_chain_domain_outbox_shadow_claim',
    '(domain, status, next_attempt_at, block_number, transaction_index, log_index)',
    "WHERE status = 'pending'"],
  ['idx_rh_chain_domain_outbox_shadow_lease',
    '(domain, lease_until)', "WHERE status = 'leased'"],
  ['idx_rh_chain_domain_outbox_shadow_frontier',
    `(chain, block_number, status, domain, transaction_index, log_index)
     INCLUDE(next_attempt_at)`, "WHERE status <> 'complete'"],
  ['idx_rh_chain_domain_outbox_shadow_event_lookup',
    '(chain, block_number, block_hash, log_index)', ''],
]);

function statements(tablespace) {
  const placement = tablespace === 'pg_default' ? '' : ` TABLESPACE ${tablespace}`;
  const indexPlacement = tablespace === 'pg_default'
    ? '' : ` USING INDEX TABLESPACE ${tablespace}`;
  return [
    `CREATE TABLE IF NOT EXISTS ${TABLE} (
       LIKE public.robinhood_chain_domain_outbox
         INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING STORAGE,
       CONSTRAINT rh_chain_domain_outbox_shadow_pkey
         PRIMARY KEY (chain, domain, block_hash, log_index)${indexPlacement},
       CONSTRAINT rh_chain_domain_outbox_shadow_event_fkey
         FOREIGN KEY (chain, block_number, block_hash, log_index)
         REFERENCES public.robinhood_chain_events_shadow
           (chain, block_number, block_hash, log_index) ON DELETE CASCADE
     )${placement}`,
    `ALTER TABLE ${TABLE} SET (
       autovacuum_vacuum_scale_factor = 0.005,
       autovacuum_vacuum_threshold = 50000,
       autovacuum_analyze_scale_factor = 0.01,
       autovacuum_analyze_threshold = 50000
     )`,
    ...INDEXES.map(([name, definition, predicate]) =>
      `CREATE INDEX IF NOT EXISTS ${name} ON ${TABLE} ${definition}
       ${placement} ${predicate}`),
  ];
}

async function verify(client, tablespace) {
  const relation = await client.query(`SELECT COALESCE(space.spcname, 'pg_default') AS tablespace
    FROM pg_class relation
    LEFT JOIN pg_tablespace space ON space.oid=relation.reltablespace
    WHERE relation.oid=$1::regclass`, [TABLE]);
  if (relation.rows[0]?.tablespace !== tablespace) {
    throw new Error('outbox shadow tablespace mismatch');
  }
  const constraints = await client.query(`SELECT conname, pg_get_constraintdef(oid) AS definition,
      confrelid='public.robinhood_chain_events_shadow'::regclass AS correct_parent
    FROM pg_constraint WHERE conrelid=$1::regclass`, [TABLE]);
  const byName = new Map(constraints.rows.map((row) => [row.conname, row]));
  const parent = byName.get('rh_chain_domain_outbox_shadow_event_fkey');
  if (!byName.get('rh_chain_domain_outbox_shadow_pkey')?.definition.includes(
    'PRIMARY KEY (chain, domain, block_hash, log_index)')
      || parent?.correct_parent !== true
      || !parent.definition.includes('FOREIGN KEY (chain, block_number, block_hash, log_index)')
      || !parent.definition.includes('ON DELETE CASCADE')
      || !byName.has('rh_chain_domain_outbox_values_check')
      || !byName.has('rh_chain_domain_outbox_lifecycle_check')) {
    throw new Error('outbox shadow key constraints mismatch');
  }
  const indexes = await client.query(`SELECT index_relation.relname,
      COALESCE(space.spcname, 'pg_default') AS tablespace
    FROM pg_index item
    JOIN pg_class index_relation ON index_relation.oid=item.indexrelid
    LEFT JOIN pg_tablespace space ON space.oid=index_relation.reltablespace
    WHERE item.indrelid=$1::regclass`, [TABLE]);
  const expected = new Set(['rh_chain_domain_outbox_shadow_pkey',
    ...INDEXES.map(([name]) => name)]);
  if (indexes.rows.length !== expected.size || indexes.rows.some((row) =>
    !expected.has(row.relname) || row.tablespace !== tablespace)) {
    throw new Error('outbox shadow index placement mismatch');
  }
}

async function init(options = {}) {
  const database = options.database || db;
  const tablespace = tablespaceName(options.tablespace);
  let client;
  try {
    client = await database.getClient();
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    for (const statement of statements(tablespace)) await client.query(statement);
    await verify(client, tablespace);
    await client.query('COMMIT');
    return { table: TABLE, tablespace };
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client?.release();
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

function cliOptions(args = []) {
  if (args.length !== 1 || !args[0].startsWith('--tablespace=')) {
    throw new Error('--tablespace=NAME is required');
  }
  return { tablespace: args[0].slice('--tablespace='.length) };
}

if (require.main === module) init(cliOptions(process.argv.slice(2))).then((result) => {
  console.log(JSON.stringify(result));
}).catch((error) => {
  console.error('Failed to apply Stage 248:', error.message);
  process.exitCode = 1;
});

module.exports = { TABLE, cliOptions, init, statements, verify };
