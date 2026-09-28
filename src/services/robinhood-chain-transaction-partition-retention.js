'use strict';

/** Keep complete transaction partitions for at least 72 hours without dropping events. */
const db = require('../models/db');
const { createRobinhoodRetentionSafetyAudit } = require('./robinhood-retention-safety-audit');
const { createTimeoutDiagnostic } = require('./robinhood-retention-timeout-diagnostic');

const WIDTH = 250000;
const RETENTION_MS = 72 * 60 * 60 * 1000;
const PARENT = 'public.robinhood_chain_transactions';
const EVENT_PARENT = 'public.robinhood_chain_events';
const FK = 'rh_chain_events_transaction_shadow_fkey';

function partition(row) {
  const name = String(row.name || '');
  const match = /^robinhood_chain_transactions_shadow_b(\d+)$/.exec(name);
  const start = Number(match?.[1]);
  if (!Number.isSafeInteger(start) || start % WIDTH !== 0
      || row.bound !== `FOR VALUES FROM ('${start}') TO ('${start + WIDTH}')`
      || row.detach_pending) {
    throw new Error(`unexpected transaction partition: ${name}`);
  }
  return { start, end: start + WIDTH, name: `public.${name}`,
    event: `public.robinhood_chain_events_shadow_b${start}`, bytes: row.bytes };
}

function coverageFloor(partitions, head, excludedStart) {
  let expected = Math.floor(head / WIDTH) * WIDTH;
  const starts = new Set(partitions.map((item) => item.start));
  if (!starts.has(expected) || expected === excludedStart) return null;
  while (starts.has(expected - WIDTH) && expected - WIDTH !== excludedStart) {
    expected -= WIDTH;
  }
  return expected;
}

function coverageBlockers(input, candidate) {
  const { safety, cursor, firstRemainingTime, candidateRecent } = input;
  const blockers = [];
  const add = (condition, code) => { if (condition) blockers.push(code); };
  const finalized = cursor?.finalized_head == null ? NaN : Number(cursor.finalized_head);
  const rawCutoff = safety?.chain_events?.candidate_cutoff_block;
  const cutoff = rawCutoff == null ? NaN : Number(rawCutoff);
  const firstTime = firstRemainingTime == null ? null : new Date(firstRemainingTime);
  const now = new Date(cursor?.observed_at);
  add(safety?.chain_events?.ready_for_pilot !== true, 'consumer_safety_blocked');
  add(cursor?.recovery_state !== 'running' || !Number.isSafeInteger(finalized),
    'capture_not_running');
  add(!candidate, 'no_transaction_partition');
  add(!Number.isSafeInteger(input.remainingFloor), 'transaction_coverage_gap');
  add(firstTime == null || !Number.isFinite(firstTime.getTime())
    || !Number.isFinite(now.getTime())
    || firstTime.getTime() > now.getTime() - RETENTION_MS, 'less_than_72h_remaining');
  add(candidate && (!Number.isSafeInteger(cutoff) || candidate.end > cutoff
    || candidate.end - 1 > finalized), 'consumer_frontier_before_partition_end');
  add(candidateRecent !== false, 'transaction_partition_within_72h');
  return blockers;
}

function dependencyBlockers(input, candidate) {
  const { pending_bundle: pendingBundle, pinned_deployment: pinnedDeployment,
    eventFks } = input;
  const blockers = [];
  const add = (condition, code) => { if (condition) blockers.push(code); };
  const rawPendingHolder = input.oldestUnappliedBlock;
  const pendingHolder = rawPendingHolder == null ? null : Number(rawPendingHolder);
  add(rawPendingHolder != null && !Number.isSafeInteger(pendingHolder),
    'invalid_holder_pending_block');
  add(pendingHolder != null && Number.isSafeInteger(pendingHolder) && candidate
    && pendingHolder < candidate.end, 'unapplied_holder_event_in_partition');
  add(pendingBundle !== false, 'pending_bundle_funding_in_partition');
  add(pinnedDeployment !== false, 'deployment_mint_in_partition');
  add(eventFks?.length > 1 || eventFks?.some((fk) =>
    fk.name !== FK || fk.validated !== true || fk.references_parent !== true),
  'unexpected_event_fk');
  return blockers;
}

