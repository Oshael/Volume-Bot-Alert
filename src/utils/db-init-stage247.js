'use strict';

/** Stage 247 - empty partitioned shadow for canonical Robinhood events. */
const db = require('../models/db');

const PARTITION_WIDTH = 250000;
const MAX_PARTITIONS = 24;
const SHADOW = 'public.robinhood_chain_events_shadow';

function partitionRanges(fromBlock, throughBlock) {
  if (!Number.isSafeInteger(fromBlock) || !Number.isSafeInteger(throughBlock)
      || fromBlock < 0 || throughBlock < fromBlock) {
    throw new Error('fromBlock and throughBlock must be nonnegative safe integers in order');
  }
  const first = Math.floor(fromBlock / PARTITION_WIDTH) * PARTITION_WIDTH;
  const last = Math.floor(throughBlock / PARTITION_WIDTH) * PARTITION_WIDTH;
  const count = (last - first) / PARTITION_WIDTH + 1;
  if (count > MAX_PARTITIONS) throw new Error(`at most ${MAX_PARTITIONS} partitions per run`);
  return Array.from({ length: count }, (_, index) => {
    const start = first + index * PARTITION_WIDTH;
    return { start, end: start + PARTITION_WIDTH,
      name: `robinhood_chain_events_shadow_b${start}` };
  });
}

function tablespaceName(value) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value || '')) {
    throw new Error('tablespace must be an unquoted PostgreSQL identifier');
  }
  return value;
}

function shadowStatements(tablespace) {
  const placement = tablespace === 'pg_default' ? '' : ` TABLESPACE ${tablespace}`;
  return [
    `CREATE TABLE IF NOT EXISTS ${SHADOW} (
       chain VARCHAR(16) NOT NULL DEFAULT 'robinhood',
       block_hash VARCHAR(66) NOT NULL,
       block_number BIGINT NOT NULL,
       transaction_hash VARCHAR(66) NOT NULL,
       transaction_index INTEGER NOT NULL,
       log_index INTEGER NOT NULL,
       address VARCHAR(42) NOT NULL,
       topic0 VARCHAR(66) NOT NULL,
       topics JSONB NOT NULL,
       data TEXT NOT NULL,
       captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       CONSTRAINT rh_chain_events_shadow_pkey PRIMARY KEY (
         chain, block_number, block_hash, log_index
       )${tablespace === 'pg_default' ? '' : ` USING INDEX TABLESPACE ${tablespace}`},
       CONSTRAINT rh_chain_events_shadow_transaction_fkey FOREIGN KEY (
         chain, block_hash, transaction_hash
       ) REFERENCES public.robinhood_chain_transactions(chain, block_hash, transaction_hash)
         ON DELETE CASCADE,
       CONSTRAINT rh_chain_events_shadow_values_check CHECK (
         block_number >= 0 AND transaction_index >= 0 AND log_index >= 0
         AND address ~ '^0x[0-9a-f]{40}$' AND topic0 ~ '^0x[0-9a-f]{64}$'
         AND jsonb_typeof(topics) = 'array' AND jsonb_array_length(topics) > 0
         AND topics ->> 0 = topic0
       )
     ) PARTITION BY RANGE (block_number)${placement}`,
    `CREATE INDEX IF NOT EXISTS idx_rh_chain_events_shadow_hash
       ON ${SHADOW}(chain, block_hash, log_index)${placement}`,
    `CREATE INDEX IF NOT EXISTS idx_rh_chain_events_shadow_order
       ON ${SHADOW}(chain, block_number, transaction_index, log_index)
       ${placement}`,
    `CREATE INDEX IF NOT EXISTS idx_rh_chain_events_shadow_topic
       ON ${SHADOW}(chain, topic0, block_number)${placement}`,
    `ALTER TABLE public.robinhood_chain_v3_balance_snapshots
       ADD COLUMN IF NOT EXISTS block_number BIGINT`,
  ];
}

async function verifyPartition(client, range, tablespace) {
  const { rows } = await client.query(`SELECT
      pg_get_expr(child.relpartbound, child.oid) AS bound,
      COALESCE(space.spcname, 'pg_default') AS tablespace
    FROM pg_class child
    JOIN pg_inherits inheritance ON inheritance.inhrelid = child.oid
    JOIN pg_class parent ON parent.oid = inheritance.inhparent
    LEFT JOIN pg_tablespace space ON space.oid = child.reltablespace
    WHERE child.oid = to_regclass($1)
      AND parent.oid = to_regclass($2)`,
  [`public.${range.name}`, SHADOW]);
  if (rows.length !== 1 || rows[0].tablespace !== tablespace
      || rows[0].bound !== `FOR VALUES FROM ('${range.start}') TO ('${range.end}')`) {
    throw new Error(`partition ${range.name} has unexpected bounds or tablespace`);
  }
  const indexes = await client.query(`SELECT COALESCE(space.spcname, 'pg_default') AS tablespace
    FROM pg_index item
    JOIN pg_class index_relation ON index_relation.oid = item.indexrelid
    LEFT JOIN pg_tablespace space ON space.oid = index_relation.reltablespace
    WHERE item.indrelid = to_regclass($1)`, [`public.${range.name}`]);
  if (indexes.rows.length !== 4
      || indexes.rows.some((index) => index.tablespace !== tablespace)) {
    throw new Error(`partition ${range.name} indexes are missing or on another tablespace`);
  }
}

async function init(options = {}) {
  const database = options.database || db;
  const tablespace = tablespaceName(options.tablespace);
  const ranges = partitionRanges(options.fromBlock, options.throughBlock);
  let client;
  try {
    client = await database.getClient();
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    for (const statement of shadowStatements(tablespace)) await client.query(statement);
    for (const range of ranges) {
      await client.query(`CREATE TABLE IF NOT EXISTS public.${range.name}
        PARTITION OF ${SHADOW} FOR VALUES FROM (${range.start}) TO (${range.end})
        ${tablespace === 'pg_default' ? '' : `TABLESPACE ${tablespace}`}`);
      await verifyPartition(client, range, tablespace);
    }
    await client.query('COMMIT');
    return { tablespace, ranges };
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client?.release();
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

function cliOptions(argv) {
  const args = Object.fromEntries(argv.map((arg) => {
    const match = /^--(tablespace|from-block|through-block)=(.+)$/.exec(arg);
    if (!match) throw new Error(`unknown argument: ${arg}`);
    return [match[1], match[2]];
  }));
  return { tablespace: args.tablespace, fromBlock: Number(args['from-block']),
    throughBlock: Number(args['through-block']) };
}

if (require.main === module) init(cliOptions(process.argv.slice(2))).then((result) => {
  console.log(JSON.stringify(result));
}).catch((error) => {
  console.error('Failed to apply Stage 247:', error.message);
  process.exitCode = 1;
});

module.exports = { MAX_PARTITIONS, PARTITION_WIDTH, cliOptions, init, partitionRanges,
  shadowStatements, tablespaceName };
