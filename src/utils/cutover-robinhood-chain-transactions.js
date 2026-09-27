'use strict';

/** Swap the canonical transaction table only after audited parity and event FK migration. */
const fs = require('node:fs');
const db = require('../models/db');

const ACTIVE = 'public.robinhood_chain_transactions';
const SHADOW = 'public.robinhood_chain_transactions_shadow';
const RETIRED = 'public.robinhood_chain_transactions_retired';
const EVENTS = 'public.robinhood_chain_events';
const OLD_FK = 'rh_chain_events_shadow_transaction_fkey';
const NEW_FK = 'rh_chain_events_transaction_shadow_fkey';
const CAPTURE_LEASE = 'robinhood-chain-capture-worker';

function parseArgs(args = []) {
  const values = {};
  for (const arg of args) {
    if (arg === '--apply' && !values.apply) values.apply = true;
    else {
      const match = /^--(expected-next-block|audit-report)=(.+)$/.exec(arg);
      if (!match || values[match[1]] != null) throw new Error(`invalid argument: ${arg}`);
      values[match[1]] = match[2];
    }
  }
  const expectedNextBlock = Number(values['expected-next-block']);
  if (values.apply && (!Number.isSafeInteger(expectedNextBlock)
      || expectedNextBlock < 1 || !values['audit-report'])) {
    throw new Error('--apply requires --expected-next-block=N and --audit-report=PATH');
  }
  if (!values.apply && values['expected-next-block'] != null) {
    throw new Error('--expected-next-block requires --apply');
  }
  return { action: values.apply ? 'apply' : 'read-only',
    auditReport: values['audit-report'] || null,
    ...(values.apply ? { expectedNextBlock } : {}) };
}

function readAuditReports(path) {
  const reports = fs.readFileSync(path, 'utf8').trim().split(/\r?\n/)
    .map((line) => JSON.parse(line)).filter((item) => item.phase === 'summary');
  if (!reports.length) throw new Error('no complete transaction audit reports');
  for (const [index, report] of reports.entries()) {
    if (report.mode !== 'read-only' || report.verified !== true
        || report.stopReason !== 'complete' || report.nextBlock !== null
        || !Number.isSafeInteger(report.fromBlock)
        || !Number.isSafeInteger(report.throughBlock)
        || report.fromBlock < 0 || report.throughBlock < report.fromBlock
        || !Number.isSafeInteger(report.pages) || report.pages < 1
        || !Number.isSafeInteger(report.transactions) || report.transactions < 0
        || index > 0 && report.fromBlock !== reports[index - 1].throughBlock + 1) {
      throw new Error('transaction audit reports are invalid or not contiguous');
    }
  }
  return { fromBlock: reports[0].fromBlock,
    throughBlock: reports.at(-1).throughBlock, reports: reports.length };
}

async function layout(client) {
  const result = await client.query(`SELECT active.oid::text AS active_oid,
      active.relkind AS active_kind, shadow.oid::text AS shadow_oid,
      shadow.relkind AS shadow_kind, retired.oid::text AS retired_oid,
      retired.relkind AS retired_kind, events.relkind AS events_kind
    FROM pg_class active
    LEFT JOIN pg_class shadow ON shadow.oid=to_regclass($1)
    LEFT JOIN pg_class retired ON retired.oid=to_regclass($2)
    LEFT JOIN pg_class events ON events.oid=to_regclass($3)
    WHERE active.oid=to_regclass($4)`, [SHADOW, RETIRED, EVENTS, ACTIVE]);
  const row = result.rows[0];
  if (row?.active_kind === 'r' && row.shadow_kind === 'p'
      && !row.retired_oid && row.events_kind === 'p') return { phase: 'before', ...row };
  if (row?.active_kind === 'p' && !row.shadow_oid
      && row.retired_kind === 'r' && row.events_kind === 'p') {
    return { phase: 'swapped', ...row };
  }
  throw new Error('transaction relations do not match a known cutover layout');
}

async function captureState(client, lock = false) {
  const result = await client.query(`SELECT cursor.next_block::text,
      cursor.checkpoint_block::text, cursor.finalized_head::text,
      cursor.recovery_state, EXISTS (SELECT 1 FROM worker_leases
        WHERE lease_key=$1 AND lease_until>NOW()) AS capture_active
    FROM public.robinhood_chain_capture_cursor cursor
    WHERE cursor.chain='robinhood' ${lock ? 'FOR UPDATE OF cursor NOWAIT' : ''}`,
  [CAPTURE_LEASE]);
  const row = result.rows[0];
  if (!row || row.recovery_state !== 'running' || row.checkpoint_block == null
      || row.finalized_head == null
      || BigInt(row.next_block) !== BigInt(row.checkpoint_block) + 1n
      || BigInt(row.finalized_head) > BigInt(row.checkpoint_block)) {
    throw new Error('capture cursor is not ready for transaction cutover');
  }
  return row;
}

