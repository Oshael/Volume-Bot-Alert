const backendAlertFeed = require('./backend-alert-feed');
const backendAlertRealtime = require('./backend-alert-realtime');

async function publishEvent(eventRow) {
  const payload = await backendAlertFeed.buildDashboardAlertEventFromEvent(eventRow);
  let notified = false;

  if (backendAlertRealtime.canPublishEvent(eventRow)) {
    await backendAlertRealtime.publishEventCreated(eventRow);
    notified = true;
  }

  return {
    payload,
    delivered: false,
    notified,
  };
}

async function publishEventSafe(eventRow, options = {}) {
  try {
    return await publishEvent(eventRow);
  } catch (error) {
    if (options.logLabel) {
      console.error(`[${options.logLabel}] Failed to publish alert event ${eventRow?.id || 'unknown'}:`, error.message);
    }

    return {
      payload: null,
      delivered: false,
      notified: false,
      error,
    };
  }
}

module.exports = {
  publishEvent,
  publishEventSafe,
};
