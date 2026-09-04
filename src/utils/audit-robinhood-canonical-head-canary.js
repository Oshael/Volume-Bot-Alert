'use strict';

require('dotenv').config();
const db = require('../models/db');
const {
  createRobinhoodCanonicalHeadCanaryAudit,
} = require('../services/robinhood-canonical-head-canary-audit');

function integer(value, fallback, label) {
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} must be non-negative`);
  return parsed;
}
function parseArgs(argv = []) {
  const allowed = ['--phase=', '--max-capture-lag=', '--min-discovery=', '--min-market='];
  const unknown = argv.find((arg) => !allowed.some((prefix) => arg.startsWith(prefix)));
  if (unknown) throw new Error(`unknown argument: ${unknown}`);
  const value = (prefix) => argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  const phase = value('--phase=') || 'preflight';
  if (!['preflight', 'canary'].includes(phase)) throw new Error('--phase must be preflight or canary');
  return {
    phase,
    maxCaptureLag: integer(value('--max-capture-lag='), 2, '--max-capture-lag'),
    minDiscovery: integer(value('--min-discovery='), 1, '--min-discovery'),
    minMarket: integer(value('--min-market='), 100, '--min-market'),
  };
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const options = deps.options || parseArgs(argv);
  const audit = deps.audit || createRobinhoodCanonicalHeadCanaryAudit({
    database: deps.database || db,
  });
  const report = await audit.inspect(options);
  (deps.logger || console).log(JSON.stringify(report, null, 2));
  return report;
}

if (require.main === module) main().then((report) => {
  if (!report.approved) process.exitCode = 2;
}).catch((error) => {
  console.error('Robinhood canonical head canary audit failed:', error.message);
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = { main, parseArgs };
