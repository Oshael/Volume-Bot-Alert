require('dotenv').config();

const db = require('../models/db');

const CHAIN = 'robinhood';
const LEASE_KEY = 'robinhood-wallet-transfer-live-worker';
const LOCK_ID = 4_663_134;
const CONFIRM_FLAG = '--confirm-repair-robinhood-wallet-transfer-live-origin';

function identifier(value, label) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalized)) throw new Error(`${label} is invalid`);
  return normalized;
}
function blockNumber(value, label) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized)) throw new Error(`${label} must be a non-negative integer`);
  return BigInt(normalized).toString();
}
function parseArgs(argv = []) {
  const versionPrefix = '--projection-version=';
  const originPrefix = '--live-origin-block=';
  const versions = argv.filter((arg) => arg.startsWith(versionPrefix));
  const origins = argv.filter((arg) => arg.startsWith(originPrefix));
  const unknown = argv.filter((arg) => arg !== CONFIRM_FLAG
    && !arg.startsWith(versionPrefix) && !arg.startsWith(originPrefix));
  if (unknown.length) throw new Error(`unknown argument: ${unknown[0]}`);
  if (versions.length !== 1) throw new Error('--projection-version is required exactly once');
  if (origins.length !== 1) throw new Error('--live-origin-block is required exactly once');
  return Object.freeze({
    projectionVersion: identifier(versions[0].slice(versionPrefix.length), 'projectionVersion'),
    liveOriginBlock: blockNumber(origins[0].slice(originPrefix.length), 'liveOriginBlock'),
    confirm: argv.includes(CONFIRM_FLAG),
  });
}
function normalizeCursor(row) {
  return row ? Object.freeze({
    originBlock: row.origin_block == null ? null : String(row.origin_block),
    nextBlock: String(row.next_block), lifecycleState: row.lifecycle_state,
    version: Number(row.version),
  }) : null;
}
async function loadSnapshot(database, projectionVersion, lock = false) {
  const cursor = await database.query(
    `SELECT origin_block, next_block, lifecycle_state, version
       FROM robinhood_wallet_transfer_cursors
      WHERE chain = $1 AND projection_version = $2 AND stream = 'live'${lock ? ' FOR UPDATE' : ''}`,
    [CHAIN, projectionVersion]
  );
  const lease = await database.query(
    `SELECT lease_until > NOW() AS active FROM worker_leases
      WHERE lease_key = $1${lock ? ' FOR UPDATE' : ''}`,
    [LEASE_KEY]
  );
  return Object.freeze({
    cursor: normalizeCursor(cursor.rows[0]),
    liveWorkerActive: lease.rows[0]?.active === true,
  });
}
function buildPlan(snapshot, liveOriginInput) {
  const liveOriginBlock = blockNumber(liveOriginInput, 'liveOriginBlock');
  const { cursor } = snapshot;
  if (!cursor) throw new Error('LIVE wallet-transfer cursor is required');
  if (cursor.lifecycleState !== 'running') throw new Error('LIVE wallet-transfer cursor is not running');
  if (BigInt(liveOriginBlock) > BigInt(cursor.nextBlock)) {
    throw new Error('LIVE origin exceeds current cursor position');
  }
  if (cursor.originBlock !== null && cursor.originBlock !== liveOriginBlock) {
    throw new Error('existing LIVE origin conflicts with requested origin');
  }
  return Object.freeze({
    liveOriginBlock, liveWorkerActive: snapshot.liveWorkerActive, cursor,
    pendingWrites: Number(cursor.originBlock === null),
    evidence: 'operator_supplied_live_origin',
  });
}
async function repairLiveOrigin(input = {}) {
  const database = input.database || db;
  const projectionVersion = identifier(input.projectionVersion, 'projectionVersion');
  const initial = buildPlan(
    await loadSnapshot(database, projectionVersion), input.liveOriginBlock
  );
  if (input.confirm !== true) return Object.freeze({ mode: 'dry-run', projectionVersion, ...initial });
  if (initial.liveWorkerActive) throw new Error('wallet-transfer LIVE worker lease is active');
  const client = await database.getClient();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_ID]);
    const locked = buildPlan(
      await loadSnapshot(client, projectionVersion, true), input.liveOriginBlock
    );
    if (locked.liveWorkerActive) throw new Error('wallet-transfer LIVE worker lease is active');
    const updated = await client.query(
      `UPDATE robinhood_wallet_transfer_cursors SET origin_block = $3::bigint, updated_at = NOW()
        WHERE chain = $1 AND projection_version = $2 AND stream = 'live' AND origin_block IS NULL
        RETURNING origin_block`,
      [CHAIN, projectionVersion, locked.liveOriginBlock]
    );
    const post = buildPlan(await loadSnapshot(client, projectionVersion), input.liveOriginBlock);
    if (post.pendingWrites !== 0) throw new Error('wallet-transfer origin repair post-condition failed');
    await client.query('COMMIT');
    return Object.freeze({
      mode: 'confirmed', projectionVersion, ...post, updated: updated.rows.length,
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
async function main(argv = process.argv.slice(2), deps = {}) {
  const args = parseArgs(argv);
  const result = await repairLiveOrigin({ database: deps.database || db, ...args });
  (deps.logger || console).log(JSON.stringify(result, null, 2));
  if (!args.confirm) {
    (deps.logger || console).log(`No data changed. Re-run with ${CONFIRM_FLAG} after review.`);
  }
  return result;
}
if (require.main === module) main().catch((error) => {
  console.error('Robinhood wallet-transfer LIVE origin repair failed:', error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = { CONFIRM_FLAG, buildPlan, main, parseArgs, repairLiveOrigin };
