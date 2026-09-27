'use strict';

/** Add and validate the replacement FK on one finalized event partition. */
const db = require('../models/db');

const EVENTS = 'public.robinhood_chain_events';
const SHADOW = 'public.robinhood_chain_transactions_shadow';
const LEGACY = 'public.robinhood_chain_transactions';
const OLD_FK = 'rh_chain_events_shadow_transaction_fkey';
const NEW_FK = 'rh_chain_events_transaction_shadow_fkey';
const CAPTURE_LEASE = 'robinhood-chain-capture-worker';
const PARTITION_SIZE = 250000;
const RELATION = /^(?:public|pg_temp)\.[a-z_][a-z0-9_]*$/;

function addArgument(input, arg) {
  if (arg === '--paused') {
    if (input.paused) throw new Error('duplicate --paused');
    input.paused = true;
  } else if (arg === '--prepare' || arg === '--validate') {
    if (input.action) throw new Error('choose only one action');
    input.action = arg.slice(2);
  } else if (/^--expected-next-block=\d+$/.test(arg)) {
    if (input.expectedNextBlock != null) throw new Error('duplicate --expected-next-block');
    input.expectedNextBlock = Number(arg.slice('--expected-next-block='.length));
  } else {
    const match = /^--partition-start=(\d+)$/.exec(arg);
    if (!match || input.partitionStart != null) throw new Error(`invalid argument: ${arg}`);
    input.partitionStart = Number(match[1]);
  }
}

function parseArgs(args = []) {
  const input = {};
  for (const arg of args) addArgument(input, arg);
  const start = input.partitionStart;
  if (!Number.isSafeInteger(start) || start < 0 || start % PARTITION_SIZE !== 0
      || start + PARTITION_SIZE >= Number.MAX_SAFE_INTEGER) {
    throw new Error('--partition-start must be a nonnegative 250000-block boundary');
  }
  if (input.paused) {
    if (!input.action || !Number.isSafeInteger(input.expectedNextBlock)
        || input.expectedNextBlock < start
        || input.expectedNextBlock >= start + PARTITION_SIZE) {
      throw new Error('--paused requires --prepare or --validate and an expected next block in the partition');
    }
  } else if (input.expectedNextBlock != null) {
    throw new Error('--expected-next-block requires --paused');
  }
  return { action: input.action || 'read-only', partitionStart: start,
    ...(input.paused ? { paused: true, expectedNextBlock: input.expectedNextBlock } : {}) };
}

function relation(value) {
  if (!RELATION.test(value)) throw new Error('invalid qualified relation');
  return value;
}

function identifier(value) {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error('invalid constraint name');
  return value;
}

async function resolvePartition(client, start, parent = EVENTS) {
  const partition = `public.robinhood_chain_events_shadow_b${start}`;
  const result = await client.query(`SELECT parent.relkind AS parent_kind,
      child.relkind AS child_kind,
      pg_get_expr(child.relpartbound, child.oid) AS bound
    FROM pg_class parent
    JOIN pg_inherits inheritance ON inheritance.inhparent=parent.oid
    JOIN pg_class child ON child.oid=inheritance.inhrelid
    WHERE parent.oid=to_regclass($1) AND child.oid=to_regclass($2)`,
  [parent, partition]);
  if (result.rows[0]?.parent_kind !== 'p' || result.rows[0]?.child_kind !== 'r'
      || result.rows[0]?.bound
        !== `FOR VALUES FROM ('${start}') TO ('${start + PARTITION_SIZE}')`) {
    throw new Error('selected event partition is absent or has unexpected bounds');
  }
  return partition;
}

async function assertFinalized(client, start) {
  const result = await client.query(`SELECT finalized_head, recovery_state
    FROM public.robinhood_chain_capture_cursor WHERE chain='robinhood'`);
  if (result.rows[0]?.recovery_state !== 'running'
      || result.rows[0]?.finalized_head == null
      || BigInt(result.rows[0].finalized_head) < BigInt(start + PARTITION_SIZE - 1)) {
    throw new Error('event partition is not entirely finalized');
  }
}

async function assertCapturePaused(client, start, expectedNextBlock, options = {}) {
  const leaseKey = options.leaseKey || CAPTURE_LEASE;
  const result = await client.query(`SELECT cursor.next_block::text,
      cursor.checkpoint_block::text, cursor.recovery_state,
      EXISTS (SELECT 1 FROM worker_leases
        WHERE lease_key=$1 AND lease_until>NOW()) AS capture_active
    FROM public.robinhood_chain_capture_cursor cursor
    WHERE cursor.chain='robinhood' FOR UPDATE OF cursor NOWAIT`, [leaseKey]);
  const row = result.rows[0];
  if (!row || row.recovery_state !== 'running' || row.capture_active
      || row.next_block == null || row.checkpoint_block == null
      || BigInt(row.next_block) !== BigInt(expectedNextBlock)
      || BigInt(row.checkpoint_block) + 1n !== BigInt(row.next_block)
      || BigInt(row.next_block) < BigInt(start)
      || BigInt(row.next_block) >= BigInt(start + PARTITION_SIZE)) {
    throw new Error('capture is active or its stopped checkpoint differs from the expected active partition');
  }
  return row.next_block;
}

