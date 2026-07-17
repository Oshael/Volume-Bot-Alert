const { formatDecimal, parseDecimal, rational } = require('./evm-market-metrics');

const DEFAULT_WINDOWS = Object.freeze([
  Object.freeze({ label: '1m', durationMs: 60_000 }),
  Object.freeze({ label: '5m', durationMs: 300_000 }),
  Object.freeze({ label: '1h', durationMs: 3_600_000 }),
  Object.freeze({ label: '6h', durationMs: 21_600_000 }),
  Object.freeze({ label: '24h', durationMs: 86_400_000 }),
]);

function normalizeWindows(windows = DEFAULT_WINDOWS) {
  const normalized = (Array.isArray(windows) ? windows : DEFAULT_WINDOWS).map((window) => ({
    label: String(window?.label || '').trim(),
    durationMs: Number(window?.durationMs),
  })).filter((window) => window.label && Number.isSafeInteger(window.durationMs) && window.durationMs > 0);
  if (!normalized.length) throw new Error('At least one valid market window is required');
  return normalized.sort((left, right) => left.durationMs - right.durationMs);
}

function eventIdentity(event) {
  const chain = String(event?.chain || '').toLowerCase();
  const transactionHash = String(event?.transactionHash || '').toLowerCase();
  const rawIndex = String(event?.logIndex ?? '');
  const logIndex = /^0x[0-9a-f]+$/i.test(rawIndex) || /^\d+$/.test(rawIndex)
    ? BigInt(rawIndex).toString()
    : '';
  return chain && transactionHash && logIndex ? `${chain}:${transactionHash}:${logIndex}` : null;
}

function normalizeEvent(observation) {
  if (!observation?.accepted) return null;
  const id = eventIdentity(observation);
  const marketKey = String(observation.marketKey || '').toLowerCase();
  const tokenAddress = String(observation.tokenAddress || '').toLowerCase();
  const protocol = String(observation.protocol || '');
  const side = String(observation.side || '');
  const timestampMs = Number(observation.timestampMs);
  if (!id || !marketKey || !tokenAddress || !protocol || !['buy', 'sell'].includes(side)) return null;
  if (!Number.isSafeInteger(timestampMs) || timestampMs <= 0) return null;
  const priceUsd = parseDecimal(observation.priceUsd, 'priceUsd');
  const volumeUsd = parseDecimal(observation.volumeUsd, 'volumeUsd');
  if (priceUsd.numerator <= 0n || volumeUsd.numerator < 0n) return null;
  return {
    id,
    chain: String(observation.chain).toLowerCase(),
    protocol,
    marketKey,
    tokenAddress,
    transactionHash: String(observation.transactionHash).toLowerCase(),
    logIndex: String(observation.logIndex),
    side,
    timestampMs,
    priceUsd,
    volumeUsd,
  };
}

function addRational(left, right) {
  return rational(
    left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator
  );
}

function priceChange(first, latest) {
  return rational(
    (latest.numerator * first.denominator - first.numerator * latest.denominator) * 100n,
    latest.denominator * first.numerator
  );
}

function createAccumulator(event, window) {
  return {
    chain: event.chain,
    protocol: event.protocol,
    marketKey: event.marketKey,
    tokenAddress: event.tokenAddress,
    window: window.label,
    windowMs: window.durationMs,
    swaps: 0,
    buys: 0,
    sells: 0,
    transactions: new Set(),
    volumeUsd: rational(0n),
    first: null,
    latest: null,
  };
}

function addToAccumulator(accumulator, event) {
  accumulator.swaps += 1;
  accumulator[event.side === 'buy' ? 'buys' : 'sells'] += 1;
  accumulator.transactions.add(event.transactionHash);
  accumulator.volumeUsd = addRational(accumulator.volumeUsd, event.volumeUsd);
  if (!accumulator.first || event.timestampMs < accumulator.first.timestampMs) accumulator.first = event;
  if (!accumulator.latest || event.timestampMs >= accumulator.latest.timestampMs) accumulator.latest = event;
}

function finalize(accumulator) {
  const change = priceChange(accumulator.first.priceUsd, accumulator.latest.priceUsd);
  return {
    chain: accumulator.chain,
    protocol: accumulator.protocol,
    marketKey: accumulator.marketKey,
    tokenAddress: accumulator.tokenAddress,
    window: accumulator.window,
    windowMs: accumulator.windowMs,
    swaps: accumulator.swaps,
    buys: accumulator.buys,
    sells: accumulator.sells,
    txns: accumulator.transactions.size,
    volumeUsd: formatDecimal(accumulator.volumeUsd, 12),
    firstPriceUsd: formatDecimal(accumulator.first.priceUsd, 30),
    latestPriceUsd: formatDecimal(accumulator.latest.priceUsd, 30),
    priceChangePct: formatDecimal(change, 12),
    firstObservedAtMs: accumulator.first.timestampMs,
    latestObservedAtMs: accumulator.latest.timestampMs,
    exactVolumeUsd: {
      numerator: accumulator.volumeUsd.numerator.toString(),
      denominator: accumulator.volumeUsd.denominator.toString(),
    },
  };
}

function compareReports(left, right) {
  if (left.windowMs !== right.windowMs) return left.windowMs - right.windowMs;
  if (left.swaps !== right.swaps) return right.swaps - left.swaps;
  return left.marketKey.localeCompare(right.marketKey);
}

function createEvmMarketWindowAggregator(options = {}) {
  const windows = normalizeWindows(options.windows);
  const maxWindowMs = windows.at(-1).durationMs;
  const maxEvents = Math.max(1, Number(options.maxEvents) || 100000);
  const events = new Map();

  function prune(nowMs = Date.now()) {
    const cutoff = nowMs - maxWindowMs;
    let removed = 0;
    for (const [id, event] of events) {
      if (event.timestampMs < cutoff || events.size > maxEvents) {
        events.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  function add(observation, nowMs = Date.now()) {
    const event = normalizeEvent(observation);
    if (!event) return { accepted: false, reason: 'invalid_observation' };
    if (events.has(event.id)) return { accepted: false, reason: 'duplicate_log' };
    events.set(event.id, event);
    prune(nowMs);
    return { accepted: true, event };
  }

  function remove(observation) {
    const id = eventIdentity(observation);
    return id ? events.delete(id) : false;
  }

  function snapshot(nowMs = Date.now()) {
    prune(nowMs);
    const reports = [];
    for (const window of windows) {
      const cutoff = nowMs - window.durationMs;
      const accumulators = new Map();
      for (const event of events.values()) {
        if (event.timestampMs < cutoff) continue;
        const key = `${event.protocol}:${event.marketKey}`;
        if (!accumulators.has(key)) accumulators.set(key, createAccumulator(event, window));
        addToAccumulator(accumulators.get(key), event);
      }
      reports.push(...[...accumulators.values()].map(finalize));
    }
    return reports.sort(compareReports);
  }

  return Object.freeze({
    add,
    addMany: (observations, nowMs) => observations.map((item) => add(item, nowMs)),
    remove,
    prune,
    snapshot,
    size: () => events.size,
  });
}

module.exports = {
  DEFAULT_WINDOWS,
  createEvmMarketWindowAggregator,
  eventIdentity,
};
