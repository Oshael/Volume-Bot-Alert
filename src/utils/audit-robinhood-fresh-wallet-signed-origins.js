#!/usr/bin/env node
require('dotenv').config();
const db = require('../models/db');
const {
  createRobinhoodFreshWalletSignedOriginAuditRepository,
} = require('../models/robinhood-fresh-wallet-signed-origin-audit');
const { createArchiveSource } = require('../services/robinhood-fresh-wallet-seed-runner');
const {
  runRobinhoodFreshWalletSignedOriginAudit,
} = require('../services/robinhood-fresh-wallet-signed-origin-audit');

function parseArgs(argv = process.argv.slice(2)) {
  const allowed = new Set(['samples', 'minimum-samples', 'batch-size',
    'max-safe-unavailable-bps', 'timeout-ms']);
  if (argv.some((arg) => !arg.startsWith('--') || !arg.includes('=')
      || !allowed.has(arg.slice(2, arg.indexOf('='))))) throw new Error('unexpected argument');
  const raw = Object.fromEntries(argv.map((arg) => {
    const index = arg.indexOf('='); return [arg.slice(2, index), arg.slice(index + 1)];
  }));
  const number = (key, fallback) => raw[key] == null ? fallback : Number(raw[key]);
  return Object.freeze({ sampleCount: number('samples', 500),
    minimumSamples: number('minimum-samples', 100), batchSize: number('batch-size', 100),
    maxSafeUnavailableBps: number('max-safe-unavailable-bps', 100),
    timeoutMs: number('timeout-ms', 60_000) });
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const options = parseArgs(argv);
  const result = await runRobinhoodFreshWalletSignedOriginAudit({
    repository: deps.repository || createRobinhoodFreshWalletSignedOriginAuditRepository({
      database: deps.database || db,
    }),
    archiveSource: deps.archiveSource || createArchiveSource(options, {
      env: deps.env || process.env,
    }),
  }, { ...options, onProgress: (progress) => (deps.logger || console).log(JSON.stringify({
    phase: 'progress', ...progress,
  })) });
  (deps.logger || console).log(JSON.stringify({ phase: 'complete', ...result }));
  if (!result.approved) process.exitCode = 2;
  return result;
}

if (require.main === module) main().catch((error) => {
  console.error(JSON.stringify({ error: error.code || 'fresh_signed_origin_audit_failed',
    message: error.message })); process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = { main, parseArgs };
