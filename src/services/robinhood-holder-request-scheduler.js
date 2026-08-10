const DEFAULT_REQUESTS_PER_SECOND = 2;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BASE_BACKOFF_MS = 1000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
const DEFAULT_CIRCUIT_FAILURE_THRESHOLD = 5;
const DEFAULT_CIRCUIT_RESET_MS = 30_000;

class RobinhoodHolderSchedulerError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'RobinhoodHolderSchedulerError';
    this.code = code;
    this.retryable = details.retryable === true;
    this.retryAfterMs = details.retryAfterMs ?? null;
  }
}

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(parsed, max)) : fallback;
}

function boundedInteger(value, fallback, min, max) {
  return Math.round(boundedNumber(value, fallback, min, max));
}

function parseRetryAfterMs(error, now) {
  const explicit = Number(error?.retryAfterMs);
  if (Number.isFinite(explicit) && explicit >= 0) return Math.round(explicit);
  const raw = String(error?.retryAfter ?? '').trim();
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

function createRobinhoodHolderRequestScheduler(options = {}) {
  const requestsPerSecond = boundedNumber(
    options.requestsPerSecond, DEFAULT_REQUESTS_PER_SECOND, 0.1, 2
  );
  const concurrency = boundedInteger(options.concurrency, DEFAULT_CONCURRENCY, 1, 2);
  const maxRetries = boundedInteger(options.maxRetries, DEFAULT_MAX_RETRIES, 0, 3);
  const baseBackoffMs = boundedInteger(options.baseBackoffMs, DEFAULT_BASE_BACKOFF_MS, 1, 30_000);
  const maxBackoffMs = boundedInteger(
    options.maxBackoffMs, DEFAULT_MAX_BACKOFF_MS, baseBackoffMs, 120_000
  );
  const circuitFailureThreshold = boundedInteger(
    options.circuitFailureThreshold, DEFAULT_CIRCUIT_FAILURE_THRESHOLD, 1, 20
  );
  const circuitResetMs = boundedInteger(
    options.circuitResetMs, DEFAULT_CIRCUIT_RESET_MS, 1, 300_000
  );
  const now = options.now || Date.now;
  const random = options.random || Math.random;
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const minStartIntervalMs = Math.ceil(1000 / requestsPerSecond);

  const queue = [];
  const counters = {
    requests: 0,
    attempts: 0,
    successes: 0,
    failures: 0,
    retries: 0,
    rateLimited: 0,
    timeouts: 0,
    circuitOpened: 0,
  };
  let active = 0;
  let nextStartAt = 0;
  let startGate = Promise.resolve();
  let circuitState = 'closed';
  let consecutiveFailures = 0;
  let circuitOpenedAt = null;
  let halfOpenInFlight = false;

  function refreshCircuitState() {
    if (
      circuitState === 'open'
      && circuitOpenedAt !== null
      && now() - circuitOpenedAt >= circuitResetMs
    ) {
      circuitState = 'half_open';
    }
    return circuitState;
  }

  function circuitError() {
    const elapsed = circuitOpenedAt === null ? 0 : Math.max(0, now() - circuitOpenedAt);
    return new RobinhoodHolderSchedulerError('Blockscout holders circuit is open', 'circuit_open', {
      retryable: true,
      retryAfterMs: Math.max(0, circuitResetMs - elapsed),
    });
  }

  function acquireCircuitAccess() {
    const state = refreshCircuitState();
    if (state === 'open' || (state === 'half_open' && halfOpenInFlight)) throw circuitError();
    if (state === 'half_open') halfOpenInFlight = true;
    return state === 'half_open';
  }

  function closeCircuit() {
    circuitState = 'closed';
    consecutiveFailures = 0;
    circuitOpenedAt = null;
    halfOpenInFlight = false;
  }

  function openCircuit() {
    circuitState = 'open';
    circuitOpenedAt = now();
    halfOpenInFlight = false;
    counters.circuitOpened += 1;
  }

  function recordFinalFailure(error, wasProbe) {
    counters.failures += 1;
    if (error?.retryable !== true) {
      closeCircuit();
      return;
    }
    consecutiveFailures += 1;
    if (wasProbe || consecutiveFailures >= circuitFailureThreshold) openCircuit();
  }

  function retryDelay(error, retryIndex) {
    const retryAfterMs = parseRetryAfterMs(error, now());
    if (retryAfterMs !== null) return Math.min(maxBackoffMs, retryAfterMs);
    const jitter = 0.8 + (Math.max(0, Math.min(1, random())) * 0.4);
    return Math.min(maxBackoffMs, Math.round(baseBackoffMs * (2 ** retryIndex) * jitter));
  }

  async function runInStartSlot(task, attempt) {
    const priorGate = startGate;
    let releaseGate;
    startGate = new Promise((resolve) => { releaseGate = resolve; });
    try {
      await priorGate;
      const delayMs = Math.max(0, nextStartAt - now());
      if (delayMs > 0) await sleep(delayMs);
      nextStartAt = now() + minStartIntervalMs;
      counters.attempts += 1;
    } catch (error) {
      releaseGate();
      throw error;
    }
    let outcome;
    try {
      outcome = Promise.resolve(task({ attempt }));
    } catch (error) {
      outcome = Promise.reject(error);
    } finally {
      releaseGate();
    }
    return outcome;
  }

  function recordAttemptError(error) {
    if (error?.code === 'rate_limited' || error?.httpStatus === 429) counters.rateLimited += 1;
    if (error?.code === 'timeout') counters.timeouts += 1;
  }

  async function execute(task) {
    const wasProbe = acquireCircuitAccess();
    for (let retryIndex = 0; retryIndex <= maxRetries; retryIndex += 1) {
      try {
        const result = await runInStartSlot(task, retryIndex + 1);
        counters.successes += 1;
        closeCircuit();
        return result;
      } catch (error) {
        recordAttemptError(error);
        const canRetry = error?.retryable === true && retryIndex < maxRetries;
        if (!canRetry) {
          recordFinalFailure(error, wasProbe);
          throw error;
        }
        counters.retries += 1;
        await sleep(retryDelay(error, retryIndex));
      }
    }
    throw new Error('Unreachable holders scheduler state');
  }

  function drain() {
    while (active < concurrency && queue.length > 0) {
      const entry = queue.shift();
      active += 1;
      execute(entry.task)
        .then(entry.resolve, entry.reject)
        .finally(() => {
          active -= 1;
          drain();
        });
    }
  }

  function schedule(task) {
    if (typeof task !== 'function') return Promise.reject(new TypeError('Holders task must be a function'));
    counters.requests += 1;
    if (refreshCircuitState() === 'open') return Promise.reject(circuitError());
    return new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      drain();
    });
  }

  function getStatus() {
    return Object.freeze({
      circuitState: refreshCircuitState(),
      consecutiveFailures,
      active,
      queued: queue.length,
      ...counters,
    });
  }

  return Object.freeze({ schedule, getStatus });
}

module.exports = {
  RobinhoodHolderSchedulerError,
  createRobinhoodHolderRequestScheduler,
  parseRetryAfterMs,
};
