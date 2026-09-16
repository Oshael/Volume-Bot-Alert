'use strict';

require('dotenv').config();
const db = require('../models/db');
const {
  createRobinhoodHeadClaimShadowRepository,
} = require('../models/robinhood-head-claim-shadow');

function option(name, fallback, maximum) {
  const prefix = `--${name}=`;
  const raw = process.argv.find((entry) => entry.startsWith(prefix))?.slice(prefix.length);
  const value = raw == null ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be between 1 and ${maximum}`);
  }
  return value;
}

async function main() {
  const samples = option('samples', 1, 100);
  const poolLimit = option('pool-limit', 8, 64);
  const limit = option('limit', 2000, 5000);
  const perPoolLimit = option('per-pool-limit', 512, 2000);
  const pauseMs = option('pause-ms', 500, 60_000);
  const statementTimeoutMs = option('statement-timeout-ms', 30_000, 120_000);
  const repository = createRobinhoodHeadClaimShadowRepository({ database: db });
  let safe = true;
  let afterMarketKey = null;
  let completed = false;
  for (let sample = 1; sample <= samples; sample += 1) {
    const report = await repository.auditV4ContinuationDecisions({
      poolLimit, limit, perPoolLimit, statementTimeoutMs, afterMarketKey,
    });
    safe &&= report.safe;
    console.log(JSON.stringify({ phase: 'sample', sample, ...report }));
    if (!report.safe) break;
    afterMarketKey = report.nextMarketKey;
    completed = report.complete;
    if (completed) break;
    if (sample < samples) await new Promise((resolve) => setTimeout(resolve, pauseMs));
  }
  console.log(JSON.stringify({
    phase: 'summary', safe, completed, samplesRequested: samples, afterMarketKey,
  }));
  if (!safe) process.exitCode = 2;
}

if (require.main === module) main().catch((error) => {
  console.error(JSON.stringify({ phase: 'error', message: error.message }));
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = { main, option };
