const RULE_VERSION = 'rh_fresh_signed_v1';
const REASON_CODE = 'new_wallet_at_first_buy';
const MAX_PRIOR_SIGNED_TRANSACTIONS = 5n;
const WINDOW_MS = 24 * 60 * 60 * 1000;

function unsigned(value, label) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized)) throw new Error(`${label} must be an unsigned integer`);
  return BigInt(normalized);
}

function instant(value, label) {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value ?? ''));
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be an ISO instant`);
  return new Date(parsed).toISOString();
}

function evaluateRobinhoodFreshWallet(input = {}) {
  if (input.ruleVersion !== RULE_VERSION) throw new Error(`ruleVersion must be ${RULE_VERSION}`);
  const firstBuyNonce = unsigned(input.firstBuy?.nonce, 'firstBuy.nonce');
  const cutoffNonce = unsigned(input.cutoff?.nonce, 'cutoff.nonce');
  const firstBuyAt = instant(input.firstBuy?.blockTime, 'firstBuy.blockTime');
  const cutoffAt = instant(input.cutoff?.targetAt, 'cutoff.targetAt');
  const cutoffBlockTime = instant(input.cutoff?.blockTime, 'cutoff.blockTime');
  const nextBlockTime = instant(input.nextBlock?.blockTime, 'nextBlock.blockTime');
  const cutoffBlock = unsigned(input.cutoff?.number, 'cutoff.number');
  const nextBlock = unsigned(input.nextBlock?.number, 'nextBlock.number');
  if (Date.parse(cutoffAt) !== Date.parse(firstBuyAt) - WINDOW_MS
      || nextBlock !== cutoffBlock + 1n
      || Date.parse(cutoffBlockTime) >= Date.parse(cutoffAt)
      || Date.parse(nextBlockTime) < Date.parse(cutoffAt)) {
    throw new Error('cutoff blocks do not prove the strict 24-hour boundary');
  }
  const fresh = cutoffNonce === 0n && firstBuyNonce <= MAX_PRIOR_SIGNED_TRANSACTIONS;
  const outcomeReason = cutoffNonce > 0n
    ? 'signed_activity_before_window'
    : firstBuyNonce > MAX_PRIOR_SIGNED_TRANSACTIONS
      ? 'too_many_prior_signed_transactions'
      : REASON_CODE;
  return Object.freeze({
    ruleVersion: RULE_VERSION,
    outcome: fresh ? 'fresh' : 'not_fresh',
    outcomeReason,
    reasonCode: fresh ? REASON_CODE : null,
    confidence: fresh ? 'high' : null,
  });
}

module.exports = {
  MAX_PRIOR_SIGNED_TRANSACTIONS,
  REASON_CODE,
  RULE_VERSION,
  evaluateRobinhoodFreshWallet,
};