async function inspectLeaf(client, leaf, options = {}) {
  const table = relation(leaf);
  const oldName = options.oldName || OLD_FK;
  const newName = identifier(options.newName || NEW_FK);
  const oldParent = options.oldParent || LEGACY;
  const newParent = options.newParent || SHADOW;
  const result = await client.query(`SELECT conname, convalidated,
      confrelid=$2::regclass AS old_parent,
      confrelid=$3::regclass AS new_parent,
      pg_get_constraintdef(oid) AS definition
    FROM pg_constraint WHERE contype='f' AND conrelid=to_regclass($1)
      AND conname=ANY($4::text[])`,
  [table, oldParent, newParent, [oldName, newName]]);
  const old = result.rows.find((row) => row.conname === oldName);
  const next = result.rows.find((row) => row.conname === newName);
  if (!old?.old_parent || !old.convalidated
      || !old.definition.includes('FOREIGN KEY (chain, block_hash, transaction_hash)')
      || !old.definition.includes('ON DELETE CASCADE')) {
    throw new Error(`${table}: validated legacy transaction FK is missing`);
  }
  const expected = 'FOREIGN KEY (chain, block_number, block_hash, transaction_hash)';
  const reference = 'REFERENCES robinhood_chain_transactions_shadow(chain, block_number, block_hash, transaction_hash)';
  if (next && (!next.new_parent || !next.definition.includes(expected)
      || !next.definition.includes(reference)
      || !next.definition.includes('ON DELETE CASCADE'))) {
    throw new Error(`${table}: replacement transaction FK has unexpected definition`);
  }
  return { partition: table, prepared: Boolean(next), validated: Boolean(next?.convalidated) };
}

async function prepareLeaf(client, leaf, options = {}) {
  const state = await inspectLeaf(client, leaf, options);
  if (state.prepared) return state;
  const table = relation(leaf);
  const newName = identifier(options.newName || NEW_FK);
  const newParent = relation(options.newParent || SHADOW);
  await client.query(`ALTER TABLE ${table} ADD CONSTRAINT ${newName}
    FOREIGN KEY (chain, block_number, block_hash, transaction_hash)
    REFERENCES ${newParent}(chain, block_number, block_hash, transaction_hash)
    ON DELETE CASCADE NOT VALID`);
  return inspectLeaf(client, leaf, options);
}

async function validateLeaf(client, leaf, options = {}) {
  const state = await inspectLeaf(client, leaf, options);
  if (!state.prepared) throw new Error(`${leaf}: run --prepare first`);
  if (state.validated) return state;
  const newName = options.newName || NEW_FK;
  await client.query(`ALTER TABLE ${relation(leaf)} VALIDATE CONSTRAINT ${newName}`);
  return inspectLeaf(client, leaf, options);
}

async function run(input, options = {}) {
  if (!['read-only', 'prepare', 'validate'].includes(input.action)) {
    throw new Error('invalid FK migration action');
  }
  const database = options.database || db;
  const client = await database.getClient();
  try {
    await client.query(input.action === 'read-only' ? 'BEGIN READ ONLY' : 'BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query(input.action === 'validate'
      ? "SET LOCAL statement_timeout = '15min'"
      : "SET LOCAL statement_timeout = '60s'");
    const leaf = await resolvePartition(client, input.partitionStart);
    let state;
    if (input.action === 'read-only') {
      state = await inspectLeaf(client, leaf);
    } else {
      if (input.paused) {
        await assertCapturePaused(client, input.partitionStart, input.expectedNextBlock);
      } else {
        await assertFinalized(client, input.partitionStart);
      }
      state = input.action === 'prepare'
        ? await prepareLeaf(client, leaf) : await validateLeaf(client, leaf);
    }
    await client.query('COMMIT');
    return { mode: input.action, partitionStart: input.partitionStart, ...state };
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
  console.error('Robinhood transaction/event FK migration failed:', error.message);
  process.exitCode = 1;
});

module.exports = { assertCapturePaused, assertFinalized, inspectLeaf, parseArgs, prepareLeaf,
  resolvePartition, run, validateLeaf };