function decide(input) {
  const candidate = input.parts[0] || null;
  const blockers = [...coverageBlockers(input, candidate),
    ...dependencyBlockers(input, candidate)];
  return { ready: blockers.length === 0, blockers,
    candidate: candidate && { start: candidate.start, end: candidate.end,
      name: candidate.name, bytes: candidate.bytes },
    eventPartition: candidate?.event || null,
    dropEventFk: input.eventFks?.length === 1,
    remainingFloor: input.remainingFloor,
    remainingFirstBlockAt: input.firstRemainingTime || null,
    observedAt: input.cursor?.observed_at || null };
}

async function eventConstraints(client, candidate) {
  if (!candidate) return [];
  const { rows: eventFks } = await client.query(`SELECT conname AS name,
      convalidated AS validated, confrelid=to_regclass($2) AS references_parent
    FROM pg_constraint WHERE conrelid=to_regclass($1) AND contype='f'
      AND conparentid=0`, [candidate.event, PARENT]);
  const { rows: eventLayout } = await client.query(`SELECT
      pg_get_expr(child.relpartbound, child.oid) AS bound
    FROM pg_inherits inheritance JOIN pg_class child ON child.oid=inheritance.inhrelid
    WHERE inheritance.inhparent=to_regclass($1) AND child.oid=to_regclass($2)`,
  [EVENT_PARENT, candidate.event]);
  if (eventLayout[0]?.bound
      !== `FOR VALUES FROM ('${candidate.start}') TO ('${candidate.end}')`) {
    throw new Error('matching event partition is missing or has different bounds');
  }
  return eventFks;
}

async function loadPartitions(client, detachedCandidate) {
  const { rows: catalog } = await client.query(`SELECT child.relname AS name,
      pg_get_expr(child.relpartbound, child.oid) AS bound,
      pg_total_relation_size(child.oid)::text AS bytes,
      inheritance.inhdetachpending AS detach_pending
    FROM pg_inherits inheritance JOIN pg_class child ON child.oid=inheritance.inhrelid
    WHERE inheritance.inhparent=to_regclass($1)`, [PARENT]);
  const parts = catalog.map(partition);
  const { rows: detached } = await client.query(`SELECT child.relname
    FROM pg_class child JOIN pg_namespace namespace ON namespace.oid=child.relnamespace
    WHERE namespace.nspname='public' AND child.relkind='r'
      AND child.relname ~ '^robinhood_chain_transactions_shadow_b[0-9]+$'
      AND NOT EXISTS (SELECT 1 FROM pg_inherits WHERE inhrelid=child.oid)
    ORDER BY child.relname LIMIT 1`);
  if (detachedCandidate) {
    if (detached[0]?.relname !== detachedCandidate.name.split('.')[1]
        || parts.some((item) => item.start === detachedCandidate.start)) {
      throw new Error('detached transaction partition changed before drop');
    }
    parts.push(detachedCandidate);
  } else if (detached.length) {
    throw new Error(`detached transaction partition requires recovery: ${detached[0].relname}`);
  }
  parts.sort((a, b) => a.start - b.start);
  return parts;
}

