const { Pool } = require('pg');
const config = require('../../config');

const poolConfig = {
  max: 20,
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

// Convenience: run a query
async function query(text, params) {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  if (duration > 1000) {
    console.warn(`Slow query (${duration}ms):`, text.slice(0, 80));
  }
  return res;
}

// Convenience: get a client for transactions
async function getClient() {
  return pool.connect();
}

module.exports = { pool, query, getClient };
