'use strict';

/** Swap the live outbox onto the partition-backed candidate in one transaction. */
const db = require('../models/db');

const OLD = 'public.robinhood_chain_domain_outbox';
const NEXT = 'public.robinhood_chain_domain_outbox_shadow';
const MAX_OPEN_ROWS = 100000;
const INDEX_NAMES = Object.freeze([
  ['idx_rh_chain_domain_outbox_shadow_claim', 'idx_rh_chain_domain_outbox_claim'],
  ['idx_rh_chain_domain_outbox_shadow_lease', 'idx_rh_chain_domain_outbox_lease'],
  ['idx_rh_chain_domain_outbox_shadow_frontier', 'idx_rh_chain_domain_outbox_frontier'],
  ['idx_rh_chain_domain_outbox_shadow_event_lookup', 'idx_rh_chain_domain_outbox_event_lookup'],
]);

async function columns(client, table) {
  const result = await client.query(`SELECT attname
    FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped
    ORDER BY attnum`, [table]);
  return result.rows.map((row) => row.attname);
}

async function inspect(client) {
  const source = await client.query(`SELECT
      constraint_item.confrelid='public.robinhood_chain_events_shadow'::regclass AS migrated,
      constraint_item.confrelid=to_regclass('public.robinhood_chain_events') AS legacy,
      pg_total_relation_size($1::regclass)::text AS old_bytes
    FROM pg_constraint constraint_item
    WHERE constraint_item.conrelid=$1::regclass
      AND constraint_item.conname='rh_chain_domain_outbox_event_fkey'`, [OLD]);
  if (source.rows.length !== 1) throw new Error('active outbox FK is missing');
  if (source.rows[0].migrated) return { alreadyMigrated: true };
  if (!source.rows[0].legacy) throw new Error('active outbox FK has an unexpected parent');
  const [oldColumns, nextColumns] = await Promise.all([
    columns(client, OLD), columns(client, NEXT),
  ]);
  if (JSON.stringify(oldColumns) !== JSON.stringify(nextColumns)) {
    throw new Error('outbox candidate columns differ from the active table');
  }
  const candidate = await client.query(`SELECT EXISTS(
      SELECT 1 FROM ${NEXT} LIMIT 1
    ) AS has_rows, EXISTS(
      SELECT 1 FROM pg_constraint
      WHERE conrelid=$1::regclass
        AND conname='rh_chain_domain_outbox_shadow_event_fkey'
        AND confrelid='public.robinhood_chain_events_shadow'::regclass
    ) AS has_shadow_fk,
    (SELECT COALESCE(space.spcname, 'pg_default') FROM pg_class relation
      LEFT JOIN pg_tablespace space ON space.oid=relation.reltablespace
      WHERE relation.oid=$1::regclass) AS tablespace`, [NEXT]);
  if (candidate.rows[0].has_rows || !candidate.rows[0].has_shadow_fk) {
    throw new Error('outbox candidate must be empty with an exact shadow FK');
  }
  const rows = await client.query(`SELECT COUNT(*)::integer AS open_rows,
      MIN(block_number)::text AS first_open_block
    FROM ${OLD} WHERE status<>'complete'`);
  const openRows = rows.rows[0].open_rows;
  if (openRows > MAX_OPEN_ROWS) throw new Error(`open outbox exceeds ${MAX_OPEN_ROWS} rows`);
  const missing = await client.query(`SELECT EXISTS(
      SELECT 1 FROM ${OLD} outbox
      WHERE outbox.status<>'complete' AND NOT EXISTS (
        SELECT 1 FROM public.robinhood_chain_events_shadow event
        WHERE event.chain=outbox.chain AND event.block_number=outbox.block_number
          AND event.block_hash=outbox.block_hash AND event.log_index=outbox.log_index
      ) LIMIT 1
    ) AS missing_event`);
  if (missing.rows[0].missing_event) {
    throw new Error('open outbox has an event absent from the shadow');
  }
  return { alreadyMigrated: false, openRows,
    firstOpenBlock: rows.rows[0].first_open_block,
    candidateTablespace: candidate.rows[0].tablespace,
    oldBytes: source.rows[0].old_bytes };
}

async function cutover(client) {
  const preflight = await inspect(client);
  if (preflight.alreadyMigrated) return preflight;
  const copied = await client.query(`INSERT INTO ${NEXT} SELECT * FROM ${OLD}
    WHERE status<>'complete'`);
  if (copied.rowCount !== preflight.openRows) {
    throw new Error('outbox changed during the locked copy');
  }
  await client.query(`ALTER TABLE ${OLD} RENAME TO robinhood_chain_domain_outbox_retired`);
  await client.query('DROP TABLE public.robinhood_chain_domain_outbox_retired');
  await client.query(`ALTER TABLE ${NEXT} RENAME TO robinhood_chain_domain_outbox`);
  await client.query(`ALTER TABLE ${OLD} RENAME CONSTRAINT
    rh_chain_domain_outbox_shadow_pkey TO rh_chain_domain_outbox_pkey`);
  await client.query(`ALTER TABLE ${OLD} RENAME CONSTRAINT
    rh_chain_domain_outbox_shadow_event_fkey TO rh_chain_domain_outbox_event_fkey`);
  for (const [from, to] of INDEX_NAMES) {
    await client.query(`ALTER INDEX public.${from} RENAME TO ${to}`);
  }
  const result = await client.query(`SELECT COUNT(*)::integer AS rows
    FROM ${OLD} WHERE status<>'complete'`);
  if (result.rows[0].rows !== preflight.openRows) {
    throw new Error('outbox row count changed during cutover');
  }
  return { ...preflight, copied: copied.rowCount, droppedLegacy: true };
}

async function run(input = {}) {
  const database = input.database || db;
  const client = await database.getClient();
  try {
    await client.query(input.apply ? 'BEGIN' : 'BEGIN READ ONLY');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '60s'");
    if (input.apply) {
      const initial = await inspect(client);
      if (initial.alreadyMigrated) {
        await client.query('COMMIT');
        return { mode: 'apply', ...initial };
      }
      if (initial.candidateTablespace !== 'trendscope_raw') {
        throw new Error('outbox candidate must be on trendscope_raw');
      }
      await client.query('LOCK TABLE public.robinhood_chain_events IN SHARE ROW EXCLUSIVE MODE');
      await client.query(`LOCK TABLE ${OLD}, ${NEXT} IN ACCESS EXCLUSIVE MODE`);
    }
    const result = input.apply ? await cutover(client) : await inspect(client);
    await client.query('COMMIT');
    return { mode: input.apply ? 'apply' : 'read-only', ...result };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
    if (input.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--apply')) {
    throw new Error('only --apply is accepted');
  }
  run({ apply: args[0] === '--apply' }).then((result) => {
    console.log(JSON.stringify(result));
  }).catch((error) => {
    console.error('Robinhood domain outbox cutover failed:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { MAX_OPEN_ROWS, INDEX_NAMES, columns, cutover, inspect, run };
