'use strict';

/** Read-only inventory for a three-day transaction cutover. Never authorizes deletion. */
require('dotenv').config();
const db = require('../models/db');

const WIDTH = 250000;
const EVENTS = 'robinhood_chain_events';
const SHADOW = 'robinhood_chain_transactions_shadow';
const OLD_FK = 'rh_chain_events_shadow_transaction_fkey';
const NEW_FK = 'rh_chain_events_transaction_shadow_fkey';
const FK_INVENTORY_SQL = `SELECT child.relname AS child,
  fk.conname, fk.convalidated
  FROM pg_constraint fk
  JOIN pg_class child ON child.oid=fk.conrelid
  JOIN pg_inherits inheritance ON inheritance.inhrelid=child.oid
  WHERE inheritance.inhparent=to_regclass('public.robinhood_chain_events')
    AND fk.contype='f'
    AND fk.conname IN ($1, $2)`;

function block(value, label) {
  if (value == null || value === '') throw new Error(`${label} is invalid`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} is invalid`);
  return parsed;
}

function partitionStart(value) { return Math.floor(value / WIDTH) * WIDTH; }

function partitionMap(rows, parent) {
  const partitions = new Map();
  const prefix = parent === EVENTS ? 'robinhood_chain_events_shadow' : parent;
  for (const row of rows.filter((item) => item.parent === parent)) {
    const match = /^FOR VALUES FROM \('([0-9]+)'\) TO \('([0-9]+)'\)$/.exec(row.bound);
    if (!match) throw new Error(`${row.child} has an unexpected partition bound`);
    const start = block(match[1], 'partition start');
    const end = block(match[2], 'partition end');
    if (start % WIDTH !== 0 || end !== start + WIDTH
        || row.child !== `${prefix}_b${start}` || partitions.has(start)) {
      throw new Error(`${row.child} has an unexpected partition layout`);
    }
    partitions.set(start, row.child);
  }
  return partitions;
}

function chooseFloor(boundaries, firstBlock, cutoffAt) {
  const cutoff = new Date(cutoffAt).getTime();
  if (!Number.isFinite(cutoff)) throw new Error('retention cutoff is invalid');
  let floor = partitionStart(firstBlock);
  let previousTime = -Infinity;
  for (const boundary of boundaries) {
    const start = block(boundary.start_block, 'boundary start');
    const first = block(boundary.first_block, 'boundary first block');
    const time = new Date(boundary.block_timestamp).getTime();
    if (start % WIDTH !== 0 || first < start || first >= start + WIDTH
        || !Number.isFinite(time) || time < previousTime) {
      throw new Error(`boundary ${start} is missing or nonmonotonic`);
    }
    if (time <= cutoff) floor = start;
    previousTime = time;
  }
  return floor;
}

function buildReport(state, boundaries, partitionRows, fkRows) {
  const firstBlock = block(state.first_block, 'first canonical block');
  const finalizedHead = block(state.finalized_head, 'finalized head');
  const nextBlock = block(state.next_block, 'next block');
  const checkpoint = block(state.checkpoint_block, 'checkpoint block');
  if (state.recovery_state !== 'running' || firstBlock > finalizedHead
      || checkpoint + 1 !== nextBlock || finalizedHead > checkpoint) {
    throw new Error('capture cursor is not ready for retention planning');
  }
  const firstStart = partitionStart(firstBlock);
  const lastStart = partitionStart(finalizedHead);
  const expectedBoundaries = (lastStart - firstStart) / WIDTH + 1;
  if (boundaries.length !== expectedBoundaries
      || boundaries.some((row, index) => block(row.start_block, 'boundary start')
        !== firstStart + index * WIDTH)) {
    throw new Error('canonical boundary coverage is incomplete');
  }
  const floor = chooseFloor(boundaries, firstBlock, state.cutoff_at);
  const events = partitionMap(partitionRows, EVENTS);
  const shadow = partitionMap(partitionRows, SHADOW);
  const requiredStarts = Array.from(
    { length: (lastStart - floor) / WIDTH + 1 }, (_, index) => floor + index * WIDTH
  );
  const missingEventPartitions = requiredStarts.filter((start) => !events.has(start));
  const missingShadowPartitions = requiredStarts.filter((start) => !shadow.has(start));
  const fks = new Map();
  for (const row of fkRows) {
    if (!fks.has(row.child)) fks.set(row.child, new Map());
    fks.get(row.child).set(row.conname, row.convalidated === true);
  }
  const legacyEventFks = [...events.values()].filter((child) =>
    fks.get(child)?.get(OLD_FK) === true).length;
  const validatedReplacementFks = requiredStarts.filter((start) =>
    fks.get(events.get(start))?.get(NEW_FK) === true).length;
  return Object.freeze({ mode: 'read-only', action: 'none',
    observedAt: state.observed_at, temporalCutoffAt: state.cutoff_at,
    retentionHours: 72, partitionWidthBlocks: WIDTH,
    capture: { nextBlock, checkpointBlock: checkpoint, finalizedHead,
      nodeHead: state.node_head == null ? null : block(state.node_head, 'node head') },
    candidate: { fromBlock: floor, throughBlock: finalizedHead,
      firstCanonicalBlock: firstBlock, historicalEventPartitions: [...events.keys()]
        .filter((start) => start < floor).length,
      retainedEventPartitions: requiredStarts.length },
    layout: { eventPartitions: events.size, shadowPartitions: shadow.size,
      legacyEventFks, validatedReplacementFks,
      missingEventPartitions, missingShadowPartitions },
    proof: 'Boundary inventory only; transaction parity, consumer materialization, '
      + 'FK migration, and cutover remain unverified.',
  });
}

async function inspect(database = db) {
  const client = await database.getClient();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL lock_timeout = '500ms'");
    await client.query("SET LOCAL statement_timeout = '20s'");
    const { rows: states } = await client.query(`SELECT NOW() AS observed_at,
      NOW() - INTERVAL '72 hours' AS cutoff_at, cursor.next_block::text,
      cursor.checkpoint_block::text, cursor.finalized_head::text,
      cursor.node_head::text, cursor.recovery_state,
      (SELECT MIN(block_number)::text FROM robinhood_chain_blocks
        WHERE chain='robinhood' AND canonical) AS first_block
      FROM robinhood_chain_capture_cursor cursor WHERE cursor.chain='robinhood'`);
    const state = states[0];
    if (!state) throw new Error('capture cursor is missing');
    const firstStart = partitionStart(block(state.first_block, 'first canonical block'));
    const lastStart = partitionStart(block(state.finalized_head, 'finalized head'));
    const { rows: boundaries } = await client.query(`SELECT marker.start_block::text,
      first.block_number::text AS first_block, first.block_timestamp
      FROM generate_series($1::bigint, $2::bigint, $3::bigint) marker(start_block)
      LEFT JOIN LATERAL (
        SELECT block_number, block_timestamp FROM robinhood_chain_blocks
        WHERE chain='robinhood' AND canonical
          AND block_number >= marker.start_block
          AND block_number < marker.start_block + $3::bigint
          AND block_number <= $4::bigint
        ORDER BY block_number LIMIT 1
      ) first ON TRUE ORDER BY marker.start_block`,
    [firstStart, lastStart, WIDTH, state.finalized_head]);
    const { rows: partitions } = await client.query(`SELECT parent.relname AS parent,
      child.relname AS child, pg_get_expr(child.relpartbound, child.oid) AS bound
      FROM pg_inherits inheritance
      JOIN pg_class parent ON parent.oid=inheritance.inhparent
      JOIN pg_class child ON child.oid=inheritance.inhrelid
      WHERE parent.oid IN (to_regclass('public.robinhood_chain_events'),
        to_regclass('public.robinhood_chain_transactions_shadow'))`);
    const { rows: fks } = await client.query(FK_INVENTORY_SQL, [OLD_FK, NEW_FK]);
    const report = buildReport(state, boundaries, partitions, fks);
    await client.query('COMMIT');
    return report;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

if (require.main === module) inspect().then((report) => {
  console.log(JSON.stringify(report, null, 2));
}).catch((error) => {
  console.error('Robinhood transaction retention plan failed:', error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = { FK_INVENTORY_SQL, WIDTH, buildReport, chooseFloor, inspect, partitionMap };
