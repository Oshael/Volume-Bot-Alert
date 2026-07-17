require('dotenv').config();

const v2Fixture = require('../../data/fixtures/robinhood-uniswap-v2.json');
const v3Fixture = require('../../data/fixtures/robinhood-uniswap-v3.json');
const v4Fixture = require('../../data/fixtures/robinhood-uniswap-v4.json');
const { createRobinhoodContinuousRunner } = require('../services/robinhood-continuous-runner');
const { createEvmJsonRpcClient } = require('../services/evm-json-rpc-client');
const { createRobinhoodSocialMetadataQueue } = require('../services/robinhood-social-metadata-queue');

const PUBLIC_RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function optionalBlock(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (!/^0x[0-9a-f]+$/i.test(raw) && !/^\d+$/.test(raw)) {
    throw new Error('ROBINHOOD_CONTINUOUS_START_BLOCK must be decimal or hex');
  }
  return raw;
}

function readOptions(env = process.env) {
  return {
    durationSeconds: positiveInteger(env.ROBINHOOD_CONTINUOUS_DURATION_SECONDS, 60, 86400),
    reportIntervalSeconds: positiveInteger(env.ROBINHOOD_CONTINUOUS_REPORT_INTERVAL_SECONDS, 15, 3600),
    pollIntervalMs: positiveInteger(env.ROBINHOOD_CONTINUOUS_POLL_INTERVAL_MS, 2000, 300000),
    lookbackBlocks: positiveInteger(env.ROBINHOOD_CONTINUOUS_LOOKBACK_BLOCKS, 250, 100000),
    startBlock: optionalBlock(env.ROBINHOOD_CONTINUOUS_START_BLOCK),
    confirmations: positiveInteger(env.ROBINHOOD_CONTINUOUS_CONFIRMATIONS, 2, 1000),
    rangeSize: positiveInteger(env.ROBINHOOD_CONTINUOUS_RANGE_SIZE, 10, 1000),
    timestampConcurrency: positiveInteger(env.ROBINHOOD_CONTINUOUS_TIMESTAMP_CONCURRENCY, 16, 32),
    observationConcurrency: positiveInteger(env.ROBINHOOD_CONTINUOUS_OBSERVATION_CONCURRENCY, 4, 16),
    useAlchemy: String(env.ROBINHOOD_CONTINUOUS_USE_ALCHEMY || '').toLowerCase() === 'true',
    socialMetadataEnabled: String(env.ROBINHOOD_CONTINUOUS_SOCIAL_METADATA || '').toLowerCase() === 'true',
    publicRpcUrl: env.ROBINHOOD_RPC_URL || PUBLIC_RPC_URL,
    alchemyRpcUrl: env.ROBINHOOD_ALCHEMY_RPC_URL || null,
  };
}

function createClient(options) {
  const providers = [{ name: 'robinhood-public', url: options.publicRpcUrl }];
  if (options.useAlchemy && options.alchemyRpcUrl) {
    providers.push({ name: 'alchemy-free', url: options.alchemyRpcUrl });
  }
  return createEvmJsonRpcClient({ providers, timeoutMs: 15000, maxRetries: 1 });
}

function compactWindow(window) {
  return {
    protocol: window.protocol,
    marketKey: window.marketKey,
    tokenAddress: window.tokenAddress,
    window: window.window,
    swaps: window.swaps,
    txns: window.txns,
    volumeUsd: window.volumeUsd,
    priceChangePct: window.priceChangePct,
  };
}

function summarizeWindows(windows = []) {
  const byWindow = {};
  for (const window of windows) byWindow[window.window] = (byWindow[window.window] || 0) + 1;
  const shortestWindowMs = windows.reduce((minimum, window) => Math.min(minimum, window.windowMs), Infinity);
  const activityWindows = windows.filter((window) => window.windowMs === shortestWindowMs);
  const topBySwaps = [...activityWindows]
    .sort((left, right) => Number(right.swaps || 0) - Number(left.swaps || 0))
    .slice(0, 5)
    .map(compactWindow);
  const extremeByMarket = new Map();
  for (const window of windows) {
    const current = extremeByMarket.get(window.marketKey);
    if (!current || Math.abs(Number(window.priceChangePct || 0)) > Math.abs(Number(current.priceChangePct || 0))) {
      extremeByMarket.set(window.marketKey, window);
    }
  }
  const topPriceChanges = [...extremeByMarket.values()]
    .sort((left, right) => Math.abs(Number(right.priceChangePct || 0)) - Math.abs(Number(left.priceChangePct || 0)))
    .slice(0, 5)
    .map(compactWindow);
  return {
    total: windows.length,
    markets: new Set(windows.map((window) => window.marketKey)).size,
    byWindow,
    activityWindow: Number.isFinite(shortestWindowMs) ? activityWindows[0]?.window : null,
    topBySwaps,
    topPriceChanges,
  };
}

