'use strict';

require('dotenv').config();
const db = require('../models/db');
const {
  createRobinhoodHeadLifecycleShadowRepository,
} = require('../models/robinhood-head-lifecycle-shadow');

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
  const samples = option('samples', 1, 20);
  const limit = option('limit', 2000, 5000);
  const pauseMs = option('pause-ms', 500, 60_000);
  const statementTimeoutMs = option('statement-timeout-ms', 120_000, 300_000);
  const repository = createRobinhoodHeadLifecycleShadowRepository({ database: db });
  let safe = true;
  for (let sample = 1; sample <= samples; sample += 1) {
    const report = await repository.auditAuxiliaryReads({ limit, statementTimeoutMs });
    safe &&= report.safe;
    console.log(JSON.stringify({ phase: 'sample', sample, ...report }));
    if (!report.safe) break;
    if (sample < samples) await new Promise((resolve) => setTimeout(resolve, pauseMs));
  }
  console.log(JSON.stringify({ phase: 'summary', safe, samplesRequested: samples }));
  if (!safe) process.exitCode = 2;
}

if (require.main === module) main().catch((error) => {
  console.error(JSON.stringify({ phase: 'error', message: error.message }));
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = { main, option };
