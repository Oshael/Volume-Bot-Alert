'use strict';

/** Restore finalized events missed during the shadow rollout after name cutover. */
require('dotenv').config();
const db = require('../models/db');
const { comparePage } = require('./audit-robinhood-chain-event-shadow');
const {
  assertBoundedSource, assertFinalizedPage, normalizeOptions,
} = require('./copy-robinhood-chain-event-shadow-page');
const {
  checkHealth, parseArgs, runPages, shadowVolumePath,
} = require('./run-robinhood-chain-event-shadow-copy-batches');

const SOURCE = 'public.robinhood_chain_events_retired';
const TARGET = 'public.robinhood_chain_events';
const RELATION = /^(?:public|pg_temp)\.[a-z][a-z0-9_]*$/;

function relations(input) {
  const source = input?.source || SOURCE;
  const target = input?.target || TARGET;
  if (!RELATION.test(source) || !RELATION.test(target) || source === target) {
    throw new Error('repair requires two distinct qualified event relations');
  }
  return { source, target };
}

async function assertCutoverLayout(client, source, target) {
  const result = await client.query(`SELECT old.relkind AS source_kind,
      active.relkind AS target_kind
    FROM pg_class old JOIN pg_class active ON active.oid=to_regclass($2)
    WHERE old.oid=to_regclass($1)`, [source, target]);
  if (result.rows[0]?.source_kind !== 'r' || result.rows[0]?.target_kind !== 'p') {
    throw new Error('retired source and partitioned active events are required');
  }
}

async function pageCounts(client, source, target, fromBlock, pageEnd) {
  const { rows } = await client.query(`WITH source AS MATERIALIZED (
      SELECT * FROM ${source} event WHERE chain='robinhood'
        AND block_number >= $1::bigint AND block_number < $2::bigint
    ) SELECT count(*)::bigint AS events,
        COALESCE(sum(pg_column_size(source)), 0)::bigint AS source_bytes,
        (SELECT count(*)::bigint FROM ${target} copy
          WHERE copy.chain='robinhood' AND copy.block_number >= $1::bigint
            AND copy.block_number < $2::bigint) AS target_events
      FROM source`, [fromBlock, pageEnd + 1]);
  assertBoundedSource(rows[0]);
  assertBoundedSource({ events: rows[0].target_events, source_bytes: '0' });
  return rows[0];
}

async function insertMissing(client, source, target, fromBlock, pageEnd) {
  const { rows } = await client.query(`WITH inserted AS (
      INSERT INTO ${target} (
        chain, block_hash, block_number, transaction_hash, transaction_index,
        log_index, address, topic0, topics, data, captured_at
      ) SELECT event.chain, event.block_hash, event.block_number,
          event.transaction_hash, event.transaction_index, event.log_index,
          event.address, event.topic0, event.topics, event.data, event.captured_at
        FROM ${source} event
       WHERE event.chain='robinhood' AND event.block_number >= $1::bigint
         AND event.block_number < $2::bigint
         AND NOT EXISTS (
           SELECT 1 FROM ${target} copy
            WHERE copy.chain=event.chain AND copy.block_number=event.block_number
              AND copy.block_hash=event.block_hash AND copy.log_index=event.log_index
         )
      ON CONFLICT (chain, block_number, block_hash, log_index) DO NOTHING
      RETURNING 1
    ) SELECT count(*)::int AS inserted FROM inserted`, [fromBlock, pageEnd + 1]);
  return rows[0].inserted;
}

async function pageParity(client, page, counts, source, target) {
  if (!page.apply && counts.events !== counts.target_events) {
    return { mismatch: 'count' };
  }
  return comparePage(client, page.fromBlock, page.pageEnd, { source, shadow: target });
}

async function repairPage(input, deps = {}) {
  const page = normalizeOptions(input);
  const { source, target } = relations(deps.relations);
  const client = deps.client || await (deps.database || db).getClient();
  try {
    await client.query(page.apply ? 'BEGIN ISOLATION LEVEL REPEATABLE READ'
      : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL lock_timeout = '500ms'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    await assertCutoverLayout(client, source, target);
    if (page.apply) {
      const lock = await client.query(`SELECT pg_try_advisory_xact_lock(
        hashtext('robinhood-chain-event-retired-repair')) AS locked`);
      if (!lock.rows[0]?.locked) throw new Error('another retired event repair is running');
    }
    await (deps.assertFinalizedPage || assertFinalizedPage)(client, page.pageEnd);
    const counts = await pageCounts(client, source, target, page.fromBlock, page.pageEnd);
    let inserted = 0;
    if (page.apply && BigInt(counts.events) > BigInt(counts.target_events)) {
      inserted = await insertMissing(client, source, target, page.fromBlock, page.pageEnd);
    }
    const parity = await pageParity(client, page, counts, source, target);
    if (page.apply && parity.mismatch) {
      throw new Error(`retired/active event mismatch at ${page.fromBlock}-${page.pageEnd}: ${JSON.stringify(parity.mismatch)}`);
    }
    await client.query('COMMIT');
    return { mode: page.apply ? 'apply' : 'read-only',
      fromBlock: page.fromBlock, pageEnd: page.pageEnd,
      nextBlock: page.pageEnd < page.throughBlock ? page.pageEnd + 1 : null,
      sourceEvents: Number(counts.events), targetEventsBefore: Number(counts.target_events),
      inserted, mismatch: parity.mismatch };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    if (!deps.client) client.release();
  }
}

async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  let lastNextBlock = options.fromBlock;
  let completedPages = 0;
  let inserted = 0;
  try {
    const report = await runPages(options, {
      copy: repairPage,
      volumePath: (database) => shadowVolumePath(database, TARGET),
      guard: (database, path) => checkHealth(database, path, 'false'),
      progress: (entry) => {
        if (entry.phase === 'page') {
          lastNextBlock = entry.nextBlock;
          completedPages += 1;
          inserted += entry.inserted;
        }
        console.log(JSON.stringify(entry));
      },
    });
    console.log(JSON.stringify({ phase: 'summary', source: SOURCE, target: TARGET, ...report }));
    if (['disk_floor', 'capture_health'].includes(report.stopReason)) process.exitCode = 2;
  } catch (error) {
    console.error(JSON.stringify({ phase: 'summary', mode: options.apply ? 'apply' : 'read-only',
      source: SOURCE, target: TARGET, pages: completedPages, inserted,
      nextBlock: lastNextBlock, stopReason: 'error', errorCode: error.code || null,
      error: error.message }));
    process.exitCode = 1;
  } finally {
    await db.pool.end();
  }
}

if (require.main === module) main().catch((error) => {
  console.error('Robinhood retired event repair failed:', error.message);
  process.exitCode = 1;
});

module.exports = { assertCutoverLayout, pageCounts, repairPage, relations };
