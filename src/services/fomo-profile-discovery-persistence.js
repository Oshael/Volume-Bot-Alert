'use strict';

const {
  normalizeFomoActivityProfile, normalizeFomoLeaderboardProfile, normalizeFomoTradeIdentity,
} = require('./fomo-identity-normalizer');
const {
  createProfileObservationEnvelope, walletObservationKey,
} = require('./profile-wallet-domain');

const CHECKPOINT_KEY = 'fomo:profile-discovery';

function createFomoProfileDiscoveryPersistence(options = {}) {
  const repository = options.repository;
  const now = options.now || Date.now;
  if (!repository?.commitCapture) throw new TypeError('Fomo profile discovery requires a repository');

  async function findMissingWalletProfileIds(profileIds) {
    if (!repository.findProfilesWithoutWallet) return profileIds;
    return repository.findProfilesWithoutWallet('fomo', profileIds);
  }

  async function persist(entries = [], discovery = {}) {
    const leaderboardEntries = Array.isArray(entries) ? entries : [];
    const activityItems = Array.isArray(discovery.activityItems) ? discovery.activityItems : [];
    const tradeDetails = Array.isArray(discovery.tradeDetails) ? discovery.tradeDetails : [];
    const observedAt = new Date(now()).toISOString();
    const observations = leaderboardEntries.flatMap((entry) => {
      const observation = normalizeFomoLeaderboardProfile(entry?.profile, {
        observedAt, source: `leaderboard:${entry?.timeframe || 'unknown'}`,
      });
      return observation ? [observation] : [];
    });
    observations.push(...activityItems.flatMap((item) => {
      const observation = normalizeFomoActivityProfile(item, { observedAt });
      return observation ? [observation] : [];
    }));
    observations.push(...tradeDetails.flatMap((entry) => {
      const observation = normalizeFomoTradeIdentity(entry?.body, {
        observedAt, tradeId: entry?.tradeId,
      });
      return observation ? [observation] : [];
    }));
    const profileEnvelopes = observations.map((observation, sequence) => (
      createProfileObservationEnvelope(observation, {
        capturedAt: observedAt, stream: 'fomo_profile_discovery', sequence,
      })
    ));
    const profileKeys = new Set();
    const walletKeys = new Set();
    for (const envelope of profileEnvelopes) {
      const profile = envelope.payload;
      profileKeys.add(`${profile.platform}:${profile.platformUserId}`);
      for (const wallet of profile.wallets || []) walletKeys.add(walletObservationKey(profile, wallet));
    }
    const result = {
      profiles: profileKeys.size, wallets: walletKeys.size, persistedAt: observedAt,
    };
    await repository.commitCapture({
      profileEnvelopes, calloutEnvelopes: [], checkpointKey: CHECKPOINT_KEY,
      checkpointState: {
        ...result,
        timeframes: [...new Set(leaderboardEntries.map((entry) => entry?.timeframe).filter(Boolean))],
        activityProfiles: new Set(activityItems.map((item) => item?.userId).filter(Boolean)).size,
        activityTradeIdentities: tradeDetails.length,
      },
      committedAt: observedAt,
    });
    return result;
  }

  return Object.freeze({ findMissingWalletProfileIds, persist });
}

module.exports = { CHECKPOINT_KEY, createFomoProfileDiscoveryPersistence };
