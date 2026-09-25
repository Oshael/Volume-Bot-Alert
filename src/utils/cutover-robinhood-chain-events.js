'use strict';

/** Replace the monolithic event journal, then remove it only after a full parity audit. */
const fs = require('node:fs');
const db = require('../models/db');

const ACTIVE = 'public.robinhood_chain_events';
const SHADOW = 'public.robinhood_chain_events_shadow';
const RETIRED = 'public.robinhood_chain_events_retired';
const CAPTURE_LEASE = 'robinhood-chain-capture-worker';

function parseArgs(args = []) {
  const input = {};
  for (const arg of args) {
    if (arg === '--apply' || arg === '--drop-retired') {
      if (input.action) throw new Error('choose only one action');
      input.action = arg.slice(2);
      continue;
    }
    const match = /^--(expected-next-block|audit-report)=(.+)$/.exec(arg);
    if (!match || input[match[1]] != null) throw new Error(`invalid argument: ${arg}`);
    input[match[1]] = match[2];
  }
  if (input.action === 'apply') {
    const block = Number(input['expected-next-block']);
    if (!Number.isSafeInteger(block) || block < 1 || input['audit-report']) {
      throw new Error('--apply requires --expected-next-block=N');
    }
    return { action: 'apply', expectedNextBlock: block };
  }
  if (input.action === 'drop-retired') {
    if (!input['audit-report'] || input['expected-next-block']) {
      throw new Error('--drop-retired requires --audit-report=PATH');
    }
    return { action: 'drop-retired', auditReport: input['audit-report'] };
  }
  if (input['expected-next-block'] || input['audit-report']) {
    throw new Error('read-only mode takes no arguments');
  }
  return { action: 'read-only' };
}

function readAuditReport(path) {
  const lines = fs.readFileSync(path, 'utf8').trim().split(/\r?\n/);
  const report = JSON.parse(lines.at(-1));
  if (report.phase !== 'summary' || report.mode !== 'read-only'
      || report.verified !== true || report.stopReason !== 'complete'
      || report.nextBlock !== null || !Number.isSafeInteger(report.fromBlock)
      || !Number.isSafeInteger(report.throughBlock)
      || report.fromBlock > report.throughBlock
      || !Number.isSafeInteger(report.pages) || report.pages < 1
      || !Number.isSafeInteger(report.events) || report.events < 1
      || report.source !== RETIRED || report.shadow !== ACTIVE) {
    throw new Error('audit report does not prove complete retired/active parity');
  }
  return report;
}

async function layout(client) {
  const result = await client.query(`SELECT
      active.oid::text AS active_oid, active.relkind AS active_kind,
      shadow.oid::text AS shadow_oid, shadow.relkind AS shadow_kind,
      retired.oid::text AS retired_oid, retired.relkind AS retired_kind
    FROM pg_class active
    LEFT JOIN pg_class shadow ON shadow.oid=to_regclass($1)
    LEFT JOIN pg_class retired ON retired.oid=to_regclass($2)
    WHERE active.oid=to_regclass($3)`, [SHADOW, RETIRED, ACTIVE]);
  const row = result.rows[0];
  if (row?.active_kind === 'p' && !row.shadow_oid && row.retired_kind === 'r') {
    return { phase: 'swapped', ...row };
  }
  if (row?.active_kind === 'p' && !row.shadow_oid && !row.retired_oid) {
    return { phase: 'complete', ...row };
  }
  if (row?.active_kind === 'r' && row.shadow_kind === 'p' && !row.retired_oid) {
    return { phase: 'before', ...row };
  }
  throw new Error('event relations do not match a known cutover phase');
}

async function boundary(client, relation, aggregate) {
  const result = await client.query(`SELECT ${aggregate}(block_number)::text AS block
    FROM ${relation} WHERE chain='robinhood'`);
  const block = result.rows[0]?.block;
  if (block == null) throw new Error(`${relation} has no Robinhood events`);
  return BigInt(block);
}