async function inspect(client, safety, detachedCandidate = null) {
  const { rows: layouts } = await client.query(`SELECT
      (SELECT relkind FROM pg_class WHERE oid=to_regclass($1)) AS transactions,
      (SELECT relkind FROM pg_class WHERE oid=to_regclass($2)) AS events`,
  [PARENT, EVENT_PARENT]);
  if (layouts[0]?.transactions !== 'p' || layouts[0]?.events !== 'p') {
    throw new Error('active transaction and event parents must be partitioned');
  }
  const parts = await loadPartitions(client, detachedCandidate);
  const { rows: cursors } = await client.query(`SELECT NOW() AS observed_at,
      finalized_head::text, recovery_state FROM robinhood_chain_capture_cursor
      WHERE chain='robinhood'`);
  const cursor = cursors[0];
  const candidate = parts[0];
  const remainingFloor = coverageFloor(parts, Number(cursor?.finalized_head), candidate?.start);
  const { rows: first } = remainingFloor == null ? { rows: [] } : await client.query(
    `SELECT block_timestamp FROM robinhood_chain_blocks WHERE chain='robinhood'
       AND canonical AND block_number >= $1::bigint AND block_number < $2::bigint
     ORDER BY block_number LIMIT 1`, [remainingFloor, remainingFloor + WIDTH]
  );
  const { rows: recent } = candidate ? await client.query(
    `SELECT EXISTS (SELECT 1 FROM robinhood_chain_blocks
       WHERE chain='robinhood' AND block_number >= $1::bigint
         AND block_number < $2::bigint
         AND block_timestamp >= NOW() - INTERVAL '72 hours') AS present`,
    [candidate.start, candidate.end]
  ) : { rows: [] };
  const { rows: references } = candidate ? await client.query(`SELECT
      EXISTS (SELECT 1 FROM robinhood_bundle_funding_live_queue
        WHERE chain='robinhood' AND status<>'complete'
          AND GREATEST(anchor_block-lookback_blocks, 0) < $2::bigint
          AND source_through_block >= $1::bigint) AS pending_bundle,
      EXISTS (SELECT 1 FROM robinhood_token_deployment_outbox
        WHERE chain='robinhood' AND mint_block_number >= $1::bigint
          AND mint_block_number < $2::bigint) AS pinned_deployment`,
  [candidate.start, candidate.end]) : { rows: [] };
  const { rows: pendingHolder } = candidate ? await client.query(`SELECT block_number::text
    FROM robinhood_holder_transfer_journal WHERE chain='robinhood' AND applied=FALSE
    ORDER BY block_number LIMIT 1`) : { rows: [] };
  const eventFks = await eventConstraints(client, candidate);
  return decide({ safety, cursor, parts, remainingFloor,
    firstRemainingTime: first[0]?.block_timestamp,
    candidateRecent: recent[0]?.present,
    oldestUnappliedBlock: pendingHolder[0]?.block_number ?? null,
    ...references[0], eventFks });
}

async function lockAndRecheck(client, safety, report, diagnostic, stage, detachedCandidate = null) {
  await diagnostic.run(`${stage}.lock_parent`, () => client.query(
    `LOCK TABLE ONLY ${PARENT} IN SHARE UPDATE EXCLUSIVE MODE`));
  await diagnostic.run(`${stage}.lock_event`, () => client.query(
    `LOCK TABLE ${report.eventPartition} IN ${
      detachedCandidate || !report.dropEventFk ? 'SHARE' : 'ACCESS EXCLUSIVE'} MODE`));
  // FK removal escalates to an exclusive lock on the transaction parent. The
  // capture transaction already holds that parent while inserting deployment
  // hints, so locking its outbox first would create a lock-order cycle.
  if (detachedCandidate) {
    await diagnostic.run(`${stage}.lock_queues`, () => client.query(
      `LOCK TABLE robinhood_token_deployment_outbox,
        robinhood_bundle_funding_live_queue IN SHARE MODE`));
  }
  const checked = await diagnostic.run(`${stage}.recheck`,
    () => inspect(client, safety, detachedCandidate));
  if (!checked.ready || checked.candidate?.name !== report.candidate.name) {
    const reason = checked.blockers.length ? checked.blockers.join(',') : 'candidate_changed';
    throw new Error(`transaction retention conditions changed under lock: ${reason}`);
  }
  return checked;
}

async function detachAndDrop(client, audit, report, diagnostic) {
  // DETACH CONCURRENTLY must run outside a transaction. No queue lock is held here.
  await client.query("SET lock_timeout='500ms'");
  await client.query("SET statement_timeout='5min'");
  await diagnostic.run('detach.concurrently', () => client.query(
    `ALTER TABLE ${PARENT} DETACH PARTITION ${report.candidate.name}
      CONCURRENTLY`));
  await dropDetached(client, audit, report, diagnostic);
}

async function dropDetached(client, audit, report, diagnostic) {
  let inTransaction = false;
  try {
    const safety = await audit.inspect();
    await client.query('BEGIN');
    inTransaction = true;
    await client.query("SET LOCAL lock_timeout='500ms'");
    await client.query("SET LOCAL statement_timeout='5s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout='10s'");
    const candidate = { ...report.candidate, event: report.eventPartition };
    await lockAndRecheck(client, safety, report, diagnostic, 'final', candidate);
    await diagnostic.run('final.drop_partition', () => client.query(
      `DROP TABLE ${report.candidate.name} RESTRICT`));
    await client.query('COMMIT');
  } catch (error) {
    if (inTransaction) await client.query('ROLLBACK').catch(() => {});
    error.message = `${error.message}; detached partition remains on disk`;
    throw error;
  }
}

