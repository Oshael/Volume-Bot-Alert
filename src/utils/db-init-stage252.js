'use strict';

/** Stage 252: place redistribution evidence lookup indexes on the second data volume. */
const fs = require('node:fs');
const db = require('../models/db');

const TABLESPACE = 'trendscope_nvme2';
const MOUNT = '/srv/trendscope-data-2';
const LOCATION_PREFIX = '/srv/trendscope-data-2/';
const EDGE_INDEX = 'idx_rh_transfer_edges_redis_window';
const SWAP_INDEX = 'idx_rh_wallet_swaps_redis_sell';

const EDGE_SQL = `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${EDGE_INDEX}
  ON public.robinhood_wallet_transfer_edges
    (chain, classification_version, token_address, first_wallet_transfer_block)
  TABLESPACE ${TABLESPACE}
  WHERE first_wallet_transfer_amount_raw > 0 AND from_wallet <> to_wallet`;
const PARENT_SQL = `CREATE INDEX IF NOT EXISTS ${SWAP_INDEX}
  ON ONLY public.robinhood_wallet_swaps
    (chain, token_address, wallet_address, block_number)
  TABLESPACE ${TABLESPACE} WHERE side = 'sell'`;

const PARTITIONS_SQL = `SELECT namespace.nspname AS schema_name,
    child.relname AS partition_name,
    attached_index.relname AS attached_index_name
  FROM pg_inherits table_tree
  JOIN pg_class child ON child.oid = table_tree.inhrelid
  JOIN pg_namespace namespace ON namespace.oid = child.relnamespace
  LEFT JOIN LATERAL (
    SELECT index_relation.relname
    FROM pg_inherits index_tree
    JOIN pg_index child_index ON child_index.indexrelid = index_tree.inhrelid
    JOIN pg_class index_relation ON index_relation.oid = child_index.indexrelid
    WHERE index_tree.inhparent = $1::regclass
      AND child_index.indrelid = child.oid
    LIMIT 1
  ) attached_index ON true
  WHERE table_tree.inhparent = 'public.robinhood_wallet_swaps'::regclass
  ORDER BY child.relname`;

function quoted(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function childIndexName(partitionName) {
  const suffix = '_redis_sell_idx';
  return `${partitionName.slice(0, 63 - suffix.length)}${suffix}`;
}

function childIndexSql(schemaName, partitionName) {
  return `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${quoted(childIndexName(partitionName))}
    ON ${quoted(schemaName)}.${quoted(partitionName)}
      (chain, token_address, wallet_address, block_number)
    TABLESPACE ${TABLESPACE} WHERE side = 'sell'`;
}

function attachIndexSql(schemaName, partitionName) {
  return `ALTER INDEX public.${quoted(SWAP_INDEX)} ATTACH PARTITION
    ${quoted(schemaName)}.${quoted(childIndexName(partitionName))}`;
}

async function assertTablespace(database, filesystem = fs) {
  const { rows } = await database.query(
    'SELECT pg_tablespace_location(oid) AS location FROM pg_tablespace WHERE spcname = $1',
    [TABLESPACE]
  );
  if (!rows[0]?.location?.startsWith(LOCATION_PREFIX)) {
    throw new Error(`${TABLESPACE} must be located under ${LOCATION_PREFIX}`);
  }
  const mountDevice = filesystem.statSync(MOUNT).dev;
  if (mountDevice === filesystem.statSync('/srv').dev
      || filesystem.statSync(rows[0].location).dev !== mountDevice) {
    throw new Error(`${TABLESPACE} location is not on a mounted ${MOUNT} filesystem`);
  }
}

async function indexState(database, schemaName, indexName) {
  const { rows } = await database.query(`SELECT state.indisvalid,
      COALESCE(space.spcname, 'pg_default') AS tablespace
    FROM pg_index state
    JOIN pg_class index_relation ON index_relation.oid = state.indexrelid
    JOIN pg_database database_state ON database_state.datname = current_database()
    LEFT JOIN pg_tablespace space ON space.oid = COALESCE(
      NULLIF(index_relation.reltablespace, 0), database_state.dattablespace)
    WHERE state.indexrelid = to_regclass($1)`, [`${schemaName}.${indexName}`]);
  return rows[0] || null;
}

async function assertIndex(database, schemaName, indexName, requireValid = true) {
  const state = await indexState(database, schemaName, indexName);
  if (!state || state.tablespace !== TABLESPACE || (requireValid && !state.indisvalid)) {
    throw new Error(`${schemaName}.${indexName} is missing, invalid, or outside ${TABLESPACE}`);
  }
  return state;
}

async function ensureConcurrentIndex(database, schemaName, indexName, createSql) {
  const existing = await indexState(database, schemaName, indexName);
  if (existing && existing.tablespace !== TABLESPACE) {
    throw new Error(`${schemaName}.${indexName} is outside ${TABLESPACE}`);
  }
  if (existing && !existing.indisvalid) {
    await database.query(`DROP INDEX CONCURRENTLY ${quoted(schemaName)}.${quoted(indexName)}`);
  }
  await database.query(createSql);
  await assertIndex(database, schemaName, indexName);
}

async function init(options = {}) {
  const database = options.database || db;
  try {
    await assertTablespace(database, options.filesystem || fs);
    console.log(`Building ${EDGE_INDEX} on ${TABLESPACE}`);
    await ensureConcurrentIndex(database, 'public', EDGE_INDEX, EDGE_SQL);
    await database.query(PARENT_SQL);
    await assertIndex(database, 'public', SWAP_INDEX, false);
    const { rows: partitions } = await database.query(PARTITIONS_SQL, [`public.${SWAP_INDEX}`]);
    for (const partition of partitions) {
      const { schema_name: schemaName, partition_name: partitionName } = partition;
      if (partition.attached_index_name) {
        await assertIndex(database, schemaName, partition.attached_index_name);
        continue;
      }
      const indexName = childIndexName(partitionName);
      console.log(`Building redistribution sell index for ${partitionName}`);
      await ensureConcurrentIndex(database, schemaName, indexName,
        childIndexSql(schemaName, partitionName));
      await database.query(attachIndexSql(schemaName, partitionName));
      console.log(`Attached redistribution sell index for ${partitionName}`);
    }
    await assertIndex(database, 'public', SWAP_INDEX);
    console.log(`Stage 252 indexes ready on ${TABLESPACE}: ${partitions.length} partitions`);
  } finally {
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to apply Stage 252:', error.message);
  process.exitCode = 1;
});

module.exports = { EDGE_SQL, PARENT_SQL, init,
  __private: { PARTITIONS_SQL, assertTablespace, attachIndexSql, childIndexName,
    childIndexSql, ensureConcurrentIndex } };