async function assertDependencies(client, state) {
  const result = await client.query(`SELECT conrelid::regclass::text AS child,
      conname, confrelid::text AS parent_oid, convalidated
    FROM pg_constraint WHERE contype='f'
      AND confrelid=ANY($1::oid[])`, [[state.active_oid, state.shadow_oid]]);
  if (result.rows.some((row) => row.parent_oid === state.active_oid)) {
    throw new Error('monolithic events still have referencing foreign keys');
  }
  const views = await client.query(`SELECT EXISTS (
      SELECT 1 FROM pg_depend dependency
      JOIN pg_rewrite rewrite ON rewrite.oid=dependency.objid
      JOIN pg_class relation ON relation.oid=rewrite.ev_class
      WHERE dependency.refobjid=$1::oid
        AND dependency.classid='pg_rewrite'::regclass
        AND relation.relkind IN ('v', 'm') LIMIT 1
    ) AS has_dependent_view`, [state.active_oid]);
  if (views.rows[0]?.has_dependent_view) {
    throw new Error('monolithic events still have dependent views');
  }
  const required = [
    ['robinhood_chain_domain_outbox', 'rh_chain_domain_outbox_event_fkey'],
    ['robinhood_canonical_head_candidates', 'rh_canonical_head_candidates_event_fkey'],
  ];
  for (const [child, name] of required) {
    if (!result.rows.some((row) => row.child === child && row.conname === name
        && row.parent_oid === state.shadow_oid && row.convalidated)) {
      throw new Error(`${child} has no validated FK to partitioned events`);
    }
  }
}

async function captureState(client) {
  const result = await client.query(`SELECT cursor.next_block::text,
      cursor.checkpoint_block::text, cursor.finalized_head::text,
      cursor.recovery_state, EXISTS (
        SELECT 1 FROM worker_leases WHERE lease_key=$1 AND lease_until>NOW()
      ) AS capture_active
    FROM robinhood_chain_capture_cursor cursor WHERE cursor.chain='robinhood'`,
  [CAPTURE_LEASE]);
  const row = result.rows[0];
  if (!row || row.recovery_state !== 'running' || row.checkpoint_block == null
      || BigInt(row.next_block) !== BigInt(row.checkpoint_block) + 1n
      || row.finalized_head == null
      || BigInt(row.finalized_head) > BigInt(row.checkpoint_block)) {
    throw new Error('capture cursor is not ready for event cutover');
  }
  return row;
}

async function tailParity(client, firstBlock, checkpointBlock) {
  const from = BigInt(checkpointBlock) - 63n > firstBlock
    ? BigInt(checkpointBlock) - 63n : firstBlock;
  const result = await client.query(`WITH source AS MATERIALIZED (
      SELECT * FROM ${ACTIVE} WHERE chain='robinhood'
        AND block_number BETWEEN $1::bigint AND $2::bigint
    ), mirror AS MATERIALIZED (
      SELECT * FROM ${SHADOW} WHERE chain='robinhood'
        AND block_number BETWEEN $1::bigint AND $2::bigint
    ) SELECT EXISTS (
      SELECT 1 FROM source event FULL JOIN mirror copy
        ON copy.chain=event.chain AND copy.block_number=event.block_number
       AND copy.block_hash=event.block_hash AND copy.log_index=event.log_index
      WHERE to_jsonb(event) IS DISTINCT FROM to_jsonb(copy) LIMIT 1
    ) AS differs`, [from.toString(), checkpointBlock]);
  if (result.rows[0]?.differs !== false) throw new Error('event tail differs from shadow');
  return from.toString();
}

async function inspectBefore(client, state) {
  await assertDependencies(client, state);
  const capture = await captureState(client);
  const partitionStart = BigInt(capture.next_block) / 250000n * 250000n;
  const partition = await client.query(`SELECT EXISTS (
      SELECT 1 FROM pg_inherits WHERE inhparent=$1::regclass
        AND inhrelid=to_regclass($2)
    ) AS ready`, [SHADOW, `public.robinhood_chain_events_shadow_b${partitionStart}`]);
  if (!partition.rows[0]?.ready) throw new Error('next capture block has no shadow partition');
  const firstBlock = await boundary(client, SHADOW, 'min');
  if (firstBlock > BigInt(capture.checkpoint_block)) {
    throw new Error('shadow starts after the capture checkpoint');
  }
  return { phase: 'before', activeOid: state.active_oid, shadowOid: state.shadow_oid,
    firstShadowBlock: firstBlock.toString(), ...capture,
    oldBytes: (await client.query(`SELECT pg_total_relation_size($1::regclass)::text AS bytes`,
      [ACTIVE])).rows[0].bytes };
}

