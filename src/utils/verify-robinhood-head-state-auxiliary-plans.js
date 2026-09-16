'use strict';

require('dotenv').config();
const db = require('../models/db');
const { BLOCKED_RECOVERY_ERROR } = require('../models/robinhood-head-processing');
const { AUXILIARY_SQL } = require('../models/robinhood-head-lifecycle-shadow');
const stage226 = require('./db-init-stage226');
const { collectIndexNames } = require('./verify-robinhood-head-state-claim-plans');

const PLAN_QUERIES = Object.freeze({
  watermark: { sql: AUXILIARY_SQL.watermark.state, params: ['market'] },
  frontier: { sql: AUXILIARY_SQL.frontier.state, params: ['market'] },
  recovery: {
    sql: AUXILIARY_SQL.recovery.state,
    params: [BLOCKED_RECOVERY_ERROR, null, 2000],
  },
  retention: { sql: AUXILIARY_SQL.retention.state, params: [new Date(), 2000] },
});

const EXPECTED_INDEX = Object.freeze({
  watermark: stage226.INDEX_NAMES[0],
  frontier: stage226.INDEX_NAMES[0],
  recovery: stage226.INDEX_NAMES[1],
  retention: 'idx_rh_head_capture_states_retention',
});

async function verifyPlans(options = {}) {
  const database = options.database || db;
  const report = {};
  try {
    for (const [name, query] of Object.entries(PLAN_QUERIES)) {
      const result = await database.query(
        `EXPLAIN (FORMAT JSON) ${query.sql}`, query.params
      );
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

module.exports = { EXPECTED_INDEX, PLAN_QUERIES, verifyPlans };
