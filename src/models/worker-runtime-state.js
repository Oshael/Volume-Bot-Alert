const db = require('./db');

let ensureTablePromise = null;

function ensureTable() {
  if (!ensureTablePromise) {
    ensureTablePromise = db.query(`
      CREATE TABLE IF NOT EXISTS worker_runtime_state (
        key VARCHAR(128) PRIMARY KEY,
        last_run_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_worker_runtime_state_updated_at
        ON worker_runtime_state(updated_at DESC);
    `);
  }

  return ensureTablePromise;
}

async function getLastRunAt(key) {
  await ensureTable();
  const { rows } = await db.query(
    `SELECT last_run_at
     FROM worker_runtime_state
     WHERE key = $1
     LIMIT 1`,
    [String(key || '').trim()]
  );

  return rows[0]?.last_run_at || null;
}

async function setLastRunAt(key, value = new Date()) {
  await ensureTable();
  const normalizedKey = String(key || '').trim();
  const lastRunAt = value instanceof Date ? value : new Date(value);

  const { rows } = await db.query(
    `INSERT INTO worker_runtime_state (key, last_run_at, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET
       last_run_at = EXCLUDED.last_run_at,
       updated_at = NOW()
     RETURNING last_run_at, updated_at`,
    [normalizedKey, lastRunAt]
  );

  return rows[0] || null;
}

module.exports = {
  ensureTable,
  getLastRunAt,
  setLastRunAt,
};
