const config = require('../../config');
const {
  createTelegramEligibleProfileSource,
} = require('./telegram-eligible-profile-source');
const {
  createTelegramSolanaAlertDestination,
} = require('./telegram-solana-alert-destination');
const {
  createTelegramSolanaAlertPlanner,
} = require('./telegram-solana-alert-planner');

function logAccessError({ error, candidate }) {
  console.error(
    `[TelegramAlerts] Access resolution failed for user ${candidate?.user?.id || 'unknown'}:`,
    error.message
  );
}

function logProfileError({ error, phase, profile }) {
  console.error(
    `[TelegramAlerts] ${phase} failed for profile ${profile?.profileId || profile?.id || 'unknown'}:`,
    error.message
  );
}

function createTelegramSolanaAlertRuntime(options = {}) {
  const profileSource = options.profileSource || createTelegramEligibleProfileSource({
    ...(options.profileSourceOptions || {}),
    onAccessError: options.onAccessError || logAccessError,
  });
  const planner = options.planner || createTelegramSolanaAlertPlanner({
    evaluateProfile: options.evaluateProfile,
  });
  const destination = createTelegramSolanaAlertDestination({
    ...(options.destinationOptions || {}),
    enabled: options.enabled ?? config.telegram.enabled,
    profileSource,
    planner,
    onProfileError: options.onProfileError || logProfileError,
  });

  return Object.freeze({ destination, profileSource });
}

module.exports = {
  createTelegramSolanaAlertRuntime,
};