async function swap(client, expectedNextBlock) {
  await client.query(`LOCK TABLE ${ACTIVE}, ${SHADOW} IN ACCESS EXCLUSIVE MODE`);
  const state = await layout(client);
  if (state.phase !== 'before') throw new Error('event cutover already started');
  const preflight = await inspectBefore(client, state);
  if (preflight.capture_active || BigInt(preflight.next_block) !== BigInt(expectedNextBlock)) {
    throw new Error('stop capture and use its current next_block');
  }
  const checkedFromBlock = await tailParity(client,
    BigInt(preflight.firstShadowBlock), preflight.checkpoint_block);
  await client.query(`ALTER TABLE ${ACTIVE} RENAME TO robinhood_chain_events_retired`);
  await client.query(`ALTER TABLE ${SHADOW} RENAME TO robinhood_chain_events`);
  const after = await layout(client);
  if (after.phase !== 'swapped' || after.active_oid !== state.shadow_oid
      || after.retired_oid !== state.active_oid) {
    throw new Error('event relation identities changed during cutover');
  }
  return { ...preflight, phase: 'swapped', checkedFromBlock,
    retiredOid: after.retired_oid, activeOid: after.active_oid, shadowOid: null };
}

async function dropRetired(client, report) {
  await client.query(`LOCK TABLE ${RETIRED} IN ACCESS EXCLUSIVE MODE`);
  const state = await layout(client);
  if (state.phase !== 'swapped') throw new Error('retired event table is unavailable');
  const first = await boundary(client, ACTIVE, 'min');
  const last = await boundary(client, RETIRED, 'max');
  if (first !== BigInt(report.fromBlock) || last !== BigInt(report.throughBlock)) {
    throw new Error('audit report does not cover the current event boundary');
  }
  const capture = await captureState(client);
  if (BigInt(capture.finalized_head) < last) {
    throw new Error('retired event tail is not finalized');
  }
  const oldBytes = (await client.query(`SELECT pg_total_relation_size($1::regclass)::text AS bytes`,
    [RETIRED])).rows[0].bytes;
  await client.query(`DROP TABLE ${RETIRED} RESTRICT`);
  if ((await layout(client)).phase !== 'complete') throw new Error('retired drop incomplete');
  return { phase: 'complete', dropped: RETIRED, oldBytes,
    verifiedFromBlock: first.toString(), verifiedThroughBlock: last.toString() };
}

async function run(input = {}, options = {}) {
  const database = options.database || db;
  const client = await database.getClient();
  try {
    await client.query(input.action === 'read-only' ? 'BEGIN READ ONLY' : 'BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '60s'");
    const state = await layout(client);
    let result;
    if (input.action === 'apply') {
      if (state.phase !== 'before') throw new Error('event cutover already started');
      result = await swap(client, input.expectedNextBlock);
    } else if (input.action === 'drop-retired') {
      if (state.phase !== 'swapped') throw new Error('retired event table is unavailable');
      result = await dropRetired(client, readAuditReport(input.auditReport));
    } else {
      result = state.phase === 'before' ? await inspectBefore(client, state) : state;
    }
    await client.query('COMMIT');
    return { mode: input.action || 'read-only', ...result };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) {
  run(parseArgs(process.argv.slice(2))).then((result) => {
    console.log(JSON.stringify(result));
  }).catch((error) => {
    console.error('Robinhood chain event cutover failed:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, readAuditReport, layout, assertDependencies,
  captureState, tailParity, inspectBefore, swap, dropRetired, run };
