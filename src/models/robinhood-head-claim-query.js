'use strict';

const { performance } = require('node:perf_hooks');

// Split client acquisition from the claim query without changing the SQL or its transaction.
async function runClaimQuery(database, sql, params, timing) {
  if (!timing || typeof database.getClient !== 'function') {
    return database.query(sql, params);
  }
  const connectionStartedAt = performance.now();
  const client = await database.getClient();
  timing.connectionMs = performance.now() - connectionStartedAt;
  const queryStartedAt = performance.now();
  try {
    const result = await client.query(sql, params);
    timing.queryMs = performance.now() - queryStartedAt;
    database.logSlowQuery?.(sql, performance.now() - connectionStartedAt);
    return result;
  } finally {
    timing.queryMs ??= performance.now() - queryStartedAt;
    client.release();
  }
}

module.exports = { runClaimQuery };