async function acquirePrunerLock(client, apply) {
  if (!apply) return false;
  const { rows: locks } = await client.query(`SELECT pg_try_advisory_lock(
    hashtext('robinhood-chain-event-pruner')) AS locked`);
  if (!locks[0]?.locked) throw new Error('concurrent chain pruner');
  return true;
}

async function inspectAndPrepare(client, safety, apply, diagnostic) {
  await client.query(apply ? 'BEGIN' : 'BEGIN READ ONLY');
  try {
    await client.query("SET LOCAL lock_timeout='500ms'");
    await client.query("SET LOCAL statement_timeout='15s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout='30s'");
    const report = await diagnostic.run('prepare.inspect', () => inspect(client, safety));
    if (apply && report.ready) {
      const checked = await lockAndRecheck(client, safety, report, diagnostic, 'prepare');
      if (checked.dropEventFk) {
        await diagnostic.run('prepare.drop_event_fk', () => client.query(
          `ALTER TABLE ${report.eventPartition} DROP CONSTRAINT ${FK}`));
      }
    }
    await client.query('COMMIT');
    return report;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

async function releaseRunClient(client, advisoryLocked) {
  if (!client) return;
  if (advisoryLocked) {
    await client.query(`SELECT pg_advisory_unlock(
      hashtext('robinhood-chain-event-pruner'))`).catch(() => {});
  }
  await client.query('RESET lock_timeout; RESET statement_timeout').catch(() => {});
  client.release();
}

function detachedCandidate(resumeStart) {
  if (!Number.isSafeInteger(resumeStart)
      || !Number.isSafeInteger(resumeStart + WIDTH)
      || resumeStart < 0 || resumeStart % WIDTH !== 0) {
    throw new Error('resume detached start must be a nonnegative partition boundary');
  }
  return { start: resumeStart, end: resumeStart + WIDTH,
    name: `public.robinhood_chain_transactions_shadow_b${resumeStart}`,
    event: `public.robinhood_chain_events_shadow_b${resumeStart}`, bytes: null };
}

async function resumeDetached(client, audit, safety, diagnostic, resumeStart, apply) {
  const detached = detachedCandidate(resumeStart);
  const report = await inspect(client, safety, detached);
  if (report.candidate?.name !== detached.name) {
    throw new Error('detached transaction partition is not the oldest candidate');
  }
  if (!apply || !report.ready) {
    return { mode: apply ? 'apply' : 'read-only', action: 'none', ...report };
  }
  await dropDetached(client, audit, report, diagnostic);
  return { mode: 'apply', action: 'dropped_detached_transaction_partition', ...report };
}

async function run(input = {}, deps = {}) {
  const database = deps.database || db;
  const apply = input.apply === true;
  let client;
  let advisoryLocked = false;
  try {
    const audit = deps.audit || createRobinhoodRetentionSafetyAudit({
      database, includeHolderProof: false,
    });
    const safety = await audit.inspect();
    client = await database.getClient();
    const diagnostic = createTimeoutDiagnostic(database, client);
    advisoryLocked = await acquirePrunerLock(client, apply);
    if (input.resumeDetachedStart != null) {
      return await resumeDetached(client, audit, safety, diagnostic,
        input.resumeDetachedStart, apply);
    }
    const report = await inspectAndPrepare(client, safety, apply, diagnostic);
    if (!apply || !report.ready) {
      return { mode: apply ? 'apply' : 'read-only', action: 'none', ...report };
    }

    await detachAndDrop(client, audit, report, diagnostic);
    return { mode: apply ? 'apply' : 'read-only',
      action: 'dropped_transaction_partition', ...report };
  } finally {
    await releaseRunClient(client, advisoryLocked);
    if (!deps.database && deps.closePool !== false) {
      await database.pool.end().catch(() => {});
    }
  }
}

module.exports = { WIDTH, RETENTION_MS, coverageFloor, decide, run };
