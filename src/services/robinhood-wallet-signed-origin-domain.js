function unsigned(value, label) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized)) throw new Error(`${label} must be an unsigned integer`);
  return BigInt(normalized);
}

function position(input, label) {
  return {
    blockNumber: unsigned(input?.blockNumber, `${label}.blockNumber`),
    transactionIndex: unsigned(input?.transactionIndex, `${label}.transactionIndex`),
  };
}

function comparePosition(left, right) {
  if (left.blockNumber !== right.blockNumber) {
    return left.blockNumber < right.blockNumber ? -1 : 1;
  }
  if (left.transactionIndex === right.transactionIndex) return 0;
  return left.transactionIndex < right.transactionIndex ? -1 : 1;
}

function unavailable(reason) {
  return Object.freeze({ status: 'unavailable', priorSignedActivity: null, reason });
}

const SAFE_UNAVAILABLE_REASONS = new Set([
  'positive_nonce_without_observed_predecessor',
]);

function isSafeSignedOriginUnavailableReason(reason) {
  return SAFE_UNAVAILABLE_REASONS.has(String(reason || ''));
}

function inferPriorSignedActivity(input = {}) {
  const cutoffBlock = unsigned(input.cutoffBlock, 'cutoffBlock');
  const coverageOrigin = unsigned(input.coverage?.originBlock, 'coverage.originBlock');
  const coverageThrough = unsigned(input.coverage?.throughBlock, 'coverage.throughBlock');
  const firstBuy = position(input.firstBuy, 'firstBuy');

  if (cutoffBlock > firstBuy.blockNumber) {
    throw new Error('cutoffBlock must not follow firstBuy.blockNumber');
  }
  if (coverageOrigin > cutoffBlock) return unavailable('coverage_starts_after_cutoff');
  if (coverageThrough < firstBuy.blockNumber) return unavailable('coverage_incomplete');
  if (!input.signedOrigin) return unavailable('signed_origin_missing');

  const signedOrigin = position(input.signedOrigin, 'signedOrigin');
  const nonce = unsigned(input.signedOrigin.nonce, 'signedOrigin.nonce');
  if (signedOrigin.blockNumber < coverageOrigin
      || signedOrigin.blockNumber > coverageThrough) {
    return unavailable('signed_origin_outside_coverage');
  }
  if (comparePosition(signedOrigin, firstBuy) > 0) {
    return unavailable('signed_origin_after_first_buy');
  }

  const signedByCutoff = signedOrigin.blockNumber <= cutoffBlock;
  if (!signedByCutoff && nonce > 0n) {
    return unavailable('positive_nonce_without_observed_predecessor');
  }
  return Object.freeze({
    status: 'ready',
    priorSignedActivity: signedByCutoff,
    reason: signedByCutoff
      ? 'signed_at_or_before_cutoff'
      : 'no_signed_activity_before_cutoff',
  });
}

module.exports = {
  comparePosition, inferPriorSignedActivity, isSafeSignedOriginUnavailableReason,
};
