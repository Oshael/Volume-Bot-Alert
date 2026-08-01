const userAccess = require('../models/user-access');
const {
  createTelegramAlertAccessStateRepository,
} = require('../models/telegram-alert-access-state');

function denial(code, message) {
  return Object.freeze({ allowed: false, code, message });
}

function requireContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Telegram delivery access context is required');
  }
  return value;
}

function requireParts(value) {
  const context = requireContext(value);
  const { connection, profile, user } = context;
  if (!connection || !profile || !user) {
    throw new TypeError('Telegram delivery access context is incomplete');
  }
  return { context, connection, profile, user };
}

function destinationDenial(connection, profile) {
  if (connection.status === 'disconnected') {
    return denial('telegram_disconnected', 'Telegram connection is disconnected');
  }
  if (profile.enabled !== true) {
    return denial('telegram_profile_disabled', 'Telegram alert profile is disabled');
  }
  if (connection.status === 'paused') {
    return denial('telegram_paused', 'Telegram alert delivery is paused');
  }
  return null;
}

function checkTime(value) {
  const now = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(now.getTime())) {
    throw new TypeError('Telegram access check time is invalid');
  }
  return now;
}

function createTelegramAlertAccessGate(options = {}) {
  const resolveAccess = options.accessResolver || userAccess.buildResolvedAccessSnapshot;
  const repository = options.repository
    || createTelegramAlertAccessStateRepository(options);
  if (typeof resolveAccess !== 'function') {
    throw new TypeError('Telegram access resolver is required');
  }
  if (typeof repository?.suspend !== 'function'
    || typeof repository.requestReactivation !== 'function') {
    throw new TypeError('Telegram access state repository is required');
  }

  async function suspend(context, result) {
    await repository.suspend({
      connectionId: context.connection.id,
      userId: context.user.id,
      errorCode: result.code,
      error: result.message,
    });
    return result;
  }

  async function authorize(input = {}) {
    const { context, connection, profile, user } = requireParts(input.context);
    const blocked = destinationDenial(connection, profile);
    if (blocked) return blocked;
    if (user.is_active !== true) {
      return suspend(context, denial('account_inactive', 'TrendScope account is inactive'));
    }

    const now = checkTime(input.now);
    const access = await resolveAccess(user, now, options.accessDeps || {});
    if (!access?.hasProductAccess) {
      return suspend(context, denial(
        access?.denialCode || 'access_denied',
        access?.denialReason || 'TrendScope access is unavailable',
      ));
    }
    if (connection.status === 'access_suspended') {
      await repository.requestReactivation({
        connectionId: connection.id,
        userId: user.id,
      });
      return denial(
        'access_reactivation_pending',
        'Telegram access reactivation is pending',
      );
    }
    if (connection.status !== 'active') {
      throw new TypeError(`Unsupported Telegram connection status: ${connection.status}`);
    }
    return Object.freeze({ allowed: true });
  }

  return Object.freeze({ authorize });
}

module.exports = {
  createTelegramAlertAccessGate,
};
