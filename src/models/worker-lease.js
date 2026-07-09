const os = require('os');
const db = require('./db');

const DEFAULT_TTL_MS = 120000;

function getRunner(runner) {
  return runner && typeof runner.query === 'function' ? runner : db;
}

function normalizeKey(value) {
  const key = String(value || '').trim();
  if (!key) {
    throw new Error('Worker lease key is required');
  }
  if (key.length > 128) {
    throw new Error('Worker lease key must be 128 chars or less');
  }
  return key;
}

function normalizeOwner(value) {
  const owner = String(value || '').trim();
  if (!owner) {
    throw new Error('Worker lease owner is required');
  }
  if (owner.length > 128) {
    throw new Error('Worker lease owner must be 128 chars or less');
  }
  return owner;
}

function normalizeTtlMs(value) {
  const ttlMs = Math.trunc(Number(value) || DEFAULT_TTL_MS);
  return Math.max(5000, Math.min(ttlMs, 10 * 60 * 1000));
}

function mapRow(row) {
  if (!row) return null;
  return {
    key: row.lease_key,
    ownerId: row.owner_id,
    ownerPid: Number(row.owner_pid) || null,
    ownerHostname: row.owner_hostname || null,
    acquiredAt: row.acquired_at ? new Date(row.acquired_at).toISOString() : null,
    heartbeatAt: row.heartbeat_at ? new Date(row.heartbeat_at).toISOString() : null,
    leaseUntil: row.lease_until ? new Date(row.lease_until).toISOString() : null,
    metadata: row.metadata || {},
  };
}

async function acquire(key, ownerId, options = {}, runner = db) {
  const executor = getRunner(runner);
  const ttlMs = normalizeTtlMs(options.ttlMs);
  const metadata = options.metadata && typeof options.metadata === 'object' ? options.metadata : {};
  const { rows } = await executor.query(
    `INSERT INTO worker_leases (
       lease_key,
       owner_id,
       owner_pid,
       owner_hostname,
       acquired_at,
       heartbeat_at,
       lease_until,
       metadata
     )
     VALUES ($1, $2, $3, $4, NOW(), NOW(), NOW() + ($5::int * INTERVAL '1 millisecond'), $6::jsonb)
     ON CONFLICT (lease_key) DO UPDATE SET
       owner_id = EXCLUDED.owner_id,
       owner_pid = EXCLUDED.owner_pid,
       owner_hostname = EXCLUDED.owner_hostname,
       acquired_at = CASE
         WHEN worker_leases.owner_id = EXCLUDED.owner_id THEN worker_leases.acquired_at
         ELSE EXCLUDED.acquired_at
       END,
       heartbeat_at = EXCLUDED.heartbeat_at,
       lease_until = EXCLUDED.lease_until,
       metadata = EXCLUDED.metadata
     WHERE worker_leases.owner_id = EXCLUDED.owner_id
        OR worker_leases.lease_until <= NOW()
     RETURNING *`,
    [
      normalizeKey(key),
      normalizeOwner(ownerId),
      process.pid,
      os.hostname(),
      ttlMs,
      JSON.stringify(metadata),
    ]
  );

  return mapRow(rows[0] || null);
}

async function heartbeat(key, ownerId, options = {}, runner = db) {
  const executor = getRunner(runner);
  const ttlMs = normalizeTtlMs(options.ttlMs);
  const { rows } = await executor.query(
    `UPDATE worker_leases
     SET heartbeat_at = NOW(),
         lease_until = NOW() + ($3::int * INTERVAL '1 millisecond')
     WHERE lease_key = $1
       AND owner_id = $2
       AND lease_until > NOW()
     RETURNING *`,
    [normalizeKey(key), normalizeOwner(ownerId), ttlMs]
  );

  return mapRow(rows[0] || null);
}

async function release(key, ownerId, runner = db) {
  const executor = getRunner(runner);
  const { rowCount } = await executor.query(
    `DELETE FROM worker_leases
     WHERE lease_key = $1
       AND owner_id = $2`,
    [normalizeKey(key), normalizeOwner(ownerId)]
  );
  return rowCount > 0;
}

async function list(runner = db) {
  const executor = getRunner(runner);
  const { rows } = await executor.query(
    `SELECT *
     FROM worker_leases
     ORDER BY lease_key ASC`
  );
  return rows.map(mapRow);
}

module.exports = {
  DEFAULT_TTL_MS,
  acquire,
  heartbeat,
  release,
  list,
  __private: {
    mapRow,
    normalizeKey,
    normalizeOwner,
    normalizeTtlMs,
  },
};
