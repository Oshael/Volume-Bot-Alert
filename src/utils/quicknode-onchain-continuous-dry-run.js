require('dotenv').config();

const { createOnchainPriceWorker } = require('../services/quicknode-onchain-price-worker');
const { createOnchainLogTransactionStream } = require('../services/quicknode-onchain-log-transaction-stream');
const { estimateQuickNodeCredits } = require('./quicknode-transaction-probe');
const { resolveDryRunPrograms } = require('./quicknode-onchain-dry-run');

const DEFAULT_DURATION_SECONDS = 60;
const DEFAULT_REPORT_INTERVAL_SECONDS = 60;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

function readEnv(name) {
  return String(process.env[name] || '').trim();
}

function positiveInteger(value, fallback) {
  const number = Number.parseInt(String(value || ''), 10);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function nonNegativeNumber(value, fallback) {
  if (String(value ?? '').trim() === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function addressList(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function normalizeWsUrl(value) {
  const url = new URL(String(value || '').trim());
  if (url.protocol !== 'wss:' && url.protocol !== 'ws:') {
    throw new Error('QUICKNODE_SOLANA_WS_URL must be a WS(S) URL');
  }
  return url.toString();
}

function normalizeRpcUrl(value) {
  const url = new URL(String(value || '').trim());
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('QUICKNODE_SOLANA_RPC_URL must be an HTTP(S) URL');
  }
  return url.toString();
}

function maskEndpoint(value) {
  const url = new URL(value);
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length) parts[parts.length - 1] = `${parts[parts.length - 1].slice(0, 6)}...`;
  url.pathname = `/${parts.join('/')}/`;
  return url.toString();
}

function readContinuousOptions() {
  const transport = readEnv('QUICKNODE_CONTINUOUS_TRANSPORT').toLowerCase() || 'full';
  if (transport !== 'full' && transport !== 'logs') {
    throw new Error('QUICKNODE_CONTINUOUS_TRANSPORT must be full or logs');
  }
  return {
    wsUrl: normalizeWsUrl(readEnv('QUICKNODE_SOLANA_WS_URL')),
    rpcUrl: transport === 'logs' ? normalizeRpcUrl(readEnv('QUICKNODE_SOLANA_RPC_URL')) : null,
    transport,
    programs: resolveDryRunPrograms(readEnv('QUICKNODE_CONTINUOUS_PROGRAMS')),
    durationSeconds: positiveInteger(readEnv('QUICKNODE_CONTINUOUS_DURATION_SECONDS'), DEFAULT_DURATION_SECONDS),
    reportIntervalSeconds: positiveInteger(
      readEnv('QUICKNODE_CONTINUOUS_REPORT_INTERVAL_SECONDS'),
      DEFAULT_REPORT_INTERVAL_SECONDS,
    ),
    minSolVolume: nonNegativeNumber(readEnv('QUICKNODE_CONTINUOUS_MIN_SOL_VOLUME'), 0.01),
    minUsdVolume: nonNegativeNumber(readEnv('QUICKNODE_CONTINUOUS_MIN_USD_VOLUME'), 1.5),
    exclude: addressList(readEnv('QUICKNODE_CONTINUOUS_EXCLUDE')),
    required: addressList(readEnv('QUICKNODE_CONTINUOUS_REQUIRED')),
    fetchConcurrency: positiveInteger(readEnv('QUICKNODE_CONTINUOUS_FETCH_CONCURRENCY'), 2),
    fetchBatchSize: positiveInteger(readEnv('QUICKNODE_CONTINUOUS_FETCH_BATCH_SIZE'), 50),
    fetchBatchWaitMs: positiveInteger(readEnv('QUICKNODE_CONTINUOUS_FETCH_BATCH_WAIT_MS'), 50),
    fetchAvailabilityDelayMs: nonNegativeNumber(readEnv('QUICKNODE_CONTINUOUS_FETCH_AVAILABILITY_DELAY_MS'), 500),
    fetchAttempts: positiveInteger(readEnv('QUICKNODE_CONTINUOUS_FETCH_ATTEMPTS'), 4),
    fetchRetryMs: positiveInteger(readEnv('QUICKNODE_CONTINUOUS_FETCH_RETRY_MS'), 250),
    fetchMaxQueueSize: positiveInteger(readEnv('QUICKNODE_CONTINUOUS_FETCH_MAX_QUEUE_SIZE'), 2_000),
  };
}

function summarizeTraffic(programs = []) {
  const receivedBytes = programs.reduce((sum, item) => sum + (Number(item.traffic?.receivedBytes) || 0), 0);
  return {
    receivedBytes,
    estimatedCredits: Math.round(estimateQuickNodeCredits(receivedBytes) * 100) / 100,
  };
}

function settleWithin(promise, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    Promise.resolve(promise).then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        clearTimeout(timer);
        resolve(false);
      },
    );
  });
}

