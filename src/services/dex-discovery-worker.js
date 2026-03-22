const tokenCatalog = require('../models/token-catalog');
const dexscreener = require('./dexscreener');
const { isValidAddress } = require('../models/user-token');

const LOOP_INTERVAL_MS = 60 * 1000;
const PROFILE_LIMIT = 30;
const BOOST_TOP_LIMIT = 20;
const BOOST_LATEST_LIMIT = 20;
const CHAIN_ID = 'solana';
const DISCOVERY_SOURCE = 'dexscreener-discovery';

let timer = null;
let running = false;
let status = {
  running: false,
  lastRunAt: null,
  lastProcessed: 0,
  totalProcessed: 0,
  totalUpserts: 0,
  totalNewAddresses: 0,
  totalScheduled: 0,
  totalSkippedExisting: 0,
  totalErrors: 0,
};

function collectAddresses(items, limit) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => String(item?.chainId || '').trim().toLowerCase() === CHAIN_ID)
    .map((item) => String(item?.tokenAddress || '').trim())
    .filter((address) => isValidAddress(address))
    .slice(0, limit);
}

async function upsertDiscoveredAddress(address) {
  const existing = await tokenCatalog.getByAddress(address);
  if (existing) {
    status.totalSkippedExisting += 1;
    return;
  }

  await tokenCatalog.upsertToken({
    address,
    chain: CHAIN_ID,
    source: DISCOVERY_SOURCE,
    isActiveMonitorCandidate: true,
  });
  await tokenCatalog.scheduleImmediateEvaluation(address);

  status.totalUpserts += 1;
  status.totalNewAddresses += 1;
  status.totalScheduled += 1;
}

async function runOnce() {
  if (!running) return;

  status.lastRunAt = new Date().toISOString();

  try {
    const [profiles, boostsTop, boostsLatest] = await Promise.all([
      dexscreener.getLatestTokenProfiles(),
      dexscreener.getTopTokenBoosts(),
      dexscreener.getLatestTokenBoosts(),
    ]);

    const addresses = [
      ...collectAddresses(profiles, PROFILE_LIMIT),
      ...collectAddresses(boostsTop, BOOST_TOP_LIMIT),
      ...collectAddresses(boostsLatest, BOOST_LATEST_LIMIT),
    ];

    const uniqueAddresses = [...new Set(addresses)];
    status.lastProcessed = uniqueAddresses.length;
    status.totalProcessed += uniqueAddresses.length;

    for (const address of uniqueAddresses) {
      try {
        await upsertDiscoveredAddress(address);
      } catch (err) {
        status.totalErrors += 1;
        console.error(`[DexDiscoveryWorker] Failed to catalog ${address}:`, err.message);
      }
    }
  } catch (err) {
    status.totalErrors += 1;
    console.error('[DexDiscoveryWorker] Discovery fetch failed:', err.message);
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
  console.log('[DexDiscoveryWorker] Started');
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
