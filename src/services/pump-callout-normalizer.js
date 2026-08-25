'use strict';

const REDACTED_KEYS = /^(authorization|proxy-authorization|cookie|set-cookie|auth[-_]?token|access[-_]?token|refresh[-_]?token|jwt|csrf|csrf[-_]?token|x-csrf-token|ct0|session[-_]?token)$/i;

function text(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function firstText(...values) {
  for (const value of values) {
    const normalized = text(value);
    if (normalized) return normalized;
  }
  return null;
}

function firstFinite(...values) {
  for (const value of values) {
    const normalized = finite(value);
    if (normalized !== null) return normalized;
  }
  return null;
}

function timestamp(value) {
  const raw = text(value);
  if (!raw) return null;
  const numeric = Number(raw);
  const milliseconds = Number.isFinite(numeric)
    ? (numeric < 10_000_000_000 ? numeric * 1000 : numeric)
    : Date.parse(raw);
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function sanitizePumpPayload(value) {
  if (Array.isArray(value)) return value.map(sanitizePumpPayload);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !REDACTED_KEYS.test(key))
    .map(([key, item]) => [key, sanitizePumpPayload(item)]));
}

function walletObservation(value, fallbackChainId = null) {
  const item = typeof value === 'string' ? { address: value } : (value || {});
  const address = text(item.address || item.walletAddress || item.wallet);
  if (!address) return null;
  return {
    address,
    rawChainId: text(item.chainId || item.chain || fallbackChainId),
    sourceField: item.sourceField || null,
  };
}

function normalizePumpProfile(item = {}) {
  const observations = [
    walletObservation({ address: item.primaryWallet, chainId: item.chainId, sourceField: 'primaryWallet' }),
    ...(Array.isArray(item.wallets) ? item.wallets.map((wallet) => walletObservation(wallet, item.chainId)) : []),
  ].filter(Boolean);
  const uniqueWallets = [];
  const seen = new Set();
  for (const wallet of observations) {
    const key = `${wallet.rawChainId || ''}:${wallet.address}`;
    if (!seen.has(key)) uniqueWallets.push(wallet);
    seen.add(key);
  }
  return {
    platform: 'pump',
    platformUserId: text(item.userId || item.user_uuid || item.id),
    username: text(item.userName || item.username),
    displayName: text(item.displayName || item.name),
    xUsername: text(item.xUsername),
    profilePictureUrl: text(item.profileImage || item.profilePictureUrl),
    wallets: uniqueWallets,
    rawProfileMetadata: sanitizePumpPayload(item),
  };
}

function normalizePumpActivity(item = {}) {
  const callout = item.callout || item;
  const author = item.author || {};
  const trade = item.trade || {};
  const side = firstText(trade.side, item.side);
  return {
    platform: 'pump',
    sourceEventId: firstText(item.id, callout.calloutId, trade.transactionSignature, trade.signature),
    eventKind: firstText(item.kind, callout.calloutId ? 'callout' : null),
    platformUserId: firstText(item.userId, author.userId, callout.userId),
    username: firstText(item.userName, author.userName, author.username),
    xUsername: firstText(item.xUsername, author.xUsername),
    profilePictureUrl: firstText(item.profileImage, author.profileImage),
    walletAddress: firstText(item.walletAddress, author.walletAddress, callout.walletAddress),
    rawChainId: firstText(item.chainId, callout.chainId, trade.chainId),
    tokenAddress: firstText(item.coinMint, callout.coinMint, trade.coinMint, trade.mint),
    side: side ? side.toLowerCase() : null,
    amount: firstFinite(trade.amount, item.amount),
    amountUsd: firstFinite(trade.amountUsd, item.amountUsd),
    marketCap: firstFinite(callout.calledOutAtMcap, item.marketCap),
    thesis: firstText(callout.thesis, item.thesis),
    sourceCreatedAt: timestamp(firstText(callout.calloutTimestamp, callout.createdAt, item.createdAt, item.timestamp)),
    calloutPrice: finite(callout.calloutPrice),
    multiple: firstFinite(callout.multiple, item.multiple),
    maxMultiple: firstFinite(callout.maxMultiplier, callout.maxMultiple),
    rawPayload: sanitizePumpPayload(item),
  };
}

module.exports = {
  normalizePumpActivity,
  normalizePumpProfile,
  sanitizePumpPayload,
};
