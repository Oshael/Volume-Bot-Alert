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
  if (!Array.isArray(input.positions)) throw new Error('positions must be a list');
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

function rankOpenWalletPositions(input = {}) {
  const { asOf, windowStart, limit } = normalizeInput(input);
  const wallets = new Map();
  const seenPairs = new Set();
  const reasons = new Set();
  if (input.universeComplete !== true) reasons.add('candidate_universe_incomplete');

  for (const position of input.positions) {
    const walletAddress = normalizeTokenAddress('robinhood', position.walletAddress);
    const tokenAddress = normalizeTokenAddress('robinhood', position.tokenAddress);
    const pair = `${walletAddress}:${tokenAddress}`;
    if (seenPairs.has(pair)) throw new Error('duplicate wallet/token position');
    seenPairs.add(pair);
    const score = input.positionSource === 'snapshot' && position.tokenDecimals == null
      ? { eligible: true, gainUsd: null, coverage: 'partial',
        reasons: ['token_decimals_unavailable'] }
      : input.positionSource === 'snapshot'
        ? scoreOpenWalletPositionSnapshot({ ...position, asOf, window: input.window })
      : scoreOpenWalletPosition({
        asOf, windowStart,
        tokenDecimals: position.tokenDecimals,
        currentPriceUsd: position.currentPriceUsd,
        windowStartPriceUsd: position.windowStartPriceUsd,
        historyComplete: position.historyComplete,
        events: position.events,
      });
    const wallet = wallets.get(walletAddress) || {
      walletAddress, gain: rational(0n), openPositionCount: 0, partial: false,
    };
    if (score.coverage !== 'complete') {
      wallet.partial = true;
      for (const reason of score.reasons) reasons.add(reason);
    }
    if (score.eligible) {
      wallet.openPositionCount += 1;
      if (score.gainUsd != null) wallet.gain = add(wallet.gain, parseDecimal(score.gainUsd));
    }
    wallets.set(walletAddress, wallet);
  }

  const excludedWalletCount = [...wallets.values()].filter((wallet) => wallet.partial).length;
  const ranked = input.universeComplete === true
    ? [...wallets.values()].filter((wallet) => wallet.openPositionCount && !wallet.partial)
      .sort(compareGain).slice(0, limit).map((wallet, index) => ({
        rank: index + 1,
        walletAddress: wallet.walletAddress,
        gainUsd: formatDecimal(wallet.gain, 36),
        openPositionCount: wallet.openPositionCount,
      })) : [];
  return {
    window: input.window,
    asOf: asOf.toISOString(),
    windowStart: windowStart?.toISOString() ?? null,
    coverage: reasons.size ? 'partial' : 'complete',
    rankingIsComplete: reasons.size === 0,
    reasons: [...reasons].sort(),
    excludedWalletCount,
    candidateWalletCount: wallets.size,
    ranked,
  };
}

module.exports = { rankOpenWalletPositions };
