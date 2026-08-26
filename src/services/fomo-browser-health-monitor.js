'use strict';

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function createFomoBrowserHealthMonitor(options = {}) {
  const enabled = options.enabled === true;
  const staleMs = positiveInteger(options.staleMs, 90_000);
  const notifier = options.notifier;
  const now = options.now || Date.now;
  const schedule = options.schedule || setTimeout;
  const cancelSchedule = options.cancelSchedule || clearTimeout;
  let running = false;
  let connected = false;
  let staleTimer = null;
  let notificationWork = Promise.resolve();
  let incident = null;
  const status = {
    enabled, running: false, connected: false, healthy: null,
    incidentKind: null, incidentAt: null, lastErrorCode: null,
    lastFrameAt: null, lastAlertAt: null, lastRecoveryAt: null,
    notificationErrors: 0, lastNotificationErrorCode: null,
  };

  function timestamp() {
    return new Date(now()).toISOString();
  }

  function queueNotification(task) {
    notificationWork = notificationWork.then(task).catch((error) => {
      status.notificationErrors += 1;
      status.lastNotificationErrorCode = String(error?.code || 'FOMO_HEALTH_ALERT_ERROR');
    });
  }

  function clearStaleTimer() {
    if (staleTimer) cancelSchedule(staleTimer);
    staleTimer = null;
  }

  function reportIncident(kind, code) {
    if (!running || !enabled || incident) return;
    incident = { kind, code: String(code || 'FOMO_BROWSER_UNHEALTHY'), at: timestamp() };
    status.healthy = false;
    status.incidentKind = incident.kind;
    status.incidentAt = incident.at;
    status.lastErrorCode = incident.code;
    const reported = incident;
    queueNotification(async () => {
      await notifier.sendStreamIncident(reported);
      status.lastAlertAt = timestamp();
    });
  }

  function armStaleTimer() {
    clearStaleTimer();
    if (!running || !enabled || !connected) return;
    staleTimer = schedule(() => {
      staleTimer = null;
      reportIncident('stale', 'FOMO_BROWSER_STREAM_STALE');
    }, staleMs);
  }

  function reportRecovery() {
    if (!incident) return;
    const recovered = incident;
    incident = null;
    status.healthy = true;
    status.incidentKind = null;
    status.incidentAt = null;
    status.lastErrorCode = null;
    status.lastRecoveryAt = timestamp();
    queueNotification(() => notifier.sendStreamRecovery({
      recoveredKind: recovered.kind,
      recoveredCode: recovered.code,
      recoveredAt: status.lastRecoveryAt,
    }));
  }

  return {
    start() {
      if (running || !enabled) return;
      running = true;
      status.running = true;
    },
    onStatus(event = {}) {
      if (!running) return;
      if (event.state === 'connected') {
        connected = true;
        status.connected = true;
        if (!incident) status.healthy = true;
        armStaleTimer();
      } else if (event.state === 'closed' || event.state === 'reconnecting') {
        connected = false;
        status.connected = false;
        clearStaleTimer();
        reportIncident('disconnected', 'FOMO_BROWSER_DISCONNECTED');
      }
    },
    onError(error) {
      reportIncident('transport', error?.code || 'FOMO_BROWSER_TRANSPORT');
    },
    onFrame(event = {}) {
      if (!running) return;
      connected = true;
      status.connected = true;
      status.lastFrameAt = event.at || timestamp();
      armStaleTimer();
      reportRecovery();
    },
    async stop() {
      running = false;
      connected = false;
      status.running = false;
      status.connected = false;
      clearStaleTimer();
      await notificationWork;
    },
    flush: async () => { await notificationWork; },
    getStatus: () => ({ ...status }),
  };
}

module.exports = { createFomoBrowserHealthMonitor };
