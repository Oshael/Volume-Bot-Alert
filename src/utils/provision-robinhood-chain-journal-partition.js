'use strict';

/** Provision one future transaction/event pair after the transaction cutover. */
const db = require('../models/db');

const WIDTH = 250000;
const ACTIVE_TX = 'public.robinhood_chain_transactions';
const ACTIVE_EVENTS = 'public.robinhood_chain_events';
const FK = 'rh_chain_events_transaction_shadow_fkey';
const IDENTIFIER = /^public\.[a-z_][a-z0-9_]*$/;

function parseArgs(args = []) {
  const input = {};
  for (const arg of args) {
    if (arg === '--apply' && !input.apply) input.apply = true;
    else if (/^--partition-start=\d+$/.test(arg) && input.start == null) {
      input.start = Number(arg.slice('--partition-start='.length));
    } else throw new Error(`invalid argument: ${arg}`);
  }
  if (!Number.isSafeInteger(input.start) || input.start < 0
      || input.start % WIDTH !== 0 || input.start + WIDTH >= Number.MAX_SAFE_INTEGER) {
    throw new Error('--partition-start must be a nonnegative 250000-block boundary');
  }
  return { start: input.start, apply: Boolean(input.apply) };
}

function checkedRelation(value) {
  if (!IDENTIFIER.test(value)) throw new Error('invalid relation name');
  return value;
}

function placement(tablespace) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(tablespace)) throw new Error('invalid tablespace');
  return tablespace === 'pg_default' ? '' : ` TABLESPACE ${tablespace}`;
}

async function parentLayout(client, txParent, eventParent) {
  const result = await client.query(`SELECT relation.oid=to_regclass($1) AS is_tx,
      relation.relkind, pg_get_partkeydef(relation.oid) AS partition_key,
      COALESCE(space.spcname, 'pg_default') AS tablespace
    FROM pg_class relation
    LEFT JOIN pg_tablespace space ON space.oid=relation.reltablespace
    WHERE relation.oid=ANY(ARRAY[to_regclass($1),to_regclass($2)])`,
  [txParent, eventParent]);
  const tx = result.rows.find((row) => row.is_tx);
  const events = result.rows.find((row) => !row.is_tx);
  if (tx?.relkind !== 'p' || events?.relkind !== 'p'
      || tx.partition_key !== 'RANGE (block_number)'
      || events.partition_key !== 'RANGE (block_number)') {
    throw new Error('active transaction and event parents must be range partitioned');
  }
  const constraints = await client.query(`SELECT conrelid=to_regclass($1) AS is_tx,
      contype, conname, confrelid=to_regclass('public.robinhood_chain_blocks')
        AS references_blocks,
      pg_get_constraintdef(oid) AS definition
    FROM pg_constraint WHERE conrelid=ANY(ARRAY[to_regclass($1),to_regclass($2)])
      AND contype IN ('f','p')`, [txParent, eventParent]);
  if (!constraints.rows.some((row) => row.is_tx && row.contype === 'p'
      && row.definition.includes('PRIMARY KEY (chain, block_number, block_hash, transaction_hash)'))
      || !constraints.rows.some((row) => row.is_tx && row.contype === 'f'
        && row.references_blocks
        && row.definition.includes('FOREIGN KEY (chain, block_hash)')
        && row.definition.includes('ON DELETE CASCADE'))
      || !constraints.rows.some((row) => !row.is_tx && row.contype === 'p'
        && row.definition.includes('PRIMARY KEY (chain, block_number, block_hash, log_index)'))
      || constraints.rows.some((row) => !row.is_tx && row.contype === 'f')) {
    throw new Error('transaction or event parent constraints do not match cutover layout');
  }
  return { txTablespace: tx.tablespace, eventTablespace: events.tablespace };
}

async function inspectLeaf(client, parent, child, start) {
  const result = await client.query(`SELECT child.relkind,
      pg_get_expr(child.relpartbound, child.oid) AS bound,
      COALESCE(space.spcname, 'pg_default') AS tablespace
    FROM pg_inherits inheritance
    JOIN pg_class child ON child.oid=inheritance.inhrelid
    LEFT JOIN pg_tablespace space ON space.oid=child.reltablespace
    WHERE inheritance.inhparent=to_regclass($1) AND child.oid=to_regclass($2)`,
  [parent, child]);
  const row = result.rows[0];
  if (!row && (await client.query('SELECT to_regclass($1) IS NOT NULL AS exists',
    [child])).rows[0].exists) {
    throw new Error(`${child} exists outside the expected parent`);
  }
  if (row && (row.relkind !== 'r'
      || row.bound !== `FOR VALUES FROM ('${start}') TO ('${start + WIDTH}')`)) {
    throw new Error(`${child} has unexpected partition bounds`);
  }
  return row || null;
}

