'use strict';

/** Stage 253: empty partitioned candidate for canonical Robinhood transactions. */
const db = require('../models/db');
const { partitionRanges, tablespaceName } = require('./db-init-stage247');

const SHADOW = 'public.robinhood_chain_transactions_shadow';
const PREFIX = 'robinhood_chain_transactions_shadow_b';
const PK = 'rh_chain_transactions_shadow_pkey';
const POSITION_KEY = 'rh_chain_transactions_shadow_index_key';
const BLOCK_FK = 'rh_chain_transactions_shadow_block_fkey';
const BLOCK_LOOKUP = 'idx_rh_chain_transactions_shadow_hash';
const TX_LOOKUP = 'idx_rh_chain_transactions_shadow_txhash';

function placement(tablespace) {
  return tablespace === 'pg_default' ? '' : ` TABLESPACE ${tablespace}`;
}

function indexPlacement(tablespace) {
  return tablespace === 'pg_default' ? '' : ` USING INDEX TABLESPACE ${tablespace}`;
}

function assertIndexPlacement(rows, heapTablespace, indexTablespace, label) {
  const byName = new Map(rows.map((row) => [row.relname || row.parent_name, row]));
  const expected = [
    [PK, heapTablespace], [POSITION_KEY, indexTablespace],
    [BLOCK_LOOKUP, heapTablespace], [TX_LOOKUP, heapTablespace],
  ];
  if (rows.length !== expected.length
      || expected.some(([name, tablespace]) => byName.get(name)?.tablespace !== tablespace)
      || rows.some((row) => !row.indisvalid || !row.indisready)) {
    throw new Error(`${label} index placement mismatch`);
  }
}

function statements(heapTablespace, indexTablespace) {
  return [
    `CREATE TABLE IF NOT EXISTS ${SHADOW} (
       LIKE public.robinhood_chain_transactions
         INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING STORAGE,
       block_number BIGINT NOT NULL CHECK (block_number >= 0),
       CONSTRAINT ${PK} PRIMARY KEY
         (chain, block_number, block_hash, transaction_hash)
         ${indexPlacement(heapTablespace)},
       CONSTRAINT ${POSITION_KEY} UNIQUE
         (chain, block_number, block_hash, transaction_index)
         ${indexPlacement(indexTablespace)},
       CONSTRAINT ${BLOCK_FK} FOREIGN KEY (chain, block_hash)
         REFERENCES public.robinhood_chain_blocks(chain, block_hash)
         ON DELETE CASCADE
     ) PARTITION BY RANGE (block_number)${placement(heapTablespace)}`,
    `CREATE INDEX IF NOT EXISTS ${BLOCK_LOOKUP} ON ${SHADOW}
       (chain, block_hash, transaction_hash)${placement(heapTablespace)}`,
    `CREATE INDEX IF NOT EXISTS ${TX_LOOKUP} ON ${SHADOW}
       (chain, transaction_hash, block_hash)${placement(heapTablespace)}`,
  ];
}

async function verifyParent(client, heapTablespace, indexTablespace) {
  const parent = await client.query(`SELECT relation.relkind,
      COALESCE(space.spcname, 'pg_default') AS tablespace
    FROM pg_class relation
    LEFT JOIN pg_tablespace space ON space.oid=relation.reltablespace
    WHERE relation.oid=to_regclass($1)`, [SHADOW]);
  if (parent.rows[0]?.relkind !== 'p'
      || parent.rows[0]?.tablespace !== heapTablespace) {
    throw new Error('transaction shadow is not partitioned on the requested tablespace');
  }
  const constraints = await client.query(`SELECT conname,
      pg_get_constraintdef(oid) AS definition,
      confrelid='public.robinhood_chain_blocks'::regclass AS correct_parent
    FROM pg_constraint WHERE conrelid=$1::regclass`, [SHADOW]);
  const byName = new Map(constraints.rows.map((row) => [row.conname, row]));
  const required = [
    byName.get(PK)?.definition.includes(
      'PRIMARY KEY (chain, block_number, block_hash, transaction_hash)'),
    byName.get(POSITION_KEY)?.definition.includes(
      'UNIQUE (chain, block_number, block_hash, transaction_index)'),
    byName.get(BLOCK_FK)?.correct_parent === true,
    byName.get(BLOCK_FK)?.definition.includes('ON DELETE CASCADE'),
  ];
  if (required.some((value) => value !== true)) {
    throw new Error('transaction shadow key or block FK mismatch');
  }
  const indexes = await client.query(`SELECT index_relation.relname,
      COALESCE(space.spcname, 'pg_default') AS tablespace,
      state.indisvalid, state.indisready
    FROM pg_index state
    JOIN pg_class index_relation ON index_relation.oid=state.indexrelid
    LEFT JOIN pg_tablespace space ON space.oid=index_relation.reltablespace
    WHERE state.indrelid=$1::regclass`, [SHADOW]);
  assertIndexPlacement(indexes.rows, heapTablespace, indexTablespace,
    'transaction shadow');
}

