'use strict';

const { normalizeFomoLeaderboardProfile } = require('./fomo-identity-normalizer');
const {
  createProfileObservationEnvelope, walletObservationKey,
} = require('./profile-wallet-domain');

const CHECKPOINT_KEY = 'fomo:profile-discovery';

function createFomoProfileDiscoveryPersistence(options = {}) {
  const repository = options.repository;
  const now = options.now || Date.now;
  if (!repository?.commitCapture) throw new TypeError('Fomo profile discovery requires a repository');

  async function persist(entries = []) {
    const leaderboardEntries = Array.isArray(entries) ? entries : [];
    const observedAt = new Date(now()).toISOString();
    const profileEnvelopes = leaderboardEntries.flatMap((entry, sequence) => {
      const observation = normalizeFomoLeaderboardProfile(entry?.profile, {
        observedAt, source: `leaderboard:${entry?.timeframe || 'unknown'}`,
      });
      return observation ? [createProfileObservationEnvelope(observation, {
        capturedAt: observedAt, stream: 'fomo_profile_discovery', sequence,
      })] : [];
    });
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
      },
      committedAt: observedAt,
    });
    return result;
  }

  return Object.freeze({ persist });
}

module.exports = { CHECKPOINT_KEY, createFomoProfileDiscoveryPersistence };