function printSnapshot(snapshot) {
  const traffic = summarizeTraffic(snapshot.programs);
  console.log(`[QuickNodeContinuous] summaries=${snapshot.summaries} accepted=${snapshot.acceptedSwaps} blocked=${snapshot.blocked} lowVolume=${snapshot.lowVolume} prices=${snapshot.priceObservations} tracked=${snapshot.trackedPrices} change1h=${snapshot.priceChanges1h} errors=${snapshot.errors} bytes=${traffic.receivedBytes} estimatedCredits=${traffic.estimatedCredits}`);
  for (const program of snapshot.programs) {
    console.log(`[QuickNodeContinuous] program=${program.program} seen=${program.seen} matches=${program.matches} mentionOnly=${program.skippedMentionOnly} bytes=${program.traffic.receivedBytes}`);
  }
  if (snapshot.http) {
    console.log(`[QuickNodeContinuous] http requests=${snapshot.http.requests} methodCalls=${snapshot.http.methodCalls} fetched=${snapshot.http.fetched} unavailable=${snapshot.http.unavailable} errors=${snapshot.http.errors} dropped=${snapshot.http.dropped} rateLimitedBatches=${snapshot.http.rateLimitedBatches} responseBytes=${snapshot.http.responseBytes} active=${snapshot.http.active} queued=${snapshot.http.queued}`);
  }
}

async function runContinuousDryRun(options = readContinuousOptions()) {
  console.log(`[QuickNodeContinuous] WS ${maskEndpoint(options.wsUrl)}`);
  console.log(`[QuickNodeContinuous] programs=${options.programs.map((program) => program.label).join(',')} transport=${options.transport || 'full'} durationSeconds=${options.durationSeconds} reportEvery=${options.reportIntervalSeconds}s`);
  console.log(`[QuickNodeContinuous] mode=dry-run publishAlerts=false minSolVolume=${options.minSolVolume} minUsdVolume=${options.minUsdVolume}`);
  if (options.transport === 'logs') {
    console.log(`[QuickNodeContinuous] fetch concurrency=${options.fetchConcurrency} batchSize=${options.fetchBatchSize} batchWaitMs=${options.fetchBatchWaitMs} availabilityDelayMs=${options.fetchAvailabilityDelayMs} attempts=${options.fetchAttempts} retryMs=${options.fetchRetryMs} maxQueue=${options.fetchMaxQueueSize}`);
  }

  const worker = (options.workerFactory || createOnchainPriceWorker)({
    ...options,
    streamFactory: options.streamFactory || (options.transport === 'logs'
      ? createOnchainLogTransactionStream
      : undefined),
    onStatus: ({ status, program, delayMs }) => {
      if (status === 'subscribed') console.log(`[QuickNodeContinuous] subscribed=${program}`);
      if (status === 'reconnecting') console.log(`[QuickNodeContinuous] reconnectingInMs=${delayMs}`);
    },
    onError: (error) => console.error(`[QuickNodeContinuous] error=${error.message}`),
    onPriceChange: (change) => {
      console.log(`[QuickNodeContinuous] priceChange1h token=${change.tokenMint} pct=${change.priceChangePct} quoteUnit=${change.quoteUnit} current=${change.currentPrice} baseline=${change.baselinePrice}`);
    },
  });

  let stopped = false;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const handleSignal = () => { void stop(); };
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    clearInterval(reportTimer);
    clearTimeout(durationTimer);
    process.removeListener('SIGINT', handleSignal);
    process.removeListener('SIGTERM', handleSignal);
    const drained = await settleWithin(worker.stop(), options.shutdownTimeoutMs || DEFAULT_SHUTDOWN_TIMEOUT_MS);
    const snapshot = { ...worker.snapshot(), drainTimedOut: !drained };
    printSnapshot(snapshot);
    if (!drained) console.error('[QuickNodeContinuous] drainTimedOut=true');
    resolveDone(snapshot);
  };
  const reportTimer = setInterval(() => printSnapshot(worker.snapshot()), options.reportIntervalSeconds * 1000);
  const durationTimer = setTimeout(stop, options.durationSeconds * 1000);
  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);
  worker.start();
  return done;
}

if (require.main === module) {
  const db = require('../models/db');
  const cliOptions = readContinuousOptions();
  const watchdogMs = (cliOptions.durationSeconds * 1000) + DEFAULT_SHUTDOWN_TIMEOUT_MS + 5_000;
  const watchdog = setTimeout(() => {
    console.error('[QuickNodeContinuous] hardShutdownTimeout=true');
    process.exit(2);
  }, watchdogMs);
  runContinuousDryRun(cliOptions).then(async (snapshot) => {
    const poolClosed = await settleWithin(db.pool.end(), 3_000);
    clearTimeout(watchdog);
    if (!poolClosed) console.error('[QuickNodeContinuous] poolCloseTimedOut=true');
    process.exit(snapshot.drainTimedOut ? 2 : 0);
  }).catch((error) => {
    clearTimeout(watchdog);
    console.error(`[QuickNodeContinuous] failed=${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  readContinuousOptions,
  runContinuousDryRun,
  settleWithin,
  summarizeTraffic,
};
