'use strict';

const { createHash } = require('node:crypto');
const { normalizeTokenAddress } = require('../utils/token-identity');

const CHAIN_IDS = new Map([
  ['sol', 'solana'], ['solana', 'solana'], ['1399811149', 'solana'],
  ['eth', 'ethereum'], ['ethereum', 'ethereum'], ['1', 'ethereum'],
  ['bsc', 'bsc'], ['bnb', 'bsc'], ['56', 'bsc'],
  ['base', 'base'], ['8453', 'base'],
  ['robinhood', 'robinhood'], ['4663', 'robinhood'],
]);
const EVM_CHAINS = new Set(['ethereum', 'bsc', 'base', 'robinhood']);

function text(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function resolveCalloutAddress(rawChainId, rawAddress) {
  const chainId = text(rawChainId);
  const addressOriginal = text(rawAddress);
  const chainKey = chainId ? CHAIN_IDS.get(chainId.toLowerCase()) || null : null;
  const base = {
    addressOriginal,
    address: null,
    rawChainId: chainId,
    chainKey,
    chainFamily: chainKey ? (EVM_CHAINS.has(chainKey) ? 'evm' : 'solana') : null,
    resolutionStatus: chainKey ? 'resolved' : (chainId ? 'unsupported_chain' : 'unknown_chain'),
  };
  if (!addressOriginal) return { ...base, resolutionStatus: 'invalid_address' };
  if (!chainKey) return base;
  try {
    return { ...base, address: normalizeTokenAddress(chainKey, addressOriginal) };
  } catch (_error) {
    return { ...base, resolutionStatus: 'invalid_address' };
  }
}

function commonCalloutFromPump(activity = {}) {
  if (activity.eventKind !== 'callout' && !text(activity.thesis)) return null;
  return {
    schemaVersion: 1,
    platform: 'pump',
    platformEventId: text(activity.sourceEventId),
    eventKind: 'callout',
    occurredAt: text(activity.sourceCreatedAt),
    profile: {
      platformUserId: text(activity.platformUserId),
      username: text(activity.username),
      xUsername: text(activity.xUsername),
      displayName: null,
      profilePictureUrl: text(activity.profilePictureUrl),
    },
    wallet: activity.walletAddress
      ? resolveCalloutAddress(activity.rawChainId, activity.walletAddress) : null,
    asset: resolveCalloutAddress(activity.rawChainId, activity.tokenAddress),
    thesis: text(activity.thesis),
    marketCap: Number.isFinite(activity.marketCap) ? activity.marketCap : null,
    sourceMetadata: {
      side: text(activity.side),
      amount: Number.isFinite(activity.amount) ? activity.amount : null,
      amountUsd: Number.isFinite(activity.amountUsd) ? activity.amountUsd : null,
      calloutPrice: Number.isFinite(activity.calloutPrice) ? activity.calloutPrice : null,
    },
  };
}

function fomoSourceMetadata(callout) {
  const metadata = {
    tradeId: text(callout.tradeId),
    ticker: text(callout.asset?.ticker),
    threshold: callout.platformMetrics?.threshold ?? null,
    equity: callout.platformMetrics?.equity ?? null,
  };
  if (Array.isArray(callout.thesis?.links) && callout.thesis.links.length) {
    metadata.sourceLinks = callout.thesis.links;
  }
  return metadata;
}

function commonCalloutFromFomo(callout = {}) {
  if (!callout || callout.eventType !== 'callout') return null;
  return {
    schemaVersion: 1,
    platform: 'fomo',
    platformEventId: text(callout.platformEventId),
    eventKind: 'callout',
    occurredAt: text(callout.occurredAt),
    profile: {
      platformUserId: text(callout.profile?.platformUserId),
      username: text(callout.profile?.handle),
      xUsername: null,
      displayName: text(callout.profile?.displayName),
      profilePictureUrl: text(callout.profile?.profilePictureUrl),
    },
    wallet: null,
    asset: resolveCalloutAddress(callout.asset?.rawNetworkId, callout.asset?.address),
    thesis: text(callout.thesis?.text),
    marketCap: null,
    sourceMetadata: fomoSourceMetadata(callout),
  };
}

function fallbackDedupeFields(callout = {}) {
  const profile = callout.profile || {};
  const asset = callout.asset || {};
  return [
    callout.platform, profile.platformUserId || profile.username,
    asset.chainKey || asset.rawChainId,
    asset.address || asset.addressOriginal,
    callout.occurredAt, callout.thesis,
  ];
}

function calloutDedupeKey(callout) {
  const eventId = text(callout?.platformEventId);
  if (eventId) return `${callout.platform}:callout:id:${eventId}`;
  const hash = createHash('sha256').update(JSON.stringify(fallbackDedupeFields(callout))).digest('hex');
  return `${callout?.platform}:callout:sha256:${hash}`;
}

function createCalloutEnvelope(callout, options = {}) {
  if (!callout?.platform || callout.eventKind !== 'callout') throw new TypeError('Valid common callout is required');
  return {
    spoolVersion: 1,
    platform: callout.platform,
    stream: text(options.stream) || 'callouts',
    capturedAt: text(options.capturedAt) || new Date().toISOString(),
    sequence: Number.isSafeInteger(options.sequence) ? options.sequence : Date.now(),
    dedupeKey: calloutDedupeKey(callout),
    payload: callout,
  };
}

module.exports = {
  calloutDedupeKey,
  commonCalloutFromFomo,
  commonCalloutFromPump,
  createCalloutEnvelope,
  resolveCalloutAddress,
};
