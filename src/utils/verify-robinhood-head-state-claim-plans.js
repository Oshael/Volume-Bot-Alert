'use strict';

require('dotenv').config();
const db = require('../models/db');
const stage225 = require('./db-init-stage225');

const PLAN_QUERIES = Object.freeze({
  v4Frontier: `WITH RECURSIVE first_v4_by_pool AS (
    (SELECT market_key, transaction_hash, log_index, block_number, transaction_index
       FROM robinhood_head_capture_states
      WHERE chain='robinhood' AND stream='market' AND protocol='uniswap-v4'
        AND market_key IS NOT NULL
        AND processing_status IN ('pending', 'leased', 'blocked')
      ORDER BY market_key, block_number, transaction_index, log_index LIMIT 1)
    UNION ALL
    SELECT next_pool.market_key, next_pool.transaction_hash, next_pool.log_index,
           next_pool.block_number, next_pool.transaction_index
      FROM first_v4_by_pool current_pool
      CROSS JOIN LATERAL (
        SELECT market_key, transaction_hash, log_index, block_number, transaction_index
          FROM robinhood_head_capture_states
         WHERE chain='robinhood' AND stream='market' AND protocol='uniswap-v4'
           AND processing_status IN ('pending', 'leased', 'blocked')
           AND market_key > current_pool.market_key
         ORDER BY market_key, block_number, transaction_index, log_index LIMIT 1
      ) next_pool
  ) SELECT * FROM first_v4_by_pool LIMIT 2000`,
  marketIndependent: `SELECT transaction_hash, log_index
    FROM robinhood_head_capture_states
   WHERE chain='robinhood' AND stream='market'
     AND protocol IS DISTINCT FROM 'uniswap-v4'
     AND processing_status='pending' AND next_attempt_at <= NOW()
   ORDER BY block_number, transaction_index, log_index LIMIT 2000`,
  discovery: `SELECT transaction_hash, log_index
    FROM robinhood_head_capture_states
   WHERE chain='robinhood' AND stream='discovery'
     AND processing_status='pending' AND next_attempt_at <= NOW()
   ORDER BY block_number, transaction_index, log_index LIMIT 2000`,
});

const EXPECTED_INDEX = Object.freeze({
  v4Frontier: stage225.INDEX_NAMES[0],
  marketIndependent: stage225.INDEX_NAMES[1],
  discovery: stage225.INDEX_NAMES[2],
});

function collectIndexNames(plan) {
  const names = new Set();
  function visit(value) {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== 'object') return;
    if (typeof value['Index Name'] === 'string') names.add(value['Index Name']);
    Object.values(value).forEach(visit);
  }
  visit(plan);
  return [...names];
}

async function verifyPlans(options = {}) {
  const database = options.database || db;
  const report = {};
  try {
    for (const [name, query] of Object.entries(PLAN_QUERIES)) {
      const result = await database.query(`EXPLAIN (FORMAT JSON) ${query}`);
      let plan = result.rows[0]?.['QUERY PLAN'];
      if (typeof plan === 'string') plan = JSON.parse(plan);
      const indexes = collectIndexNames(plan);
      const expected = EXPECTED_INDEX[name];
      report[name] = { expected, indexes, safe: indexes.includes(expected) };
    }
    const safe = Object.values(report).every((entry) => entry.safe);
    return Object.freeze({ safe, plans: report });
  } finally {
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) verifyPlans().then((report) => {
  console.log(JSON.stringify(report));
  if (!report.safe) process.exitCode = 2;
}).catch((error) => {
  console.error(JSON.stringify({ safe: false, error: error.message }));
  process.exitCode = 1;
});

module.exports = { EXPECTED_INDEX, PLAN_QUERIES, collectIndexNames, verifyPlans };