function compactReport(snapshot) {
  return {
    durationMs: snapshot.durationMs,
    coverage: snapshot.coverage,
    cycles: snapshot.runner.cycles,
    errors: snapshot.runner.errors,
    recoveries: snapshot.runner.recoveries,
    consecutiveErrors: snapshot.runner.consecutiveErrors,
    errorKinds: snapshot.runner.errorKinds,
    lastError: snapshot.runner.lastError,
    tracked: snapshot.pipeline.tracked,
    swapsDecoded: snapshot.pipeline.metrics.swapsDecoded,
    swapsAccepted: snapshot.pipeline.metrics.swapsAccepted,
    swapsRejected: snapshot.pipeline.metrics.swapsRejected,
    withoutQuoteRate: snapshot.pipeline.metrics.withoutQuoteRate,
    v2ReserveDepleted: snapshot.pipeline.metrics.v2ReserveDepleted,
    processingDelayMs: snapshot.pipeline.metrics.processingDelayMs,
    protocols: snapshot.pipeline.metrics.protocols,
    enrichment: snapshot.pipeline.enrichment,
    windowSummary: summarizeWindows(snapshot.pipeline.windows),
    socialMetadata: snapshot.pipeline.socialMetadata,
    transport: snapshot.transport,
    backfill: snapshot.backfill,
    rpc: snapshot.rpc,
    alchemyEnabled: snapshot.alchemyEnabled,
    noxaComparison: snapshot.noxaComparison,
  };
}

async function runContinuousDryRun(options = readOptions()) {
  const rpcClient = options.rpcClient || createClient(options);
  const socialMetadataQueue = options.socialMetadataQueue
    || (options.socialMetadataEnabled ? createRobinhoodSocialMetadataQueue() : null);
  const runner = await (options.runnerFactory || createRobinhoodContinuousRunner)({
    rpcClient,
    startBlock: options.startBlock,
    lookbackBlocks: options.lookbackBlocks,
    confirmations: options.confirmations,
    rangeSize: options.rangeSize,
    timestampConcurrency: options.timestampConcurrency,
    observationConcurrency: options.observationConcurrency,
    socialMetadataQueue,
    seedLogs: {
      v2: [v2Fixture.pairCreated],
      v3: [v3Fixture.poolCreated],
      v4: [v4Fixture.initialize],
    },
  });
  const logger = options.logger || console;
  logger.log(`[RobinhoodContinuous] mode=read-only durationSeconds=${options.durationSeconds} lookbackBlocks=${options.lookbackBlocks} timestampConcurrency=${options.timestampConcurrency} observationConcurrency=${options.observationConcurrency} socialMetadata=${Boolean(socialMetadataQueue)} alchemy=${options.useAlchemy && Boolean(options.alchemyRpcUrl)}`);
  const print = (snapshot) => logger.log(`[RobinhoodContinuous] report=${JSON.stringify(compactReport(snapshot))}`);
  const snapshot = await runner.runFor(options.durationSeconds * 1000, {
    intervalMs: options.pollIntervalMs,
    reportIntervalMs: options.reportIntervalSeconds * 1000,
    onReport: print,
    onError: (error) => logger.error(`[RobinhoodContinuous] error=${error.message}`),
  });
  print(snapshot);
  return snapshot;
}

if (require.main === module) {
  runContinuousDryRun().then((snapshot) => {
    if (!snapshot.coverage.caughtUp || snapshot.runner.consecutiveErrors > 0) process.exitCode = 1;
  }).catch((error) => {
    console.error(`[RobinhoodContinuous] fatal=${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { compactReport, createClient, readOptions, runContinuousDryRun, summarizeWindows };
