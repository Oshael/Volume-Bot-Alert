require('dotenv').config();

const db = require('../models/db');

const CHAIN = 'robinhood';
const LEASE_KEY = 'robinhood-wallet-swap-live-worker';
const LOCK_ID = 4_663_133;
const CONFIRM_FLAG = '--confirm-repair-robinhood-wallet-swap-origins';

function blockNumber(value, label) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized)) throw new Error(`${label} must be a non-negative integer`);
  return BigInt(normalized).toString();
}

function parseArgs(argv = []) {
  const prefix = '--seed-origin-block=';
  const values = argv.filter((arg) => arg.startsWith(prefix));
  const unknown = argv.filter((arg) => arg !== CONFIRM_FLAG && !arg.startsWith(prefix));
  if (unknown.length) throw new Error(`unknown argument: ${unknown[0]}`);
  if (values.length !== 1) throw new Error('--seed-origin-block is required exactly once');
  return Object.freeze({
    seedOriginBlock: blockNumber(values[0].slice(prefix.length), 'seedOriginBlock'),
    confirm: argv.includes(CONFIRM_FLAG),
  });
}

function cursor(row) {
  return row ? Object.freeze({
    stream: row.stream,
    originBlock: row.origin_block == null ? null : String(row.origin_block),
    nextBlock: row.next_block == null ? null : String(row.next_block),
    safeHead: row.safe_head == null ? null : String(row.safe_head),
    lifecycleState: row.lifecycle_state || null,
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
    version: Number(row.version),
  }) : null;
}

async function loadSnapshot(database, lock = false) {
  const cursors = await database.query(
    `SELECT stream, origin_block, next_block, safe_head, lifecycle_state,
            completed_at, version
       FROM robinhood_wallet_swap_cursors
      WHERE chain = $1 AND stream IN ('seed', 'live')
      ORDER BY stream${lock ? ' FOR UPDATE' : ''}`,
    [CHAIN]
  );
  const lease = await database.query(
    `SELECT lease_until > NOW() AS active FROM worker_leases
      WHERE lease_key = $1${lock ? ' FOR UPDATE' : ''}`,
    [LEASE_KEY]
  );
  const byStream = Object.fromEntries(cursors.rows.map((row) => [row.stream, cursor(row)]));
  return Object.freeze({
    liveWorkerActive: lease.rows[0]?.active === true,
    seed: byStream.seed || null,
    live: byStream.live || null,
  });
}

function buildPlan(snapshot, seedOriginInput) {
  const seedOriginBlock = blockNumber(seedOriginInput, 'seedOriginBlock');
  const { seed, live } = snapshot;
  if (!seed || !live) throw new Error('seed and live wallet-swap cursors are required');
  if (seed.lifecycleState !== 'complete' || seed.completedAt === null
      || seed.nextBlock === null || seed.safeHead === null
      || BigInt(seed.nextBlock) <= BigInt(seed.safeHead)) {
    throw new Error('seed cursor is not terminally complete');
  }
  if (live.lifecycleState !== 'running' || live.nextBlock === null) {
    throw new Error('live cursor is not running');
  }
  if (BigInt(seedOriginBlock) > BigInt(seed.safeHead)) {
    throw new Error('seed origin exceeds seed safe head');
  }
  const liveOriginBlock = (BigInt(seed.safeHead) + 1n).toString();
  if (BigInt(live.nextBlock) < BigInt(liveOriginBlock)) {
    throw new Error('live cursor precedes the seed handoff');
  }
  if (seed.originBlock !== null && seed.originBlock !== seedOriginBlock) {
    throw new Error('existing seed origin conflicts with requested origin');
  }
  if (live.originBlock !== null && live.originBlock !== liveOriginBlock) {
    throw new Error('existing live origin conflicts with seed handoff');
  }
  return Object.freeze({
    seedOriginBlock, liveOriginBlock,
    liveWorkerActive: snapshot.liveWorkerActive,
    seed, live,
    pendingWrites: Number(seed.originBlock === null) + Number(live.originBlock === null),
    evidence: 'operator_supplied_seed_origin_and_durable_seed_handoff',
  });
}

async function persistOrigins(database, plan) {
  const result = await database.query(
    `UPDATE robinhood_wallet_swap_cursors SET
       origin_block = CASE stream WHEN 'seed' THEN $2::bigint ELSE $3::bigint END,
       updated_at = NOW()
     WHERE chain = $1 AND (
       (stream = 'seed' AND origin_block IS NULL)
       OR (stream = 'live' AND origin_block IS NULL)
     )
     RETURNING stream, origin_block`,
    [CHAIN, plan.seedOriginBlock, plan.liveOriginBlock]
  );
  return result.rows;
}

async function repairOrigins(input = {}) {
  const database = input.database || db;
  const seedOriginBlock = blockNumber(input.seedOriginBlock, 'seedOriginBlock');
  const initial = buildPlan(await loadSnapshot(database), seedOriginBlock);
  if (input.confirm !== true) return Object.freeze({ mode: 'dry-run', ...initial });
  if (initial.liveWorkerActive) throw new Error('wallet-swap LIVE worker lease is active');

  const client = await database.getClient();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_ID]);
    const locked = buildPlan(await loadSnapshot(client, true), seedOriginBlock);
    if (locked.liveWorkerActive) throw new Error('wallet-swap LIVE worker lease is active');
    const updated = await persistOrigins(client, locked);
    const post = buildPlan(await loadSnapshot(client), seedOriginBlock);
    if (post.pendingWrites !== 0) throw new Error('wallet-swap origin repair post-condition failed');
    await client.query('COMMIT');
    return Object.freeze({ mode: 'confirmed', ...post, updated: updated.length });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const args = parseArgs(argv);
  const result = await repairOrigins({ database: deps.database || db, ...args });
  (deps.logger || console).log(JSON.stringify(result, null, 2));
  if (!args.confirm) {
    (deps.logger || console).log(`No data changed. Re-run with ${CONFIRM_FLAG} after review.`);
  }
  return result;
}

if (require.main === module) main().catch((error) => {
  console.error('Robinhood wallet-swap origin repair failed:', error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = { CONFIRM_FLAG, buildPlan, main, parseArgs, repairOrigins };
