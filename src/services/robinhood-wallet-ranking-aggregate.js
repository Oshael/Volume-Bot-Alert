const { normalizeTokenAddress } = require('../utils/token-identity');
const { formatDecimal, parseDecimal, rational } = require('./evm-market-metrics');
const { scoreOpenWalletPosition } = require('./robinhood-wallet-ranking-domain');
const { scoreOpenWalletPositionSnapshot } = require('./robinhood-wallet-ranking-snapshot-domain');

const WINDOW_MS = Object.freeze({
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
  ALL: null,
});
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_BATCH_SIZE = 100;

function add(left, right) {
  return rational(
    left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
}

function compareGain(left, right) {
  const difference = left.gain.numerator * right.gain.denominator
    - right.gain.numerator * left.gain.denominator;
  if (difference !== 0n) return difference > 0n ? -1 : 1;
  return left.walletAddress.localeCompare(right.walletAddress);
}

function normalizeInput(input) {
  if (!Object.hasOwn(WINDOW_MS, input.window)) throw new Error('window is invalid');
  if (input.positionSource != null && !['event_history', 'snapshot'].includes(input.positionSource)) {
    throw new Error('positionSource is invalid');
  }
  const asOf = new Date(input.asOf);
  if (!Number.isFinite(asOf.getTime())) throw new Error('asOf is invalid');
  const limit = input.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error(`limit must be between 1 and ${MAX_LIMIT}`);
  }
  const windowStart = WINDOW_MS[input.window] == null
    ? null : new Date(asOf.getTime() - WINDOW_MS[input.window]);
  return { asOf, windowStart, limit };
}

function scorePosition(position, { asOf, windowStart, window, positionSource }) {
  if (positionSource === 'snapshot' && position.tokenDecimals == null) {
    return { eligible: true, gainUsd: null, coverage: 'partial',
      reasons: ['token_decimals_unavailable'] };
  }
  if (positionSource === 'snapshot') {
    return scoreOpenWalletPositionSnapshot({ ...position, asOf, window });
  }
  return scoreOpenWalletPosition({
    asOf, windowStart,
    tokenDecimals: position.tokenDecimals,
    currentPriceUsd: position.currentPriceUsd,
    windowStartPriceUsd: position.windowStartPriceUsd,
    historyComplete: position.historyComplete,
    events: position.events,
  });
}

function normalizedPosition(position) {
  return {
    ...position,
    walletAddress: normalizeTokenAddress('robinhood', position.walletAddress),
    tokenAddress: normalizeTokenAddress('robinhood', position.tokenAddress),
  };
}

// The caller owns source consistency and must stream a fixed cut in wallet/token order.
function createOpenWalletRankingAccumulator(input = {}) {
  const { asOf, windowStart, limit } = normalizeInput(input);
  const { window, positionSource } = input;
  const best = [];
  const reasons = new Set();
  let wallet = null;
  let lastPair = null;
  let candidateWalletCount = 0;
  let excludedWalletCount = 0;
  let state = 'open';

  function ensureOpen() {
    if (state !== 'open') throw new Error(`ranking accumulator is ${state}`);
  }

  function completeWallet() {
    if (!wallet) return;
    if (wallet.partial) excludedWalletCount += 1;
    else if (wallet.openPositionCount) {
      const index = best.findIndex((entry) => compareGain(wallet, entry) < 0);
      best.splice(index < 0 ? best.length : index, 0, wallet);
      if (best.length > limit) best.pop();
    }
    wallet = null;
  }

  function consume(position) {
    const pair = `${position.walletAddress}:${position.tokenAddress}`;
    if (pair === lastPair) throw new Error('duplicate wallet/token position');
    if (lastPair != null && pair < lastPair) {
      throw new Error('positions must be ordered by wallet/token');
    }
    const score = scorePosition(position, { asOf, windowStart, window, positionSource });
    if (wallet?.walletAddress !== position.walletAddress) {
      completeWallet();
      candidateWalletCount += 1;
      wallet = { walletAddress: position.walletAddress,
        gain: rational(0n), openPositionCount: 0, partial: false };
    }
    if (score.coverage !== 'complete') {
      wallet.partial = true;
      for (const reason of score.reasons) reasons.add(reason);
    }
    if (score.eligible) {
      wallet.openPositionCount += 1;
      if (score.gainUsd != null) wallet.gain = add(wallet.gain, parseDecimal(score.gainUsd));
    }
    lastPair = pair;
  }

  function addBatch(positions) {
    ensureOpen();
    try {
      if (!Array.isArray(positions) || positions.length > MAX_BATCH_SIZE) {
        throw new Error(`positions must be a list of at most ${MAX_BATCH_SIZE}`);
      }
      for (const position of positions) consume(normalizedPosition(position));
    } catch (error) {
      state = 'failed';
      throw error;
    }
  }

  function finish({ universeComplete = false } = {}) {
    ensureOpen();
    completeWallet();
    state = 'finished';
    if (universeComplete !== true) reasons.add('candidate_universe_incomplete');
    return {
      window,
      asOf: asOf.toISOString(),
      windowStart: windowStart?.toISOString() ?? null,
      coverage: reasons.size ? 'partial' : 'complete',
      rankingIsComplete: reasons.size === 0,
      reasons: [...reasons].sort(),
      excludedWalletCount,
      candidateWalletCount,
      ranked: universeComplete === true ? best.map((entry, index) => ({
        rank: index + 1,
        walletAddress: entry.walletAddress,
        gainUsd: formatDecimal(entry.gain, 36),
        openPositionCount: entry.openPositionCount,
      })) : [],
    };
  }

  return { addBatch, finish };
}

function rankOpenWalletPositions(input = {}) {
  const accumulator = createOpenWalletRankingAccumulator(input);
  if (!Array.isArray(input.positions)) throw new Error('positions must be a list');
  const positions = input.positions.map(normalizedPosition).sort((left, right) => (
    left.walletAddress.localeCompare(right.walletAddress)
    || left.tokenAddress.localeCompare(right.tokenAddress)
  ));
  for (let index = 0; index < positions.length; index += MAX_BATCH_SIZE) {
    accumulator.addBatch(positions.slice(index, index + MAX_BATCH_SIZE));
  }
  return accumulator.finish({ universeComplete: input.universeComplete });
}

module.exports = { rankOpenWalletPositions, createOpenWalletRankingAccumulator };
