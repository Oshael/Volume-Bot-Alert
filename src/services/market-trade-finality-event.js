'use strict';

const { createTokenIdentity } = require('../utils/token-identity');

const PROTOCOL_VERSION = 2;
const UPDATE_TYPES = new Map([
  ['market:trade:observed', 'observed'],
  ['market:trade:finalized', 'finalized'],
]);

function timestamp(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function hash(value) {
  const normalized = String(value || '').toLowerCase();
  return /^0x[0-9a-f]{64}$/.test(normalized) ? normalized : null;
}

function identity(payload) {
  try {
    const token = createTokenIdentity(payload?.chain, payload?.address);
    const transactionHash = hash(payload?.transactionHash);
    const actionIndex = Number(payload?.actionIndex);
    const asOfBlock = Number(payload?.asOfBlock ?? payload?.blockNumber);
    const asOfBlockHash = hash(payload?.asOfBlockHash ?? payload?.blockHash);
    const valid = [
      token.chain === 'robinhood', transactionHash,
      nonNegativeInteger(actionIndex), nonNegativeInteger(asOfBlock), asOfBlockHash,
    ].every(Boolean);
    if (!valid) return null;
    return { token, transactionHash, actionIndex, asOfBlock, asOfBlockHash };
  } catch (_) {
    return null;
  }
}

function normalizeUpdate(payload, common, finality) {
  const blockNumber = Number(payload?.blockNumber);
  const blockTime = timestamp(payload?.blockTime);
  const walletAddress = String(payload?.walletAddress || '').toLowerCase();
  const side = String(payload?.side || '');
  const numeric = (value) => (value == null || value === '' ? null : Number(value));
  const amountUsd = numeric(payload?.amountUsd);
  const priceUsd = numeric(payload?.priceUsd);
  const mcUsd = numeric(payload?.mcUsd);
  const valid = [
    finality, payload?.finality === finality, blockNumber === common.asOfBlock,
    blockTime, /^0x[0-9a-f]{40}$/.test(walletAddress), ['buy', 'sell'].includes(side),
    ...[amountUsd, priceUsd, mcUsd].map((value) => value == null || Number.isFinite(value)),
  ].every(Boolean);
  return valid ? {
    ...common, finality, blockNumber, blockTime, walletAddress, side,
    amountUsd, priceUsd, mcUsd,
  } : null;
}

function normalizeMarketTradeFinalityEvent(payload) {
  if (Number(payload?.protocolVersion) !== PROTOCOL_VERSION) return null;
  const type = String(payload?.type || '');
  const key = identity(payload);
  const observedAt = timestamp(payload?.observedAt);
  const publishedAt = timestamp(payload?.publishedAt);
  if (!key || !observedAt || !publishedAt) return null;
  const common = {
    protocolVersion: PROTOCOL_VERSION,
    type,
    chain: key.token.chain,
    address: key.token.address,
    transactionHash: key.transactionHash,
    actionIndex: key.actionIndex,
    asOfBlock: key.asOfBlock,
    asOfBlockHash: key.asOfBlockHash,
    observedAt,
    publishedAt,
    latency: payload?.latency && typeof payload.latency === 'object'
      ? payload.latency : undefined,
  };
  if (type === 'market:trade:invalidate') {
    return payload?.reason === 'reorg' ? { ...common, reason: 'reorg' } : null;
  }
  const finality = UPDATE_TYPES.get(type);
  return normalizeUpdate(payload, common, finality);
}

function buildMarketTradeFinalityEvent(payload, finality) {
  const type = finality === 'observed'
    ? 'market:trade:observed' : 'market:trade:finalized';
  return normalizeMarketTradeFinalityEvent({
    ...payload,
    protocolVersion: PROTOCOL_VERSION,
    type,
    finality,
    asOfBlock: payload?.blockNumber,
    asOfBlockHash: payload?.blockHash,
    observedAt: payload?.observedAt
      || payload?.latency?.receiptsAvailableAt
      || payload?.blockTime,
  });
}

module.exports = {
  PROTOCOL_VERSION,
  buildMarketTradeFinalityEvent,
  normalizeMarketTradeFinalityEvent,
};
