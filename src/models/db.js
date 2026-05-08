const { Pool } = require('pg');
const config = require('../../config');

const poolConfig = {
  max: config.db.poolMax,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
};

if (config.db.connectionString) {
  poolConfig.connectionString = config.db.connectionString;
} else {
  poolConfig.host = config.db.host;
  poolConfig.port = config.db.port;
  poolConfig.database = config.db.database;
  poolConfig.user = config.db.user;
  poolConfig.password = config.db.password;
}

if (config.db.ssl) {
  poolConfig.ssl = { rejectUnauthorized: !!config.db.sslRejectUnauthorized };
}

const pool = new Pool(poolConfig);

pool.on('error', (err) => {
  console.error('Unexpected database pool error:', err.message);
});

function logSlowQuery(text, duration) {
  if (config.db.logSlowQueries && duration > config.db.slowQueryLogMs) {
    const compactSql = String(text || '').replace(/\s+/g, ' ').trim();
    console.warn(`Slow query (${duration}ms):`, compactSql.slice(0, 140));
  }
}

// Convenience: run a query
async function query(text, params) {
  const start = Date.now();
  const res = await pool.query(text, params);
  logSlowQuery(text, Date.now() - start);
  return res;
}

async function queryWithStatementTimeout(text, params, timeoutMs = 0) {
  const safeTimeoutMs = Math.max(0, Math.trunc(Number(timeoutMs) || 0));
  if (safeTimeoutMs <= 0) {
    return query(text, params);
  }

  const client = await pool.connect();
  const start = Date.now();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = '${safeTimeoutMs}ms'`);
    const res = await client.query(text, params);
    await client.query('COMMIT');
    logSlowQuery(text, Date.now() - start);
    return res;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

// Convenience: get a client for transactions
async function getClient() {
  return pool.connect();
}

module.exports = { pool, query, queryWithStatementTimeout, getClient };
