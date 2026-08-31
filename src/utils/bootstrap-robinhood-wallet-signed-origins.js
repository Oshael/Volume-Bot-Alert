#!/usr/bin/env node
require('dotenv').config();
const config = require('../../config');
const db = require('../models/db');
const {
  createRobinhoodWalletSignedOriginCursorRepository,
} = require('../models/robinhood-wallet-signed-origin-cursor');
const {
  executeBootstrap, runPreflight,
} = require('../services/robinhood-wallet-signed-origin-bootstrap');
const {
  createRobinhoodWalletSignedOriginReader,
} = require('../services/robinhood-wallet-signed-origin-reader');
const { createRobinhoodRpcClient } = require('../services/robinhood-ingestion-worker');

function parseArgs(argv = process.argv.slice(2)) {
  const allowed = new Set(['batch-size', 'confirmations', 'concurrency', 'max-hours',
    'max-minutes', 'rpc-batch-size', 'rpc-min-interval-ms', 'sample-blocks', 'samples',
    'timeout-ms']);
  if (argv.some((arg) => arg !== '--apply' && (!arg.startsWith('--')
      || !arg.includes('=') || !allowed.has(arg.slice(2, arg.indexOf('=')))))) {
    throw new Error('unexpected argument');
  }
  const raw = Object.fromEntries(argv.filter((arg) => arg.includes('=')).map((arg) => {
    const index = arg.indexOf('='); return [arg.slice(2, index), arg.slice(index + 1)];
  }));
  const number = (key, fallback) => raw[key] == null ? fallback : Number(raw[key]);
  return Object.freeze({ apply: argv.includes('--apply'),
    batchSize: number('batch-size', 50), confirmations: number('confirmations', 12),
    concurrency: number('concurrency', 2), maxHours: number('max-hours', 5),
    maxMinutes: number('max-minutes', 1440), rpcBatchSize: number('rpc-batch-size', 20),
    rpcMinIntervalMs: number('rpc-min-interval-ms', 0),
    sampleBlocks: number('sample-blocks', 10), sampleCount: number('samples', 3),
    timeoutMs: number('timeout-ms', 15_000) });
}

function createRuntime(options, deps = {}) {
  const rpcUrl = String((deps.env || process.env).ROBINHOOD_RPC_URL || '').trim();
  if (!rpcUrl) throw Object.assign(new Error(
    'ROBINHOOD_RPC_URL is required for the signed-origin bootstrap'
  ), { code: 'configuration_error' });
  const rpcClient = deps.rpcClient || (deps.rpcClientFactory || createRobinhoodRpcClient)({
    ...config.robinhoodIngestionWorker, publicRpcUrl: rpcUrl,
    useAlchemy: false, useDrpc: false, rpcTimeoutMs: options.timeoutMs,
    rpcMinIntervalMs: options.rpcMinIntervalMs,
  });
  const repository = deps.repository || createRobinhoodWalletSignedOriginCursorRepository({
    database: deps.database || db,
  });
  const reader = deps.reader || createRobinhoodWalletSignedOriginReader({ rpcClient,
    rpcBatchSize: options.rpcBatchSize, concurrency: options.concurrency,
    maxBlocks: Math.max(options.batchSize, options.sampleBlocks), timeoutMs: options.timeoutMs });
  return { database: deps.database || db, repository, reader, rpcClient };
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const options = parseArgs(argv); const runtime = createRuntime(options, deps);
  const preflight = await runPreflight(runtime, options);
  (deps.logger || console).log(JSON.stringify({ phase: 'preflight', ...preflight }));
  if (!options.apply) return preflight;
  const result = await executeBootstrap(runtime, { ...options, preflight,
    onProgress: (value) => (deps.logger || console).log(JSON.stringify({
      phase: 'progress', ...value,
    })) });
  (deps.logger || console).log(JSON.stringify({ phase: 'complete', ...result }));
  return result;
}

if (require.main === module) main().catch((error) => {
  console.error(JSON.stringify({ error: error.code || 'signed_origin_bootstrap_failed',
    message: error.message }));
  process.exitCode = 1;
}).finally(() => db.pool.end().catch(() => {}));

module.exports = { createRuntime, main, parseArgs };
