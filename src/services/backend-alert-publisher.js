const backendAlertFeed = require('./backend-alert-feed');
const socketHub = require('./socket-hub');

async function publishEvent(eventRow) {
  const payload = await backendAlertFeed.buildDashboardAlertEventFromEvent(eventRow);
  const delivered = socketHub.emitBackendAlertEvent(payload, {
    userId: eventRow?.userId ?? null,
  });

  return {
    payload,
    delivered: Boolean(delivered),
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
      error,
    };
  }
}

module.exports = {
  publishEvent,
  publishEventSafe,
};
