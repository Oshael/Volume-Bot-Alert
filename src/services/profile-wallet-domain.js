'use strict';

const { resolveCalloutAddress } = require('./callout-domain');

const EVM_ADDRESS = /^0x[0-9a-f]{40}$/i;

function text(value) {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function resolveWalletObservation(input = {}) {
  const addressOriginal = text(input.address);
  const rawChainId = text(input.rawChainId);
  const familyHint = text(input.chainFamilyHint)?.toLowerCase() || null;
  let identity;
  if (rawChainId) {
    identity = resolveCalloutAddress(rawChainId, addressOriginal);
  } else if (familyHint === 'evm') {
    identity = {
      addressOriginal,
      address: addressOriginal && EVM_ADDRESS.test(addressOriginal) ? addressOriginal.toLowerCase() : null,
      rawChainId: null,
      chainKey: null,
      chainFamily: 'evm',
      resolutionStatus: addressOriginal && EVM_ADDRESS.test(addressOriginal) ? 'unknown_chain' : 'invalid_address',
    };
  } else if (familyHint === 'solana') {
    identity = resolveCalloutAddress('solana', addressOriginal);
  } else {
    identity = {
      addressOriginal,
      address: null,
      rawChainId: null,
      chainKey: null,
      chainFamily: null,
      resolutionStatus: addressOriginal ? 'unknown_chain' : 'invalid_address',
    };
  }
  return {
    ...identity,
    relationType: text(input.relationType),
    sourceType: text(input.sourceType),
    sourceField: text(input.sourceField),
    sourceRecordId: text(input.sourceRecordId),
    confidence: text(input.confidence),
    evidenceAt: text(input.evidenceAt),
  };
}

function createProfileObservation(input = {}) {
  const platform = text(input.platform);
  const platformUserId = text(input.platformUserId);
  if (!platform || !platformUserId) throw new TypeError('Profile observation requires platform and platform user ID');
  return {
    schemaVersion: 1,
    platform,
    platformUserId,
    username: text(input.username),
    displayName: text(input.displayName),
    profilePictureUrl: text(input.profilePictureUrl),
    observedAt: text(input.observedAt) || new Date().toISOString(),
    source: text(input.source),
    wallets: (Array.isArray(input.wallets) ? input.wallets : [])
      .filter((wallet) => text(wallet?.address))
      .map(resolveWalletObservation),
  };
}

module.exports = { createProfileObservation, resolveWalletObservation };
