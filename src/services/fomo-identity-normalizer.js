'use strict';

const { createProfileObservation } = require('./profile-wallet-domain');

function payload(body) {
  return body?.responseObject || body || {};
}

function normalizeFomoLeaderboardProfile(item = {}, options = {}) {
  if (!item.id) return null;
  return createProfileObservation({
    platform: 'fomo',
    platformUserId: item.id,
    username: item.userHandle,
    displayName: item.displayName,
    profilePictureUrl: item.profilePictureLink,
    observedAt: options.observedAt,
    source: options.source || 'leaderboard',
    wallets: [
      {
        address: item.address,
        rawChainId: 'solana',
        relationType: 'profile_wallet',
        sourceType: 'platform_reported',
        sourceField: 'address',
        confidence: 'high',
      },
      {
        address: item.evmAddress,
        chainFamilyHint: 'evm',
        relationType: 'profile_wallet',
        sourceType: 'platform_reported',
        sourceField: 'evmAddress',
        confidence: 'high',
      },
    ],
  });
}

function normalizeFomoActivityProfile(item = {}, options = {}) {
  if (!item.userId) return null;
  return createProfileObservation({
    platform: 'fomo',
    platformUserId: item.userId,
    username: item.userHandle,
    displayName: item.displayName,
    profilePictureUrl: item.profilePictureLink,
    observedAt: options.observedAt,
    source: options.source || 'trading_activity',
  });
}

function normalizeFomoTradeIdentity(body = {}, options = {}) {
  const record = payload(body);
  const trade = record.trade || {};
  if (!record.userId || !trade.userAddress) return null;
  return createProfileObservation({
    platform: 'fomo',
    platformUserId: record.userId,
    username: record.userHandle,
    displayName: record.displayName,
    profilePictureUrl: record.profilePictureLink,
    observedAt: options.observedAt,
    source: 'trade_detail',
    wallets: [{
      address: trade.userAddress,
      rawChainId: trade.networkId,
      relationType: 'activity_wallet',
      sourceType: 'activity_used',
      sourceField: 'trade.userAddress',
      sourceRecordId: trade.id || options.tradeId,
      confidence: 'high',
      evidenceAt: trade.createdAt,
    }],
  });
}

module.exports = {
  normalizeFomoActivityProfile, normalizeFomoLeaderboardProfile, normalizeFomoTradeIdentity,
};
