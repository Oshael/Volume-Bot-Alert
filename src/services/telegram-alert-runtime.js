const { randomUUID } = require('crypto');
const os = require('os');
const config = require('../../config');
const { createTelegramBotClient } = require('./telegram-bot-client');
const { createTelegramAlertAccessGate } = require('./telegram-alert-access-gate');
const {
  createTelegramAlertDeliveryContextSource,
} = require('./telegram-alert-delivery-context-source');
const {
  createTelegramAlertDeliverySender,
} = require('./telegram-alert-delivery-sender');
const {
  createTelegramAlertDeliveryWorker,
} = require('./telegram-alert-delivery-worker');
const { createTelegramAlertFormatter } = require('./telegram-alert-formatter');
const {
  createTelegramAlertReactivationReconciler,
} = require('./telegram-alert-reactivation-reconciler');

function integer(value, fallback, min, max, field) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new TypeError(`${field} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function requirePort(value, method, message) {
  if (!value || typeof value[method] !== 'function') throw new TypeError(message);
  return value;
}

function buildOwner() {
  return `telegram:${os.hostname()}:${process.pid}:${randomUUID()}`.slice(0, 128);
}

function composeSender(options, settings) {
  if (options.sender) return options.sender;
  const bot = options.bot || createTelegramBotClient({
    settings,
    enabled: true,
    timeoutMs: settings.deliveryTimeoutMs,
  });
  const formatter = options.formatter || createTelegramAlertFormatter({
    appBaseUrl: options.appBaseUrl || settings.appBaseUrl || config.email?.appBaseUrl,
  });
  return createTelegramAlertDeliverySender({
    bot,
    formatAlert: formatter.format,
    marketHistory: options.marketHistory,
    sparklineRenderer: options.sparklineRenderer,
    onSparklineFallback: options.onSparklineFallback,
  });
}

function composeContextSource(options, settings) {
  if (options.contextSource) return options.contextSource;
  return createTelegramAlertDeliveryContextSource({
    sparklineHours: options.sparklineHours ?? settings.sparklineHours ?? 24,
    sparklineGranularityMinutes: options.sparklineGranularityMinutes
      ?? settings.sparklineGranularityMinutes
      ?? 5,
  });
}

function composeDeliveryWorker(options, settings, owner) {
  if (options.deliveryWorker) return options.deliveryWorker;
  return createTelegramAlertDeliveryWorker({
    owner,
    batchSize: settings.deliveryBatchSize,
    concurrency: settings.deliveryConcurrency,
    leaseMs: options.deliveryLeaseMs ?? settings.deliveryLeaseMs ?? 60_000,
    renewalIntervalMs: options.deliveryRenewalIntervalMs
      ?? settings.deliveryRenewalIntervalMs
      ?? 30_000,
    maxAttempts: settings.maxAttempts,
    deliveryModel: options.deliveryModel,
    contextSource: composeContextSource(options, settings),
    accessGate: options.accessGate || createTelegramAlertAccessGate(options.accessOptions),
    sender: composeSender(options, settings),
    onDeliveryError: options.onDeliveryError,
  });
}

function composeComponents(options, settings, owner) {
  const deliveryWorker = composeDeliveryWorker(options, settings, owner);
  const reactivationReconciler = options.reactivationReconciler
    || createTelegramAlertReactivationReconciler({
      batchSize: options.reactivationBatchSize ?? settings.reactivationBatchSize,
      onCandidateError: options.onReactivationError,
    });
  return {
    deliveryWorker: requirePort(
      deliveryWorker, 'runOnce', 'Telegram delivery worker is required',
    ),
    reactivationReconciler: requirePort(
      reactivationReconciler, 'reconcile', 'Telegram reactivation reconciler is required',
    ),
  };
}

function createTelegramAlertRuntime(options = {}) {
  const settings = options.settings || config.telegram || {};
  const enabled = options.enabled ?? settings.enabled === true;
  const intervalMs = integer(
    options.intervalMs ?? settings.deliveryIntervalMs,
    1_000,
    250,
    60_000,
    'Telegram runtime interval',
  );
  const maxErrorBackoffMs = integer(
    options.maxErrorBackoffMs ?? settings.deliveryMaxErrorBackoffMs,
    30_000,
    intervalMs,
    10 * 60_000,
    'Telegram runtime maximum error backoff',
  );
  const schedule = options.schedule || setTimeout;
  const cancelSchedule = options.cancelSchedule || clearTimeout;
  const now = options.now || Date.now;
  if (typeof schedule !== 'function' || typeof cancelSchedule !== 'function'
    || typeof now !== 'function') {
    throw new TypeError('Telegram runtime lifecycle ports are required');
  }
  const status = {
    enabled,
    running: false,
    inFlight: false,
    lastRunAt: null,
    lastCompletedAt: null,
    lastSummary: null,
    lastError: null,
    consecutiveErrors: 0,
    totalRuns: 0,
    totalErrors: 0,
    sparklineFallbacks: 0,
    lastSparklineFallbackAt: null,
  };
  const componentOptions = {
    ...options,
    async onSparklineFallback(input) {
      status.sparklineFallbacks += 1;
      status.lastSparklineFallbackAt = new Date(Number(now())).toISOString();
      if (typeof options.onSparklineFallback === 'function') {
        await options.onSparklineFallback(input);
      }
    },
  };
  const components = enabled
    ? composeComponents(componentOptions, settings, options.owner || buildOwner())
    : null;
  let activeRun = null;
  let running = false;
  let timer = null;

  async function report(error, phase) {
    if (typeof options.onRuntimeError !== 'function') return;
    try { await options.onRuntimeError({ error, phase }); } catch (_) {}
  }

  async function executeCycle() {
    let delivery = null;
    let reactivation = null;
    let errors = 0;
    try {
      delivery = await components.deliveryWorker.runOnce();
      if (Number(delivery?.errors) > 0) {
        errors += 1;
        await report(
          new Error('Telegram delivery cycle left unsettled claims'),
          'delivery-settlement',
        );
      }
    } catch (error) {
      errors += 1;
      await report(error, 'delivery');
    }
    if (!errors) {
      try {
        reactivation = await components.reactivationReconciler.reconcile({
          now: new Date(Number(now())),
        });
      } catch (error) {
        errors += 1;
        await report(error, 'reactivation');
      }
    }
    return Object.freeze({ enabled: true, delivery, reactivation, errors });
  }

  async function runOnce() {
    if (!enabled) return Object.freeze({ enabled: false });
    if (activeRun) return activeRun;
    activeRun = (async () => {
      const startedAt = Number(now());
      status.inFlight = true;
      status.lastRunAt = new Date(startedAt).toISOString();
      status.totalRuns += 1;
      const summary = await executeCycle();
      status.lastSummary = summary;
      status.lastCompletedAt = new Date(Number(now())).toISOString();
      if (summary.errors) {
        status.totalErrors += summary.errors;
        status.consecutiveErrors += 1;
        status.lastError = 'Telegram runtime cycle failed';
      } else {
        status.consecutiveErrors = 0;
        status.lastError = null;
      }
      return summary;
    })().finally(() => {
      status.inFlight = false;
      activeRun = null;
    });
    return activeRun;
  }

  function nextDelay() {
    if (!status.consecutiveErrors) return intervalMs;
    return Math.min(
      maxErrorBackoffMs,
      intervalMs * (2 ** Math.min(status.consecutiveErrors, 8)),
    );
  }

  function queueNext(delayMs) {
    if (!running) return;
    timer = schedule(async () => {
      try {
        await runOnce();
      } catch (error) {
        await report(error, 'runtime');
      } finally {
        queueNext(nextDelay());
      }
    }, delayMs);
    timer?.unref?.();
  }

  function start() {
    if (!enabled || running) return false;
    running = true;
    status.running = true;
    queueNext(0);
    return true;
  }

  async function stop() {
    running = false;
    status.running = false;
    if (timer) cancelSchedule(timer);
    timer = null;
    if (activeRun) await activeRun.catch(() => {});
  }

  return Object.freeze({
    getStatus: () => ({ ...status }),
    runOnce,
    start,
    stop,
  });
}

const defaultRuntime = createTelegramAlertRuntime();

module.exports = {
  createTelegramAlertRuntime,
  getStatus: defaultRuntime.getStatus,
  runOnce: defaultRuntime.runOnce,
  start: defaultRuntime.start,
  stop: defaultRuntime.stop,
};