async function verifyPartition(client, range, heapTablespace, indexTablespace) {
  const name = `${PREFIX}${range.start}`;
  const result = await client.query(`SELECT
      pg_get_expr(child.relpartbound, child.oid) AS bound,
      COALESCE(space.spcname, 'pg_default') AS tablespace
    FROM pg_class child
    JOIN pg_inherits inheritance ON inheritance.inhrelid=child.oid
    LEFT JOIN pg_tablespace space ON space.oid=child.reltablespace
    WHERE child.oid=to_regclass($1)
      AND inheritance.inhparent=to_regclass($2)`, [`public.${name}`, SHADOW]);
  if (result.rows.length !== 1
      || result.rows[0].bound
        !== `FOR VALUES FROM ('${range.start}') TO ('${range.end}')`
      || result.rows[0].tablespace !== heapTablespace) {
    throw new Error(`transaction shadow partition ${name} has unexpected layout`);
  }
  const indexes = await client.query(`SELECT parent_index.relname AS parent_name,
      COALESCE(space.spcname, 'pg_default') AS tablespace,
      state.indisvalid, state.indisready
    FROM pg_inherits inheritance
    JOIN pg_class child_index ON child_index.oid=inheritance.inhrelid
    JOIN pg_class parent_index ON parent_index.oid=inheritance.inhparent
    JOIN pg_index state ON state.indexrelid=child_index.oid
    LEFT JOIN pg_tablespace space ON space.oid=child_index.reltablespace
    WHERE state.indrelid=to_regclass($1)`, [`public.${name}`]);
  assertIndexPlacement(indexes.rows, heapTablespace, indexTablespace,
    `transaction shadow partition ${name}`);
}

async function init(options = {}) {
  const database = options.database || db;
  const heapTablespace = tablespaceName(options.heapTablespace);
  const indexTablespace = tablespaceName(options.indexTablespace);
  const ranges = partitionRanges(options.fromBlock, options.throughBlock);
  let client;
  try {
    client = await database.getClient();
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    for (const statement of statements(heapTablespace, indexTablespace)) {
      await client.query(statement);
    }
    await verifyParent(client, heapTablespace, indexTablespace);
    for (const range of ranges) {
      await client.query(`CREATE TABLE IF NOT EXISTS public.${PREFIX}${range.start}
        PARTITION OF ${SHADOW} FOR VALUES FROM (${range.start}) TO (${range.end})
        ${placement(heapTablespace)}`);
      await verifyPartition(client, range, heapTablespace, indexTablespace);
    }
    await client.query('COMMIT');
    return { table: SHADOW, heapTablespace, indexTablespace, ranges };
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client?.release();
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

function cliOptions(args = []) {
  const values = {};
  for (const arg of args) {
    const match = /^--(heap-tablespace|index-tablespace|from-block|through-block)=(.+)$/.exec(arg);
    if (!match || values[match[1]] != null) throw new Error(`invalid argument: ${arg}`);
    values[match[1]] = match[2];
  }
  if (Object.keys(values).length !== 4) {
    throw new Error('heap/index tablespaces and from/through blocks are required');
  }
  return { heapTablespace: values['heap-tablespace'],
    indexTablespace: values['index-tablespace'],
    fromBlock: Number(values['from-block']), throughBlock: Number(values['through-block']) };
}

if (require.main === module) init(cliOptions(process.argv.slice(2))).then((result) => {
  console.log(JSON.stringify(result));
}).catch((error) => {
  console.error('Failed to apply Stage 253:', error.message);
  process.exitCode = 1;
});

module.exports = { SHADOW, cliOptions, init, statements, verifyParent, verifyPartition };