async function assertEventFks(client, state) {
  const root = await client.query(`SELECT conname, convalidated,
      confrelid=$2::oid AS references_old,
      pg_get_constraintdef(oid) AS definition
    FROM pg_constraint WHERE conrelid=to_regclass($1) AND contype='f'`,
  [EVENTS, state.active_oid]);
  if (root.rows.length !== 1 || root.rows[0].conname !== OLD_FK
      || !root.rows[0].convalidated || !root.rows[0].references_old
      || !root.rows[0].definition.includes(
        'FOREIGN KEY (chain, block_hash, transaction_hash)')
      || !root.rows[0].definition.includes('ON DELETE CASCADE')) {
    throw new Error('event parent lacks its validated legacy transaction FK');
  }
  const leaves = await client.query(`SELECT child.oid,
      child.relname, replacement.convalidated AS replacement_validated,
      replacement.confrelid=$2::oid AS references_shadow,
      pg_get_constraintdef(replacement.oid) AS definition
    FROM pg_inherits inheritance
    JOIN pg_class child ON child.oid=inheritance.inhrelid
    LEFT JOIN pg_constraint replacement ON replacement.conrelid=child.oid
      AND replacement.conname=$3 AND replacement.conparentid=0
      AND replacement.contype='f'
    WHERE inheritance.inhparent=to_regclass($1)`,
  [EVENTS, state.shadow_oid, NEW_FK]);
  if (!leaves.rows.length || leaves.rows.some((row) => !row.replacement_validated
      || !row.references_shadow
      || !row.definition.includes(
        'FOREIGN KEY (chain, block_number, block_hash, transaction_hash)')
      || !row.definition.includes('ON DELETE CASCADE'))) {
    throw new Error('every event partition needs a validated FK to transaction shadow');
  }
  const other = await client.query(`SELECT conrelid::regclass::text AS child, conname
    FROM pg_constraint WHERE contype='f' AND confrelid=$1::oid
      AND conparentid=0 AND conrelid<>to_regclass($2) LIMIT 1`,
  [state.active_oid, EVENTS]);
  if (other.rows.length) throw new Error('another FK still references monolithic transactions');
  const views = await client.query(`SELECT EXISTS (SELECT 1 FROM pg_depend dependency
    JOIN pg_rewrite rewrite ON rewrite.oid=dependency.objid
    JOIN pg_class relation ON relation.oid=rewrite.ev_class
    WHERE dependency.refobjid=$1::oid
      AND dependency.classid='pg_rewrite'::regclass
      AND relation.relkind IN ('v','m') LIMIT 1) AS dependent`,
  [state.active_oid]);
  if (views.rows[0]?.dependent) throw new Error('a view still depends on monolithic transactions');
  return leaves.rows.length;
}

async function assertNextPartition(client, nextBlock) {
  const start = BigInt(nextBlock) / 250000n * 250000n;
  const result = await client.query(`SELECT
      EXISTS (SELECT 1 FROM pg_inherits WHERE inhparent=to_regclass($1)
        AND inhrelid=to_regclass($2)) AS transactions_ready,
      EXISTS (SELECT 1 FROM pg_inherits WHERE inhparent=to_regclass($3)
        AND inhrelid=to_regclass($4)) AS events_ready`,
  [SHADOW, `${SHADOW}_b${start}`, EVENTS,
    `public.robinhood_chain_events_shadow_b${start}`]);
  if (!result.rows[0]?.transactions_ready || !result.rows[0]?.events_ready) {
    throw new Error('next capture block lacks a transaction or event partition');
  }
  return start.toString();
}

async function tailParity(client, fromBlock, checkpointBlock) {
  if (fromBlock > checkpointBlock) return null;
  if (checkpointBlock - fromBlock + 1n > 64n) {
    throw new Error('unaudited transaction tail exceeds 64 blocks');
  }
  const result = await client.query(`WITH blocks AS MATERIALIZED (
      SELECT chain, block_number, block_hash FROM public.robinhood_chain_blocks
      WHERE chain='robinhood' AND block_number BETWEEN $1::bigint AND $2::bigint
    ), source AS MATERIALIZED (
      SELECT tx.*, block.block_number FROM blocks block
      JOIN LATERAL (SELECT item.* FROM ${ACTIVE} item
        WHERE item.chain=block.chain AND item.block_hash=block.block_hash
        OFFSET 0) tx ON TRUE
    ), copy AS MATERIALIZED (
      SELECT * FROM ${SHADOW} WHERE chain='robinhood'
        AND block_number BETWEEN $1::bigint AND $2::bigint
    ) SELECT EXISTS (SELECT 1 FROM source original FULL JOIN copy mirror
      ON mirror.chain=original.chain AND mirror.block_number=original.block_number
      AND mirror.block_hash=original.block_hash
      AND mirror.transaction_hash=original.transaction_hash
      WHERE to_jsonb(original) IS DISTINCT FROM to_jsonb(mirror) LIMIT 1) AS differs`,
  [fromBlock.toString(), checkpointBlock.toString()]);
  if (result.rows[0]?.differs !== false) throw new Error('transaction tail differs from shadow');
  return fromBlock.toString();
}

