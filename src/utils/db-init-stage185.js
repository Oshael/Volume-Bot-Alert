'use strict';

/** Stage 185 - accelerate the Robinhood FRESH seed cohort plan. */
const db = require('../models/db');

const ANCHOR_INDEX = 'idx_rh_launch_anchors_fresh_seed_window';
const SWAP_PARENT_INDEX = 'idx_rh_wallet_swaps_token_block';
const STATEMENTS = Object.freeze([
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${ANCHOR_INDEX}
     ON robinhood_token_launch_anchors(chain, launch_block_time, token_address)
     INCLUDE (first_pool_block)`,
  `CREATE INDEX IF NOT EXISTS ${SWAP_PARENT_INDEX}
     ON ONLY robinhood_wallet_swaps(chain, token_address, block_number)`,
]);

const PARTITIONS_SQL = `
  SELECT child.oid::text AS partition_oid,
         child_namespace.nspname AS schema_name,
         child.relname AS partition_name,
         EXISTS (
           SELECT 1
             FROM pg_inherits index_tree
             INNER JOIN pg_index child_index
               ON child_index.indexrelid = index_tree.inhrelid
            WHERE index_tree.inhparent = $1::regclass
              AND child_index.indrelid = child.oid
         ) AS attached
    FROM pg_inherits table_tree
    INNER JOIN pg_class parent ON parent.oid = table_tree.inhparent
    INNER JOIN pg_namespace parent_namespace ON parent_namespace.oid = parent.relnamespace
    INNER JOIN pg_class child ON child.oid = table_tree.inhrelid
    INNER JOIN pg_namespace child_namespace ON child_namespace.oid = child.relnamespace
   WHERE parent_namespace.nspname = 'public'
     AND parent.relname = 'robinhood_wallet_swaps'
   ORDER BY child.relname`;

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function childIndexName(partitionName) {
  const suffix = '_fresh_token_block_idx';
  return `${String(partitionName).slice(0, 63 - suffix.length)}${suffix}`;
}

function qualified(schemaName, relationName) {
  return `${quoteIdentifier(schemaName)}.${quoteIdentifier(relationName)}`;
}

function childIndexSql(schemaName, partitionName) {
  const indexName = childIndexName(partitionName);
  return `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${quoteIdentifier(indexName)}
    ON ${qualified(schemaName, partitionName)}(chain, token_address, block_number)`;
}

function attachIndexSql(schemaName, partitionName) {
  return `ALTER INDEX public.${quoteIdentifier(SWAP_PARENT_INDEX)} ATTACH PARTITION ${
    qualified(schemaName, childIndexName(partitionName))}`;
}

async function ensureConcurrentIndex(database, schemaName, indexName, createSql) {
  const relation = `${schemaName}.${indexName}`;
  const existing = await database.query(
    `SELECT index_state.indisvalid
       FROM pg_index index_state
      WHERE index_state.indexrelid = to_regclass($1)`,
    [relation]
  );
  if (existing.rows[0]?.indisvalid === false) {
    await database.query(`DROP INDEX CONCURRENTLY ${qualified(schemaName, indexName)}`);
  }
  await database.query(createSql);
}

async function assertParentIndexValid(database) {
  const result = await database.query(
    `SELECT index_state.indisvalid
       FROM pg_index index_state
      WHERE index_state.indexrelid = $1::regclass`,
    [`public.${SWAP_PARENT_INDEX}`]
  );
  if (result.rows[0]?.indisvalid !== true) {
    const error = new Error('Stage 185 swap partition index is incomplete; rerun the stage');
    error.code = 'stage185_partition_index_incomplete';
    throw error;
  }
}

async function init(options = {}) {
  const database = options.database || db;
  try {
    await ensureConcurrentIndex(database, 'public', ANCHOR_INDEX, STATEMENTS[0]);
    await database.query(STATEMENTS[1]);
    const partitions = await database.query(
      PARTITIONS_SQL, [`public.${SWAP_PARENT_INDEX}`]
    );
    for (const partition of partitions.rows) {
      if (partition.attached === true) continue;
      const indexName = childIndexName(partition.partition_name);
      await ensureConcurrentIndex(
        database, partition.schema_name, indexName,
        childIndexSql(partition.schema_name, partition.partition_name)
      );
      await database.query(attachIndexSql(
        partition.schema_name, partition.partition_name
      ));
    }
    await assertParentIndexValid(database);
    console.log('Stage 185 Robinhood FRESH seed indexes created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 185:', error.message);
  process.exitCode = 1;
});

module.exports = {
  STATEMENTS,
  init,
  __private: { PARTITIONS_SQL, attachIndexSql, childIndexName, childIndexSql },
};
