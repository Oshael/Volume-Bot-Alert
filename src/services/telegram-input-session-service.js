const inputSessionModel = require('../models/telegram-input-session');
const { normalizeTelegramId } = require('./telegram-link-service');
const {
  RULE_CONTRACTS,
  settingFieldSpec,
  validateRuleSettings,
} = require('./telegram-alert-rule-contracts');
const { createTelegramSettingsReader } = require('./telegram-settings-reader');
const {
  TelegramSettingsConflictError,
  createTelegramSettingsService,
} = require('./telegram-settings-service');
const {
  DEFAULT_LANGUAGE_CODE,
  normalizeTelegramLanguageCode,
} = require('../utils/telegram-locale');
const { createTelegramTranslator } = require('./telegram-i18n');

const INPUT_SESSION_TTL_MS = 10 * 60 * 1000;
const EDIT_RULE_SETTING = 'edit_rule_setting';
const FIELD_LABELS = Object.freeze({
  thresholdPct: ['field.thresholdPct', '%'],
  cooldownMinutes: ['field.cooldownMinutes', 'min'],
  minVolumeUsd: ['field.minVolumeUsd', 'USD'],
  minHvncVolumeUsd: ['field.minHvncVolumeUsd', 'USD'],
  minMarketCapUsd: ['field.minMarketCapUsd', 'USD'],
  maxMarketCapUsd: ['field.maxMarketCapUsd', 'USD'],
  minFdvUsd: ['field.minFdvUsd', 'USD'],
  maxFdvUsd: ['field.maxFdvUsd', 'USD'],
});

class TelegramInputValueError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TelegramInputValueError';
    this.code = 'telegram_input_value_invalid';
  }
}

function requireUserId(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError('Telegram input session requires a positive user id');
  }
  return value;
}

function requireTelegramUserId(value) {
  const normalized = normalizeTelegramId(value);
  if (!normalized) {
    throw new TypeError('Telegram input session requires a valid Telegram user id');
  }
  return normalized;
}

function requireEditPayload(input) {
  const contract = RULE_CONTRACTS[input?.chain]?.[input?.ruleKey];
  if (!contract || input.field === 'defaultsVersion' || !contract.fields.includes(input.field)) {
    throw new TypeError('Unsupported Telegram rule setting field');
  }
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new TypeError('Telegram input session requires a positive rule version');
  }
  return {
    chain: input.chain,
    ruleKey: input.ruleKey,
    field: input.field,
    expectedVersion: input.expectedVersion,
    languageCode: normalizeTelegramLanguageCode(input.languageCode)
      || DEFAULT_LANGUAGE_CODE,
  };
}

function inputInstructions(payload, currentValue, invalid = false) {
  const spec = settingFieldSpec(payload.chain, payload.ruleKey, payload.field);
  const { t } = createTelegramTranslator(payload.languageCode);
  const [labelKey, unit] = FIELD_LABELS[payload.field];
  return t('input.instructions', {
    prefix: invalid ? t('input.invalidPrefix') : '',
    label: t(labelKey),
    integer: spec.integer ? t('input.integer') : '',
    min: spec.min,
    max: spec.max,
    unit,
    current: currentValue,
  });
}

function parseInputValue(text, payload, currentValue) {
  const normalized = String(text || '').trim();
  if (!/^[+-]?(?:\d+(?:[.,]\d+)?|[.,]\d+)$/.test(normalized)) {
    throw new TelegramInputValueError(inputInstructions(payload, currentValue, true));
  }
  const value = Number(normalized.replace(',', '.'));
  const spec = settingFieldSpec(payload.chain, payload.ruleKey, payload.field);
  if (!Number.isFinite(value) || value < spec.min || value > spec.max
    || (spec.integer && !Number.isInteger(value))) {
    throw new TelegramInputValueError(inputInstructions(payload, currentValue, true));
  }
  return value;
}

function conflictFor(route) {
  const error = new TelegramSettingsConflictError();
  error.route = route;
  return error;
}

function createTelegramInputSessionService(options = {}) {
  const sessions = options.inputSessionModel || inputSessionModel;
  const reader = options.settingsReader || createTelegramSettingsReader();
  const mutations = options.settingsService || createTelegramSettingsService();
  const now = options.now || (() => new Date());
  const ttlMs = options.ttlMs || INPUT_SESSION_TTL_MS;

  async function start(input) {
    const telegramUserId = requireTelegramUserId(input.telegramUserId);
    const userId = requireUserId(input.userId);
    const payload = requireEditPayload(input);
    const context = await reader.read(userId, {
      kind: 'rule', chain: payload.chain, ruleKey: payload.ruleKey,
    });
    const route = { kind: 'rule', chain: payload.chain, ruleKey: payload.ruleKey };
    if (!context.rule || context.rule.version !== payload.expectedVersion) throw conflictFor(route);
    await sessions.replace({
      telegramUserId,
      userId,
      action: EDIT_RULE_SETTING,
      payload,
      expiresAt: new Date(now().getTime() + ttlMs),
    });
    return {
      text: inputInstructions(payload, context.rule.settings_json[payload.field]),
      route,
    };
  }

  async function find(input) {
    const telegramUserId = requireTelegramUserId(input.telegramUserId);
    const userId = requireUserId(input.userId);
    const session = await sessions.findActive({ telegramUserId, userId });
    if (!session) return null;
    if (session.action !== EDIT_RULE_SETTING) return null;
    return { ...session, payload: requireEditPayload(session.payload_json) };
  }

  function cancel(input) {
    return sessions.clear({
      telegramUserId: requireTelegramUserId(input.telegramUserId),
      userId: requireUserId(input.userId),
    });
  }

  async function submit(input) {
    const session = await find(input);
    if (!session) return null;
    const payload = session.payload;
    const route = { kind: 'rule', chain: payload.chain, ruleKey: payload.ruleKey };
    const context = await reader.read(input.userId, route);
    if (!context.rule || context.rule.version !== payload.expectedVersion) {
      await cancel(input);
      throw conflictFor(route);
    }
    const currentValue = context.rule.settings_json[payload.field];
    const value = parseInputValue(input.text, payload, currentValue);
    try {
      validateRuleSettings(payload.chain, payload.ruleKey, {
        ...context.rule.settings_json,
        [payload.field]: value,
      });
    } catch (error) {
      if (error instanceof TypeError) {
        throw new TelegramInputValueError(inputInstructions(payload, currentValue, true));
      }
      throw error;
    }
    try {
      await mutations.apply(input.userId, {
        kind: 'set-rule-field',
        ...payload,
        version: payload.expectedVersion,
        value,
      });
    } catch (error) {
      if (error instanceof TelegramSettingsConflictError) {
        await cancel(input);
        error.route = route;
      }
      throw error;
    }
    await cancel(input);
    return { route };
  }

  return { cancel, find, start, submit };
}

module.exports = {
  EDIT_RULE_SETTING,
  INPUT_SESSION_TTL_MS,
  TelegramInputValueError,
  createTelegramInputSessionService,
  parseInputValue,
};
