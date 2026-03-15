const tokenCatalog = require('../models/token-catalog');
const tokenMeteoraSnapshot = require('../models/token-meteora-snapshot');
const meteora = require('./meteora');

const LOOP_INTERVAL_MS = 30 * 1000;
const BATCH_LIMIT = 45;

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

async function runOnce() {
  if (!running) return;

  const tokens = await tokenCatalog.listEligibleForSnapshots(BATCH_LIMIT);
  const addresses = tokens.map((token) => token.address);
  status.lastRunAt = new Date().toISOString();
  status.lastProcessed = addresses.length;
  status.totalProcessed += addresses.length;

  if (addresses.length === 0) {
    return;
  }

  try {
    const results = await meteora.fetchMeteoraBulk(addresses);
    for (const address of addresses) {
      const result = results[address];
      if (!result || !(Number(result.tvl) > 0)) {
        continue;
      }

      await tokenMeteoraSnapshot.insertSnapshot({
        tokenAddress: address,
        totalTvl: result.tvl,
        bestPoolAddress: result.poolAddress,
        poolCount: result.poolCount,
        source: 'meteora',
      });
      status.totalInserted += 1;
    }
  } catch (err) {
    status.totalErrors += 1;
    console.error('[MeteoraSnapshotWorker] Failed to snapshot batch:', err.message);
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
  console.log('[MeteoraSnapshotWorker] Started');
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
