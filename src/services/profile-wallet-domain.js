'use strict';

const { createHash } = require('node:crypto');
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
    xUsername: text(input.xUsername),
    displayName: text(input.displayName),
    profilePictureUrl: text(input.profilePictureUrl),
    observedAt: text(input.observedAt) || new Date().toISOString(),
    source: text(input.source),
    wallets: (Array.isArray(input.wallets) ? input.wallets : [])
      .filter((wallet) => text(wallet?.address))
      .map(resolveWalletObservation),
  };
}

function createProfileObservationEnvelope(observation, options = {}) {
  if (!observation?.platform || !observation.platformUserId) throw new TypeError('Valid profile observation is required');
  const capturedAt = text(options.capturedAt) || observation.observedAt || new Date().toISOString();
  const wallets = Array.isArray(observation.wallets) ? observation.wallets : [];
  const fingerprint = createHash('sha256').update(JSON.stringify([
    observation.platform, observation.platformUserId, observation.source, observation.observedAt,
    wallets.map((wallet) => [wallet.addressOriginal, wallet.rawChainId, wallet.sourceType, wallet.sourceRecordId]),
  ])).digest('hex');
  return {
    spoolVersion: 1,
    platform: observation.platform,
    stream: text(options.stream) || 'profile_observations',
    capturedAt,
    sequence: Number.isSafeInteger(options.sequence) ? options.sequence : Date.now(),
    dedupeKey: `${observation.platform}:profile_observation:sha256:${fingerprint}`,
    payload: observation,
  };
}

function walletObservationKey(observation, wallet) {
  if (!observation?.platform || !observation.platformUserId || !wallet?.addressOriginal) {
    throw new TypeError('Wallet observation key requires profile and wallet identity');
  }
  const fingerprint = createHash('sha256').update(JSON.stringify([
    observation.platform, observation.platformUserId,
    wallet.chainKey, wallet.rawChainId, wallet.address || wallet.addressOriginal,
    wallet.relationType, wallet.sourceType, wallet.sourceField, wallet.sourceRecordId,
  ])).digest('hex');
  return `${observation.platform}:wallet_observation:sha256:${fingerprint}`;
}

module.exports = {
  createProfileObservation, createProfileObservationEnvelope, resolveWalletObservation,
  walletObservationKey,
};