async function inspectBefore(client, state, reports, lock = false) {
  const capture = await captureState(client, lock);
  const eventPartitions = await assertEventFks(client, state);
  const nextPartitionStart = await assertNextPartition(client, capture.next_block);
  const first = await client.query(`SELECT min(block_number)::text AS first_block
    FROM public.robinhood_chain_blocks WHERE chain='robinhood'`);
  const earliest = first.rows[0]?.first_block;
  if (earliest == null) throw new Error('canonical block journal is empty');
  let auditedThrough = null;
  let checkedFrom = null;
  if (reports) {
    if (BigInt(reports.fromBlock) > BigInt(earliest)
        || BigInt(reports.throughBlock) < BigInt(capture.finalized_head)
        || BigInt(reports.throughBlock) > BigInt(capture.checkpoint_block)) {
      throw new Error('audit reports do not cover the retained transaction journal');
    }
    auditedThrough = String(reports.throughBlock);
    checkedFrom = await tailParity(client, BigInt(reports.throughBlock) + 1n,
      BigInt(capture.checkpoint_block));
    const beyond = await client.query(`SELECT EXISTS (SELECT 1 FROM
      public.robinhood_chain_blocks WHERE chain='robinhood'
      AND block_number>$1::bigint LIMIT 1) AS present`, [capture.checkpoint_block]);
    if (beyond.rows[0]?.present) throw new Error('blocks exist after capture checkpoint');
  }
  return { phase: 'before', ready: Boolean(reports) && !capture.capture_active,
    activeOid: state.active_oid, shadowOid: state.shadow_oid,
    earliestBlock: earliest, eventPartitions, nextPartitionStart,
    auditedThrough, checkedFrom, ...capture };
}

async function swap(client, expectedNextBlock, reports) {
  if (!reports) throw new Error('complete transaction audit reports are required');
  await client.query(`LOCK TABLE ${ACTIVE}, ${SHADOW}, ${EVENTS}
    IN ACCESS EXCLUSIVE MODE`);
  const state = await layout(client);
  if (state.phase !== 'before') throw new Error('transaction cutover already started');
  const before = await inspectBefore(client, state, reports, true);
  if (before.capture_active || BigInt(before.next_block) !== BigInt(expectedNextBlock)) {
    throw new Error('stop capture and use its current next_block');
  }
  await swapRelations(client);
  const after = await layout(client);
  if (after.phase !== 'swapped' || after.active_oid !== state.shadow_oid
      || after.retired_oid !== state.active_oid) {
    throw new Error('transaction relation identities changed during cutover');
  }
  return { ...before, phase: 'swapped', activeOid: after.active_oid,
    retiredOid: after.retired_oid, shadowOid: null };
}

async function swapRelations(client, options = {}) {
  const active = options.active || ACTIVE;
  const shadow = options.shadow || SHADOW;
  const retired = options.retired || RETIRED;
  const events = options.events || EVENTS;
  const oldFk = options.oldFk || OLD_FK;
  if (![active, shadow, retired, events].every((value) => /^public\.[a-z_][a-z0-9_]*$/.test(value))
      || !/^[a-z_][a-z0-9_]*$/.test(oldFk)) throw new Error('invalid cutover relation');
  await client.query(`ALTER TABLE ${events} DROP CONSTRAINT ${oldFk}`);
  const remaining = await client.query(`SELECT EXISTS (SELECT 1 FROM pg_constraint
    WHERE contype='f' AND confrelid=to_regclass($1) LIMIT 1) AS present`, [active]);
  if (remaining.rows[0]?.present) throw new Error('legacy transaction FKs remain after drop');
  await client.query(`ALTER TABLE ${active} RENAME TO ${retired.split('.')[1]}`);
  await client.query(`ALTER TABLE ${shadow} RENAME TO ${active.split('.')[1]}`);
}

async function run(input, options = {}) {
  const database = options.database || db;
  const reports = input.auditReport ? readAuditReports(input.auditReport) : null;
  const client = await database.getClient();
  try {
    await client.query(input.action === 'apply'
      ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '60s'");
    const state = await layout(client);
    const result = input.action === 'apply'
      ? await swap(client, input.expectedNextBlock, reports)
      : state.phase === 'before'
        ? await inspectBefore(client, state, reports) : state;
    await client.query('COMMIT');
    return { mode: input.action, ...result };
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
  console.error('Robinhood transaction cutover failed:', error.message);
  process.exitCode = 1;
});

module.exports = { parseArgs, readAuditReports, layout, captureState,
  assertEventFks, assertNextPartition, tailParity, inspectBefore, swapRelations, swap, run };
