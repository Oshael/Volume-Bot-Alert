const db = require('../models/db');
const { createRobinhoodRadarGainersReadRepository } = require('../models/robinhood-radar-gainers-read');

function summarizePlan(plan) {
  const scans = [];
  function visit(node) {
    if (node['Relation Name']) scans.push({
      table: node['Relation Name'], type: node['Node Type'], index: node['Index Name'] ?? null,
      estimatedRows: node['Plan Rows'], rows: node['Actual Rows'] ?? null,
      loops: node['Actual Loops'] ?? null, removed: node['Rows Removed by Filter'] ?? null,
      hits: node['Shared Hit Blocks'] ?? null, reads: node['Shared Read Blocks'] ?? null,
      localHits: node['Local Hit Blocks'] ?? null, localReads: node['Local Read Blocks'] ?? null,
    });
    (node.Plans || []).forEach(visit);
  }
  visit(plan.Plan);
  return { planningMs: plan['Planning Time'] ?? null, executionMs: plan['Execution Time'] ?? null,
    hits: plan.Plan['Shared Hit Blocks'] ?? null, reads: plan.Plan['Shared Read Blocks'] ?? null,
    localHits: plan.Plan['Local Hit Blocks'] ?? null, localReads: plan.Plan['Local Read Blocks'] ?? null,
    tempReadBlocks: plan.Plan['Temp Read Blocks'] ?? null,
    tempWrittenBlocks: plan.Plan['Temp Written Blocks'] ?? null, scans };
}

async function explainGainers({ asOf, mode = 'plan' } = {}, database = db) {
  if (!['plan', 'analyze'].includes(mode)) throw new Error('mode must be plan or analyze');
  const client = await database.getClient();
  let report;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query("SET LOCAL lock_timeout = '500ms'");
    const reader = createRobinhoodRadarGainersReadRepository({ database: {
      async queryWithStatementTimeout(sql, params) {
        const meta = (await client.query(`SELECT NOW() AS measured_at, current_database() AS database,
          COUNT(*) FILTER (WHERE chain = 'robinhood')::int AS catalog_tokens,
          COUNT(*) FILTER (WHERE chain = 'robinhood' AND last_token_created_at_ms > 0
            AND last_token_created_at_ms BETWEEN EXTRACT(EPOCH FROM $1::timestamptz - INTERVAL '24 hours')*1000
              AND EXTRACT(EPOCH FROM $1::timestamptz)*1000)::int AS young_tokens
          FROM token_catalog`, [params[0]])).rows[0];
        const options = mode === 'analyze' ? 'ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON' : 'FORMAT JSON';
        const plan = (await client.query(`EXPLAIN (${options}) ${sql}`, params)).rows[0]['QUERY PLAN'][0];
        report = { mode, asOf: params[0].toISOString(), ...meta, ...summarizePlan(plan) };
        return { rows: [{ candidate_count: 0, unpriced_count: 0, total: 0, items: [] }] };
      },
    } });
    await reader.getGainers({ asOf });
    return report;
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}
if (require.main === module) {
  const [mode = 'plan', asOf] = process.argv.slice(2);
  explainGainers({ mode, asOf }).then((report) => console.log(JSON.stringify(report)))
    .catch((error) => { console.error(error.message); process.exitCode = 1; })
    .finally(() => db.pool.end());
}
module.exports = { explainGainers, summarizePlan };
