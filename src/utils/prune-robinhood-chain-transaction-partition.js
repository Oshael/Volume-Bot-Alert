'use strict';

require('dotenv').config();
const { run } = require('../services/robinhood-chain-transaction-partition-retention');

function parseArgs(args) {
  const resume = args.filter((arg) => arg.startsWith('--resume-detached-start='));
  if (resume.length > 1 || args.filter((arg) => arg === '--apply').length > 1
      || args.some((arg) => arg !== '--apply'
        && !arg.startsWith('--resume-detached-start='))) {
    throw new Error('only --apply and one --resume-detached-start=N are supported');
  }
  const start = resume[0]?.slice('--resume-detached-start='.length);
  if (start != null && !/^\d+$/.test(start)) {
    throw new Error('--resume-detached-start must be a partition boundary');
  }
  return { apply: args.includes('--apply'),
    ...(start == null ? {} : { resumeDetachedStart: Number(start) }) };
}

async function main(args = process.argv.slice(2), deps = {}) {
  const report = await run(parseArgs(args), deps);
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

module.exports = { main, parseArgs, timeoutDiagnostic };
