const connectionModel = require('../models/telegram-connection');
const profileModel = require('../models/telegram-alert-profile');
const ruleSettingModel = require('../models/telegram-alert-rule-setting');
const { buildDefaultRules } = require('./telegram-alert-rule-contracts');

class TelegramSettingsConflictError extends Error {
  constructor() {
    super('Telegram settings changed; reload the menu');
    this.name = 'TelegramSettingsConflictError';
    this.code = 'telegram_settings_conflict';
  }
}

function createTelegramSettingsService(options = {}) {
  const connections = options.connectionModel || connectionModel;
  const profiles = options.profileModel || profileModel;
  const rules = options.ruleSettingModel || ruleSettingModel;

  async function updateConnection(userId, route) {
    const connection = await connections.findActiveByUserId(userId);
    if (!['active', 'paused'].includes(connection?.status)) {
      throw new TelegramSettingsConflictError();
    }
    const status = route.kind === 'set-connection-status'
      ? route.status
      : connection.status === 'active' ? 'paused' : 'active';
    if (!['active', 'paused'].includes(status)) {
      throw new TypeError('Unsupported Telegram delivery status');
    }
    const updated = await connections.setDeliveryStatus({
      userId,
      status,
      expectedVersion: route.version,
    });
    if (!updated) throw new TelegramSettingsConflictError();
    return updated;
  }

  async function requireProfile(userId, chain) {
    const profile = await profiles.findByUserAndChain(userId, chain);
    if (!profile) throw new TelegramSettingsConflictError();
    return profile;
  }

  async function updateProfile(userId, route) {
    const profile = await requireProfile(userId, route.chain);
    const input = {
      userId,
      chain: route.chain,
      expectedVersion: route.version,
    };
    if (route.kind === 'toggle-profile') input.enabled = !profile.enabled;
    else input.sparklineEnabled = !profile.sparkline_enabled;
    const updated = await profiles.updatePreferences(input);
    if (!updated) throw new TelegramSettingsConflictError();
    return updated;
  }

  async function updateRule(userId, route) {
    const profile = await requireProfile(userId, route.chain);
    const rule = await rules.findByProfileAndRule(profile.id, route.ruleKey);
    if (!rule) throw new TelegramSettingsConflictError();
    let enabled = rule.enabled;
    let settings = rule.settings_json;
    if (route.kind === 'toggle-rule') {
      enabled = !enabled;
    } else if (route.kind === 'reset-rule') {
      const defaults = buildDefaultRules(route.chain).find(
        (item) => item.ruleKey === route.ruleKey
      );
      enabled = defaults.enabled;
      settings = defaults.settings;
    } else {
      settings = { ...settings, [route.field]: route.value };
    }
    const updated = await rules.update({
      profileId: profile.id,
      chain: route.chain,
      ruleKey: route.ruleKey,
      enabled,
      settings,
      expectedVersion: route.version,
    });
    if (!updated) throw new TelegramSettingsConflictError();
    return updated;
  }

  async function apply(userId, route) {
    if (route.kind === 'toggle-connection' || route.kind === 'set-connection-status') {
      return updateConnection(userId, route);
    }
    if (route.kind === 'toggle-profile' || route.kind === 'toggle-sparkline') {
      return updateProfile(userId, route);
    }
    if ([
      'toggle-rule', 'reset-rule', 'set-rule-field',
    ].includes(route.kind)) {
      return updateRule(userId, route);
    }
    throw new TypeError('Unsupported Telegram settings mutation');
  }

  return { apply };
}

module.exports = {
  TelegramSettingsConflictError,
  createTelegramSettingsService,
};
