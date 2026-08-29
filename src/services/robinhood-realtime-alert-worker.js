const { createRobinhoodTokenReadRepository } = require('../models/robinhood-token-read');
const { normalizeTokenAddress } = require('../utils/token-identity');
const { createRobinhoodAlertPublicationBatch } = require('./robinhood-alert-publication-batch');
const {
  isCatalogFdvExcluded,
} = require('./robinhood-catalog-fdv-policy');

const CHAIN = 'robinhood';
const MAX_BATCH_SIZE = 100;

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed)
    ? Math.max(minimum, Math.min(parsed, maximum))
    : fallback;
}

function createRobinhoodRealtimeAlertWorker(deps = {}) {
  const repository = deps.repository || createRobinhoodTokenReadRepository();
  const publication = deps.publication || createRobinhoodAlertPublicationBatch();
  const schedule = deps.schedule || setTimeout;
  const cancelSchedule = deps.cancelSchedule || clearTimeout;
  const logger = deps.logger || console;
  const now = deps.now || Date.now;
  let options = {};
  let running = false;
  let timer = null;
  let activeRun = null;
  const pending = new Map();
  const status = {
    running: false, queued: 0, processed: 0, candidates: 0,
    skippedStale: 0, skippedRollout: 0, skippedFdvCap: 0, errors: 0,
    lastDurationMs: 0, lastCompletedAt: null, lastError: null,
  };

  function normalizeUpdate(payload) {
    if (payload?.type !== 'market:bucket' || payload?.chain !== CHAIN) return null;
    if (isCatalogFdvExcluded(payload.valuation?.fdvUsd)) {
      status.skippedFdvCap += 1;
      return null;
    }
    let address;
    try {
      address = normalizeTokenAddress(CHAIN, payload.address);
    } catch (_) {
      return null;
    }
    const observedAt = new Date(payload.valuation?.observedAt || payload.generatedAt);
    const observedAtMs = observedAt.getTime();
    const ageMs = now() - observedAtMs;
    if (!Number.isFinite(observedAtMs) || ageMs < -5000 || ageMs > options.maxEventLagMs) {
      status.skippedStale += 1;
      return null;
    }
    return { address, observedAtMs };
  }

  function queueFlush() {
    if (!running || timer || activeRun || pending.size === 0) return;
    timer = schedule(() => {
      timer = null;
      void flush().catch((error) => logger.error(
        `[RobinhoodRealtimeAlertWorker] ${error.message}`,
      ));
    }, options.debounceMs);
    timer?.unref?.();
  }

  function enqueue(payload) {
    if (!running) return false;
    const update = normalizeUpdate(payload);
    if (!update) return false;
    const previous = pending.get(update.address);
    pending.set(update.address, Math.max(previous || 0, update.observedAtMs));
    status.queued += 1;
    queueFlush();
    return true;
  }

  async function processNextBatch() {
    const selected = [...pending.entries()].slice(0, MAX_BATCH_SIZE);
    for (const [address] of selected) pending.delete(address);
    const fresh = selected.filter(([, observedAtMs]) => (
      now() - observedAtMs <= options.maxEventLagMs
    ));
    status.skippedStale += selected.length - fresh.length;
    if (!fresh.length) return;

    const rollout = await options.rolloutProvider();
    if (rollout?.alertsRequested !== true || rollout?.publishable !== true) {
      status.skippedRollout += fresh.length;
      return;
    }
    const asOfMs = Math.max(...fresh.map(([, observedAtMs]) => observedAtMs));
    const asOf = new Date(asOfMs);
    const addresses = fresh.map(([address]) => address);
    const candidates = await repository.listActiveTokenCandidatesByAddresses({
      addresses,
      windowMs: options.signalConfig.windowMs,
      asOf,
      statementTimeoutMs: options.statementTimeoutMs,
    });
    const summary = await publication.runCandidates(candidates, {
      alertsRequested: true,
      publishable: true,
      signalConfig: options.signalConfig,
      asOf,
    });
    status.processed += fresh.length;
    status.candidates += candidates.length;
    status.lastSummary = summary;
  }

  async function flush() {
    if (activeRun) return activeRun;
    if (timer) cancelSchedule(timer);
    timer = null;
    if (!running || pending.size === 0) return null;
    const startedAt = now();
    activeRun = processNextBatch()
      .then(() => {
        status.lastError = null;
        status.lastCompletedAt = new Date(now()).toISOString();
      })
      .catch((error) => {
        status.errors += 1;
        status.lastError = String(error?.message || error).slice(0, 500);
        throw error;
      })
      .finally(() => {
        status.lastDurationMs = Math.max(0, now() - startedAt);
        activeRun = null;
        queueFlush();
      });
    return activeRun;
  }

  function start(input = {}) {
    if (running || input.enabled !== true) return false;
    const windowMs = boundedInteger(input.signalConfig?.windowMs, 300_000, 60_000, 14 * 86400_000);
    options = {
      debounceMs: boundedInteger(input.debounceMs, 25, 0, 1000),
      maxEventLagMs: boundedInteger(input.maxEventLagMs, 30_000, 1000, windowMs),
      rolloutProvider: typeof input.rolloutProvider === 'function'
        ? input.rolloutProvider : () => ({ alertsRequested: false, publishable: false }),
      signalConfig: { ...(input.signalConfig || {}), windowMs },
      statementTimeoutMs: boundedInteger(input.statementTimeoutMs, 1500, 1000, 60_000),
    };
    running = true;
    status.running = true;
    return true;
  }

  async function stop() {
    running = false;
    status.running = false;
    if (timer) cancelSchedule(timer);
    timer = null;
    pending.clear();
    if (activeRun) await activeRun.catch(() => {});
  }

  return Object.freeze({
    enqueue,
    flush,
    getStatus: () => ({ ...status, pending: pending.size }),
    start,
    stop,
  });
}

const worker = createRobinhoodRealtimeAlertWorker();

module.exports = {
  createRobinhoodRealtimeAlertWorker,
  enqueue: worker.enqueue,
  flush: worker.flush,
  getStatus: worker.getStatus,
  start: worker.start,
  stop: worker.stop,
};
