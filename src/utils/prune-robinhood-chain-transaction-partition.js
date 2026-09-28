'use strict';

require('dotenv').config();
const { run } = require('../services/robinhood-chain-transaction-partition-retention');

async function main(args = process.argv.slice(2), deps = {}) {
  if (args.some((arg) => arg !== '--apply') || args.length > 1) {
    throw new Error('only --apply is supported');
  }
  const report = await run({ apply: args.includes('--apply') }, deps);
  console.log(JSON.stringify(report, null, 2));
  return report;
}

function timeoutDiagnostic(error) {
  if (error.retentionTimeoutDiagnostic) return error.retentionTimeoutDiagnostic;
  if (!/timeout/i.test(String(error.message || ''))) return null;
  return { phase: error.auditPhase ? `safety.${error.auditPhase}` : 'unknown',
    sqlState: error.code || null, sampled: false };
}

if (require.main === module) main().catch((error) => {
  console.error('Robinhood transaction partition retention failed:', error.message);
  const timeout = timeoutDiagnostic(error);
  if (timeout) {
    console.error(JSON.stringify({ type: 'timeout_diagnostic', ...timeout }, null, 2));
  }
  process.exitCode = 1;
});

module.exports = { main, timeoutDiagnostic };
