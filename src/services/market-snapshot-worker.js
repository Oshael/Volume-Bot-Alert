const tokenCatalog = require('../models/token-catalog');
const tokenMarketSnapshot = require('../models/token-market-snapshot');
const dexscreener = require('./dexscreener');

const LOOP_INTERVAL_MS = 60 * 1000;
const BATCH_LIMIT = 15;

let timer = null;
let running = false;
let status = {
  running: false,
  lastRunAt: null,
  lastProcessed: 0,
  totalProcessed: 0,
  totalInserted: 0,
  totalErrors: 0,
};

function extractBestPair(data, chain) {
  return dexscreener.getBestPair(data, chain || 'solana');
}

async function snapshotToken(token) {
  const data = await dexscreener.getTokenPairs(token.address);
  const bestPair = extractBestPair(data, token.chain);
  if (!bestPair) return null;

  const marketCap = Number(bestPair.marketCap || bestPair.fdv || 0);
  if (!(marketCap > 0)) return null;

  const snapshot = await tokenMarketSnapshot.insertSnapshot({
    tokenAddress: token.address,
    mcap: marketCap,
    price: bestPair.priceUsd || null,
    vol5m: null,
    vol1h: bestPair.volume?.h1 || null,
    vol6h: bestPair.volume?.h6 || null,
    vol24h: bestPair.volume?.h24 || null,
    source: 'dexscreener',
  });

  status.totalInserted++;
  return snapshot;
}

async function runOnce() {
  if (!running) return;
  const tokens = await tokenCatalog.listEligibleForSnapshots(BATCH_LIMIT);
  status.lastRunAt = new Date().toISOString();
  status.lastProcessed = tokens.length;
  status.totalProcessed += tokens.length;

  for (const token of tokens) {
    try {
      await snapshotToken(token);
    } catch (err) {
      status.totalErrors++;
      console.error(`[MarketSnapshotWorker] Failed to snapshot ${token.address}:`, err.message);
    }
  }
}

function schedule() {
  if (!running) return;
  timer = setTimeout(async () => {
    try {
      await runOnce();
    } finally {
      schedule();
    }
  }, LOOP_INTERVAL_MS);
}

function start() {
  if (running) return;
  running = true;
  status.running = true;
  schedule();
  console.log('[MarketSnapshotWorker] Started');
}

function stop() {
  running = false;
  status.running = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

function getStatus() {
  return { ...status };
}

module.exports = { start, stop, getStatus, runOnce };
