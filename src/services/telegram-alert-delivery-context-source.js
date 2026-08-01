const {
  createTelegramAlertDeliveryContextRepository,
} = require('../models/telegram-alert-delivery-context');
const {
  isSparklineGranularityMinutes,
} = require('../utils/market-bucket-granularities');
const {
  DEFAULT_LANGUAGE_CODE,
  normalizeTelegramLanguageCode,
} = require('../utils/telegram-locale');

const CONNECTION_STATUSES = new Set([
  'active', 'paused', 'access_suspended', 'disconnected',
]);

function positiveId(value, field) {
  try {
    const parsed = BigInt(String(value ?? '').trim());
    if (parsed > 0n) return parsed.toString();
  } catch (_) {}
  throw new TypeError(`${field} must be a positive integer`);
}

function boolean(value, field) {
  if (typeof value !== 'boolean') throw new TypeError(`${field} must be boolean`);
  return value;
}

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} is required`);
  }
  return value;
}

function normalizePolicy(options) {
  const hours = Number(options.sparklineHours);
  const granularityMinutes = Number(options.sparklineGranularityMinutes);
  if (!Number.isSafeInteger(hours) || hours < 1 || hours > 720) {
    throw new TypeError('Telegram delivery sparkline hours must be an integer between 1 and 720');
  }
  if (!isSparklineGranularityMinutes(granularityMinutes)) {
    throw new TypeError('Telegram delivery sparkline granularity is unsupported');
  }
  return Object.freeze({ hours, granularityMinutes });
}

function normalizeDelivery(delivery) {
  if (!delivery || typeof delivery !== 'object' || Array.isArray(delivery)) {
    throw new TypeError('Telegram claimed delivery is required');
  }
  const chain = String(delivery.chain || '').trim();
  if (!['solana', 'robinhood'].includes(chain)) {
    throw new TypeError(`Unsupported Telegram delivery chain: ${chain || 'missing'}`);
  }
  return {
    id: positiveId(delivery.id, 'Telegram delivery id'),
    connectionId: positiveId(delivery.connectionId, 'Telegram delivery connection id'),
    profileId: positiveId(delivery.profileId, 'Telegram delivery profile id'),
    chain,
  };
}

function requireContextIdentity(delivery, context) {
  const claim = object(context?.claim, 'Telegram delivery claim context');
  const connection = object(context?.connection, 'Telegram delivery connection context');
  const profile = object(context?.profile, 'Telegram delivery profile context');
  const user = object(context?.user, 'Telegram delivery user context');
  const userId = Number(user.id);
  const identities = [
    [claim.deliveryId, delivery.id],
    [claim.connectionId, delivery.connectionId],
    [claim.profileId, delivery.profileId],
    [claim.chain, delivery.chain],
    [connection.id, delivery.connectionId],
    [profile.id, delivery.profileId],
    [profile.connectionId, delivery.connectionId],
    [profile.chain, delivery.chain],
    [connection.userId, userId],
    [profile.userId, userId],
  ];
  const identityMatches = identities.every(([actual, expected]) => actual === expected);
  const validUserId = Number.isSafeInteger(userId) && userId > 0;
  if (!identityMatches || !validUserId) {
    throw new TypeError('Telegram delivery context identity mismatch');
  }
}

function normalizeContext(delivery, context, policy) {
  requireContextIdentity(delivery, context);
  const status = String(context.connection.status || '').trim();
  if (!CONNECTION_STATUSES.has(status)) {
    throw new TypeError('Telegram delivery connection status is unsupported');
  }
  const profileEnabled = boolean(context.profile.enabled, 'Telegram delivery profile enabled');
  const sparklineEnabled = boolean(
    context.profile.sparklineEnabled,
    'Telegram delivery sparkline enabled',
  );
  return Object.freeze({
    connection: Object.freeze({ ...context.connection, status }),
    profile: Object.freeze({ ...context.profile, enabled: profileEnabled, sparklineEnabled }),
    user: Object.freeze({ ...context.user }),
    senderInput: Object.freeze({
      chatId: positiveId(context.connection.chatId, 'Telegram delivery chat id'),
      languageCode: normalizeTelegramLanguageCode(context.connection.languageCode)
        || DEFAULT_LANGUAGE_CODE,
      sparklineEnabled,
      sparklineHours: sparklineEnabled ? policy.hours : null,
      sparklineGranularityMinutes: sparklineEnabled ? policy.granularityMinutes : null,
    }),
  });
}

function createTelegramAlertDeliveryContextSource(options = {}) {
  const repository = options.repository
    || createTelegramAlertDeliveryContextRepository(options);
  const policy = normalizePolicy(options);
  if (typeof repository?.loadClaim !== 'function') {
    throw new TypeError('Telegram delivery context repository is required');
  }

  async function load(input = {}) {
    const delivery = normalizeDelivery(input.delivery);
    const context = await repository.loadClaim({ id: delivery.id, owner: input.owner });
    return context ? normalizeContext(delivery, context, policy) : null;
  }

  return Object.freeze({ load });
}

module.exports = {
  createTelegramAlertDeliveryContextSource,
};