async function assertEventFk(client, eventLeaf, txParent) {
  const result = await client.query(`SELECT conname, convalidated,
      conparentid=0 AS root_constraint,
      confrelid=to_regclass($2) AS correct_parent,
      pg_get_constraintdef(oid) AS definition
    FROM pg_constraint WHERE conrelid=to_regclass($1)
      AND contype='f'`, [eventLeaf, txParent]);
  const roots = result.rows.filter((row) => row.root_constraint);
  const row = roots[0];
  if (roots.length !== 1 || row.conname !== FK
      || !row.convalidated || !row.correct_parent
      || !row.definition.includes('FOREIGN KEY (chain, block_number, block_hash, transaction_hash)')
      || !row.definition.includes('ON DELETE CASCADE')) {
    throw new Error(`${eventLeaf} lacks its validated transaction FK`);
  }
}

async function assertIndexPlacement(client, parent, leaf) {
  const result = await client.query(`SELECT parent_index.relname AS name,
      COALESCE(parent_space.spcname, 'pg_default') AS expected_tablespace,
      COALESCE(child_space.spcname, 'pg_default') AS actual_tablespace,
      state.indisvalid, state.indisready
    FROM pg_index state
    JOIN pg_inherits inheritance ON inheritance.inhrelid=state.indexrelid
    JOIN pg_class parent_index ON parent_index.oid=inheritance.inhparent
    JOIN pg_class child_index ON child_index.oid=state.indexrelid
    LEFT JOIN pg_tablespace parent_space ON parent_space.oid=parent_index.reltablespace
    LEFT JOIN pg_tablespace child_space ON child_space.oid=child_index.reltablespace
    WHERE state.indrelid=to_regclass($1)
      AND parent_index.oid IN (SELECT indexrelid FROM pg_index
        WHERE indrelid=to_regclass($2))`, [leaf, parent]);
  const expected = await client.query(`SELECT count(*)::int AS count FROM pg_index
    WHERE indrelid=to_regclass($1)`, [parent]);
  if (result.rows.length !== expected.rows[0].count
      || result.rows.some((row) => row.actual_tablespace !== row.expected_tablespace
        || !row.indisvalid || !row.indisready)) {
    throw new Error(`${leaf} has missing or misplaced inherited indexes`);
  }
}

async function provision(client, start, apply, options = {}) {
  const txParent = checkedRelation(options.txParent || ACTIVE_TX);
  const eventParent = checkedRelation(options.eventParent || ACTIVE_EVENTS);
  const txLeaf = checkedRelation(options.txLeaf
    || `public.robinhood_chain_transactions_shadow_b${start}`);
  const eventLeaf = checkedRelation(options.eventLeaf
    || `public.robinhood_chain_events_shadow_b${start}`);
  const layout = await parentLayout(client, txParent, eventParent);
  const tx = await inspectLeaf(client, txParent, txLeaf, start);
  const event = await inspectLeaf(client, eventParent, eventLeaf, start);
  if (tx && tx.tablespace !== layout.txTablespace
      || event && event.tablespace !== layout.eventTablespace) {
    throw new Error('existing partition tablespace differs from its parent');
  }
  if (event) await assertEventFk(client, eventLeaf, txParent);
  if (tx) await assertIndexPlacement(client, txParent, txLeaf);
  if (event) await assertIndexPlacement(client, eventParent, eventLeaf);
  if (!apply) return { start, txPresent: Boolean(tx), eventPresent: Boolean(event) };
  if (!tx) await client.query(`CREATE TABLE ${txLeaf} PARTITION OF ${txParent}
    FOR VALUES FROM (${start}) TO (${start + WIDTH})${placement(layout.txTablespace)}`);
  if (!event) {
    await client.query(`CREATE TABLE ${eventLeaf} PARTITION OF ${eventParent}
      FOR VALUES FROM (${start}) TO (${start + WIDTH})${placement(layout.eventTablespace)}`);
    await client.query(`ALTER TABLE ${eventLeaf} ADD CONSTRAINT ${FK}
      FOREIGN KEY (chain, block_number, block_hash, transaction_hash)
      REFERENCES ${txParent}(chain, block_number, block_hash, transaction_hash)
      ON DELETE CASCADE`);
  }
  await assertEventFk(client, eventLeaf, txParent);
  await assertIndexPlacement(client, txParent, txLeaf);
  await assertIndexPlacement(client, eventParent, eventLeaf);
  return { start, txPresent: true, eventPresent: true,
    createdTransactions: !tx, createdEvents: !event };
}

async function run(input, options = {}) {
  const database = options.database || db;
  const client = await database.getClient();
  try {
    await client.query(input.apply ? 'BEGIN' : 'BEGIN READ ONLY');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    if (input.apply) {
      const cursor = await client.query(`SELECT next_block::text FROM
        public.robinhood_chain_capture_cursor WHERE chain='robinhood'
        FOR UPDATE NOWAIT`);
      if (!cursor.rows[0] || BigInt(cursor.rows[0].next_block) > BigInt(input.start)) {
        throw new Error('partition is behind the capture cursor');
      }
    }
    const result = await provision(client, input.start, input.apply);
    await client.query('COMMIT');
    return { mode: input.apply ? 'apply' : 'read-only', ...result };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) run(parseArgs(process.argv.slice(2))).then((result) => {
  console.log(JSON.stringify(result));
}).catch((error) => {
  console.error('Robinhood chain journal partition provision failed:', error.message);
  process.exitCode = 1;
});

module.exports = { parseArgs, parentLayout, provision, run };
