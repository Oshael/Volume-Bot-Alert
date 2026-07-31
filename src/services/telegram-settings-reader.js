const profileModel = require('../models/telegram-alert-profile');
const ruleSettingModel = require('../models/telegram-alert-rule-setting');

function createTelegramSettingsReader(options = {}) {
  const profiles = options.profileModel || profileModel;
  const rules = options.ruleSettingModel || ruleSettingModel;

  async function findProfile(userId, chain) {
    return profiles.findByUserAndChain(userId, chain);
  }

  async function read(userId, route) {
    if (route.kind === 'main') {
      return {
        profiles: (await Promise.all([
          findProfile(userId, 'solana'),
          findProfile(userId, 'robinhood'),
        ])).filter(Boolean),
      };
    }
    if (['alerts', 'status', 'help', 'confirm-disconnect'].includes(route.kind)) return {};
    const profile = await findProfile(userId, route.chain);
    if (!profile) return { profile: null, rules: [], rule: null };
    if (route.kind === 'chain') {
      return { profile, rules: await rules.listByProfileId(profile.id) };
    }
    return {
      profile,
      rule: await rules.findByProfileAndRule(profile.id, route.ruleKey),
    };
  }

  return { read };
}

module.exports = { createTelegramSettingsReader };
