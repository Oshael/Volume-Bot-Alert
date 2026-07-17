const tokenMarketBucket1m = require('../models/token-market-bucket-1m');
const tokenMarketVolumeBucket1m = require('../models/token-market-volume-bucket-1m');
const { isValidAddress } = require('../models/user-token');
const solPrice = require('./sol-price');

const SOURCE = 'pumpfun-pre-migration';
const DEFAULT_TRACK_TTL_MS = 2 * 60 * 60 * 1000;
const DEFAULT_MAX_TRACKED = 250;
const MAX_VOLUME_EVENTS_PER_TOKEN = 1000;
const VOLUME_WINDOWS = Object.freeze({
  vol5m: 5 * 60 * 1000,
  vol1h: 60 * 60 * 1000,
  vol6h: 6 * 60 * 60 * 1000,
  vol24h: 24 * 60 * 60 * 1000,
});

let running = false;
let settings = {
  enabled: false,
  trackTtlMs: DEFAULT_TRACK_TTL_MS,
  maxTracked: DEFAULT_MAX_TRACKED,
};
let tracked = new Map();
let status = {
  running: false,
  enabled: false,
  trackedCount: 0,
  totalObserved: 0,
  totalMarketBuckets: 0,
  totalVolumeBuckets: 0,
  totalDropped: 0,
  totalErrors: 0,
  lastObservationAt: null,
  lastPersistedAt: null,
  lastError: null,
};

function resolveOptions(options = {}) {
  return {
    enabled: options.enabled === true,
    trackTtlMs: Math.max(60_000, Number(options.trackTtlMs) || DEFAULT_TRACK_TTL_MS),
    maxTracked: Math.max(1, Math.min(Number(options.maxTracked) || DEFAULT_MAX_TRACKED, 2000)),
  };
}

function toFiniteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toTimestampMs(value, fallback = Date.now()) {
  if (value == null) return fallback;
  const num = Number(value);
  if (Number.isFinite(num) && num > 0) {
    return num > 1_000_000_000_000 ? num : num * 1000;
  }
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sanitizeMint(value) {
  const mint = String(value || '').trim();
  return isValidAddress(mint) ? mint : null;
}

function getSolUsd() {
  const price = Number(solPrice.getPrice());
  return Number.isFinite(price) && price > 0 ? price : 0;
}

function resolveUsdMcapField(data) {
  const usdMcap = toFiniteNumber(data?.usd_market_cap ?? data?.usdMarketCap);
  return usdMcap && usdMcap > 0 ? usdMcap : null;
}

function resolveMarketCapSolField(data, solUsd) {
  const marketCapSol = toFiniteNumber(data?.marketCapSol);
  return marketCapSol && marketCapSol > 0 && solUsd > 0 ? marketCapSol * solUsd : null;
}

function resolveCurveMcapUsd(data, state, solUsd) {
  const virtualSolReserves = toFiniteNumber(data?.virtualSolReserves ?? state?.virtualSolReserves);
  const vTokensInBondingCurve = toFiniteNumber(data?.vTokensInBondingCurve ?? state?.vTokensInBondingCurve);
  if (!virtualSolReserves || !vTokensInBondingCurve || !(solUsd > 0)) return null;

  const priceUsd = (virtualSolReserves / 1_000_000_000) / vTokensInBondingCurve * solUsd;
  return priceUsd * 1_000_000_000;
}

function resolveMcapUsd(data, state, solUsd = getSolUsd()) {
  return resolveUsdMcapField(data)
    ?? resolveMarketCapSolField(data, solUsd)
    ?? resolveCurveMcapUsd(data, state, solUsd);
}

function resolvePriceUsd(data, mcapUsd) {
  const priceUsd = toFiniteNumber(data?.priceUsd ?? data?.price_usd);
  if (priceUsd && priceUsd > 0) return priceUsd;
  return mcapUsd && mcapUsd > 0 ? mcapUsd / 1_000_000_000 : null;
}

function resolveTradeUsd(data, solUsd = getSolUsd()) {
  const usdAmount = toFiniteNumber(data?.usdAmount ?? data?.usd_amount);
  if (usdAmount && usdAmount > 0) return usdAmount;

  const solAmount = toFiniteNumber(data?.solAmount);
  if (solAmount && solAmount > 0 && solUsd > 0) return solAmount * solUsd;

  return 0;
}

function pruneVolumeEvents(state, nowMs) {
  const cutoff = nowMs - VOLUME_WINDOWS.vol24h;
  state.volumeEvents = state.volumeEvents.filter((event) => event.ts >= cutoff);
  if (state.volumeEvents.length > MAX_VOLUME_EVENTS_PER_TOKEN) {
    state.volumeEvents.splice(0, state.volumeEvents.length - MAX_VOLUME_EVENTS_PER_TOKEN);
  }
}

function appendVolumeEvent(state, usdAmount, nowMs) {
  if (!(usdAmount > 0)) {
    pruneVolumeEvents(state, nowMs);
    return;
  }

  state.volumeEvents.push({ ts: nowMs, usd: usdAmount });
  pruneVolumeEvents(state, nowMs);
}

function sumVolumeWindow(state, nowMs, windowMs) {
  const cutoff = nowMs - windowMs;
  return state.volumeEvents.reduce((sum, event) => {
    return event.ts >= cutoff ? sum + event.usd : sum;
  }, 0);
}

function buildVolumeSnapshot(state, nowMs) {
  return {
    vol5m: sumVolumeWindow(state, nowMs, VOLUME_WINDOWS.vol5m),
    vol1h: sumVolumeWindow(state, nowMs, VOLUME_WINDOWS.vol1h),
    vol6h: sumVolumeWindow(state, nowMs, VOLUME_WINDOWS.vol6h),
    vol24h: sumVolumeWindow(state, nowMs, VOLUME_WINDOWS.vol24h),
  };
}

function touchTrackedToken(address, data, nowMs) {
  let state = tracked.get(address);
  if (!state) {
    state = {
      address,
      symbol: data?.symbol || null,
      name: data?.name || null,
      firstSeenAtMs: nowMs,
      lastSeenAtMs: nowMs,
      virtualSolReserves: null,
      vTokensInBondingCurve: null,
      volumeEvents: [],
    };
    tracked.set(address, state);
  }

  state.symbol = data?.symbol || state.symbol;
  state.name = data?.name || state.name;
  state.lastSeenAtMs = nowMs;
  state.virtualSolReserves = toFiniteNumber(data?.virtualSolReserves) ?? state.virtualSolReserves;
  state.vTokensInBondingCurve = toFiniteNumber(data?.vTokensInBondingCurve) ?? state.vTokensInBondingCurve;
  return state;
}

function pruneTracked(nowMs) {
  const cutoff = nowMs - settings.trackTtlMs;
  for (const [address, state] of tracked.entries()) {
    if (state.lastSeenAtMs < cutoff) {
      tracked.delete(address);
    }
  }

  const overflow = tracked.size - settings.maxTracked;
  if (overflow > 0) {
    const oldest = Array.from(tracked.values())
      .sort((a, b) => a.lastSeenAtMs - b.lastSeenAtMs)
      .slice(0, overflow);
    for (const state of oldest) {
      tracked.delete(state.address);
      status.totalDropped += 1;
    }
  }

  status.trackedCount = tracked.size;
}

async function persistObservation(address, data, state, nowMs, tradeUsd) {
  const solUsd = getSolUsd();
  const mcapUsd = resolveMcapUsd(data, state, solUsd);
  const priceUsd = resolvePriceUsd(data, mcapUsd);

  if (mcapUsd && mcapUsd > 0) {
    await tokenMarketBucket1m.upsertSnapshotBucket({
      tokenAddress: address,
      ts: new Date(nowMs),
      mcap: mcapUsd,
      price: priceUsd,
      source: SOURCE,
    });
    status.totalMarketBuckets += 1;
  }

  appendVolumeEvent(state, tradeUsd, nowMs);
  if (tradeUsd > 0) {
    await tokenMarketVolumeBucket1m.upsertSnapshotBucket({
      chain: 'solana',
      tokenAddress: address,
      ts: new Date(nowMs),
      ...buildVolumeSnapshot(state, nowMs),
      source: SOURCE,
    });
    status.totalVolumeBuckets += 1;
  }
}

async function processObservation(data, eventType, nowMs) {
  const address = sanitizeMint(data?.mint || data?.address);
  if (!address) return null;

  const state = touchTrackedToken(address, data, nowMs);
  const tradeUsd = eventType === 'trade' ? resolveTradeUsd(data) : 0;
  await persistObservation(address, data, state, nowMs, tradeUsd);

  status.totalObserved += 1;
  status.lastObservationAt = new Date(nowMs).toISOString();
  status.lastPersistedAt = new Date(nowMs).toISOString();
  status.lastError = null;
  pruneTracked(nowMs);

  return { address, persisted: true };
}

async function handleEvent(event = {}) {
  if (!running || !settings.enabled) return null;

  const eventType = String(event.type || '').trim().toLowerCase();
  const data = event.data || {};
  const nowMs = toTimestampMs(data.timestamp ?? data.blockTime ?? event.now);

  try {
    if (eventType === 'create' || eventType === 'trade') {
      return await processObservation(data, eventType, nowMs);
    }

    if (eventType === 'migrate') {
      const address = sanitizeMint(data?.mint || data?.address);
      if (address) tracked.delete(address);
      pruneTracked(nowMs);
    }

    return null;
  } catch (err) {
    status.totalErrors += 1;
    status.lastError = err.message;
    throw err;
  }
}

function start(options = {}) {
  settings = resolveOptions(options);
  running = settings.enabled;
  status.running = running;
  status.enabled = settings.enabled;
  status.trackedCount = tracked.size;
}

function stop() {
  running = false;
  status.running = false;
  tracked.clear();
  status.trackedCount = 0;
}

function getStatus() {
  return {
    ...status,
    trackTtlMs: settings.trackTtlMs,
    maxTracked: settings.maxTracked,
  };
}

function resetStatus() {
  running = false;
  tracked = new Map();
  settings = {
    enabled: false,
    trackTtlMs: DEFAULT_TRACK_TTL_MS,
    maxTracked: DEFAULT_MAX_TRACKED,
  };
  status = {
    running: false,
    enabled: false,
    trackedCount: 0,
    totalObserved: 0,
    totalMarketBuckets: 0,
    totalVolumeBuckets: 0,
    totalDropped: 0,
    totalErrors: 0,
    lastObservationAt: null,
    lastPersistedAt: null,
    lastError: null,
  };
}

module.exports = {
  start,
  stop,
  handleEvent,
  getStatus,
  __private: {
    resetStatus,
    resolveMcapUsd,
    resolveOptions,
    buildVolumeSnapshot,
  },
};
