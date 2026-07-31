const stateModel = require('../models/telegram-alert-rule-state');
const {
  adaptTelegramAlertEvaluationProfile,
} = require('./telegram-alert-evaluation-profile');
const {
  createTelegramAlertPlanCommitter,
} = require('./telegram-alert-plan-committer');

function emptySummary() {
  return {
    evaluated: 0,
    committed: 0,
    duplicate: 0,
    deliveries: 0,
    errors: 0,
  };
}

function createTelegramSolanaAlertDestination(options = {}) {
  const enabled = options.enabled === true;
  const profiles = options.profileSource;
  if (!profiles || typeof profiles.listEligible !== 'function') {
    throw new TypeError('Telegram eligible profile source is required');
  }
  const states = options.stateModel || stateModel;
  const adaptProfile = options.adaptProfile || adaptTelegramAlertEvaluationProfile;
  const planner = options.planner;
  if (enabled && (!planner || typeof planner.plan !== 'function')) {
    throw new TypeError('Telegram Solana alert planner is required');
  }
  const committer = options.committer || createTelegramAlertPlanCommitter();

  async function report(error, phase, profile) {
    if (typeof options.onProfileError !== 'function') return;
    try {
      await options.onProfileError({ error, phase, profile });
    } catch (_) {}
  }

  async function listSignalProfiles(context = {}) {
    if (!enabled) return [];
    const candidates = await profiles.listEligible({
      chain: 'solana',
      nowMs: context.nowMs,
    });
    if (!Array.isArray(candidates)) {
      throw new TypeError('Telegram eligible profiles must be an array');
    }
    const result = [];
    for (const candidate of candidates) {
      try {
        const profile = adaptProfile(candidate);
        if (profile.enabled && profile.chain === 'solana') result.push(profile);
      } catch (error) {
        await report(error, 'profile-adaptation', candidate?.profile || null);
      }
    }
    return result;
  }

  async function evaluate(input = {}) {
    const summary = emptySummary();
    if (!enabled) return Object.freeze(summary);
    if (!Array.isArray(input.profiles)) {
      throw new TypeError('Telegram Solana destination profiles must be an array');
    }
    for (const profile of input.profiles) {
      summary.evaluated += 1;
      try {
        const stateRows = await states.listByProfileAndToken({
          profileId: profile.profileId,
          chain: profile.chain,
          tokenAddress: input.tokenAfter?.address,
          ruleKeys: profile.rules.map((rule) => rule.ruleKey),
        });
        const plan = await planner.plan({
          profile,
          states: stateRows,
          tokenAfter: input.tokenAfter,
          signals: input.signals,
          nowMs: input.nowMs,
        });
        const committed = await committer.commit(plan);
        summary.committed += 1;
        summary.deliveries += committed.deliveries.length;
        if (committed.duplicate) summary.duplicate += 1;
      } catch (error) {
        summary.errors += 1;
        await report(error, 'profile-evaluation', profile);
      }
    }
    return Object.freeze(summary);
  }

  return Object.freeze({ evaluate, listSignalProfiles });
}

module.exports = {
  createTelegramSolanaAlertDestination,
};
