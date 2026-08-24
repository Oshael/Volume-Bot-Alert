const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_BACKOFF_MS = 250;
const DEFAULT_MAX_BACKOFF_MS = 5000;
const MAX_LATENCY_SAMPLES = 256;

class EvmRpcError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'EvmRpcError';
    this.code = details.code || 'rpc_error';
    this.provider = details.provider || null;
    this.method = details.method || null;
    this.httpStatus = details.httpStatus ?? null;
    this.rpcCode = details.rpcCode ?? null;
    this.retryable = Boolean(details.retryable);
    this.retryAfterMs = details.retryAfterMs ?? null;
    this.attempt = details.attempt ?? null;
  }
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function normalizeProviders(providers) {
  if (!Array.isArray(providers) || providers.length === 0) {
    throw new TypeError('At least one EVM RPC provider is required');
  }
  const names = new Set();
  return providers.map((provider, index) => {
    const name = String(provider?.name || `provider-${index + 1}`).trim();
    const url = new URL(String(provider?.url || ''));
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new TypeError(`EVM RPC provider ${name} must use HTTP(S)`);
    }
    if (names.has(name)) throw new TypeError(`Duplicate EVM RPC provider name: ${name}`);
    names.add(name);
    const minRequestIntervalMs = provider?.minRequestIntervalMs == null
      ? null
      : clampInteger(provider.minRequestIntervalMs, null, 0, 60000);
    return Object.freeze({ name, url: url.toString(), minRequestIntervalMs });
  });
}

function parseRetryAfterMs(value, now = Date.now()) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

function statusBucket(status) {
  if (status == null) return 'transport';
  if (status === 429) return '429';
  if (status >= 500) return '5xx';
  if (status >= 400) return '4xx';
  return '2xx';
}

function percentile(values, percentage) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil((percentage / 100) * sorted.length) - 1];
}

function createMetricEntry() {
  return {
    requests: 0, successes: 0, errors: 0, retries: 0, fallbacks: 0,
    batchItems: 0,
    requestBytes: 0, responseBytes: 0,
    statuses: { '2xx': 0, '4xx': 0, '5xx': 0, '429': 0, transport: 0 },
    errorCodes: {}, latencySamples: [],
  };
}

function snapshotMetric(entry) {
  return {
    requests: entry.requests,
    successes: entry.successes,
    errors: entry.errors,
    retries: entry.retries,
    fallbacks: entry.fallbacks,
    batchItems: entry.batchItems,
    requestBytes: entry.requestBytes,
    responseBytes: entry.responseBytes,
    statuses: { ...entry.statuses },
    errorCodes: { ...entry.errorCodes },
    latencyMs: {
      count: entry.latencySamples.length,
      p50: percentile(entry.latencySamples, 50),
      p95: percentile(entry.latencySamples, 95),
      p99: percentile(entry.latencySamples, 99),
    },
  };
}

function createAbortContext(signal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    wasTimedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

function isLogRangeRpcError(method, rpcCode, message) {
  if (method !== 'eth_getLogs') return false;
  if (rpcCode === -32002) return true;
  if (rpcCode !== -32000) return false;
  const normalized = String(message || '').trim().toLowerCase();
  return [
    /log query timed out/,
    /block range.{0,40}(too (large|wide)|exceed)/,
    /(too many|more than [0-9]+).{0,30}(logs|results)/,
    /response size.{0,30}(exceed|too large)/,
    /limit.{0,30}(block|range).{0,30}query/,
  ].some((pattern) => pattern.test(normalized));
}

function decodeRpcBody(rawBody, requestId, method = null) {
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch (_) {
    return { error: { code: 'invalid_response', message: 'returned invalid JSON' } };
  }
  if (body?.jsonrpc !== '2.0' || body?.id !== requestId || (!('result' in body) && !body?.error)) {
    return { error: { code: 'invalid_response', message: 'returned an invalid JSON-RPC envelope' } };
  }
  if (body.error) {
    const rpcCode = Number(body.error.code);
    const logRangeError = isLogRangeRpcError(method, rpcCode, body.error.message);
    return {
      error: {
        code: logRangeError ? 'log_range_error' : 'rpc_error',
        message: `RPC error ${rpcCode}`,
        rpcCode,
        retryable: !logRangeError && (rpcCode === -32005 || rpcCode === -32603),
      },
    };
  }
  return { result: body.result };
}

function decodeRpcBatchBody(rawBody, requests) {
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch (_) {
    return { error: { code: 'invalid_response', message: 'returned invalid JSON' } };
  }
  if (!Array.isArray(body)) {
    return { error: { code: 'batch_unsupported', message: 'did not return a JSON-RPC batch' } };
  }
  const byId = new Map();
  for (const entry of body) {
    if (!entry || byId.has(entry.id)) {
      return { error: { code: 'invalid_response', message: 'returned duplicate batch IDs' } };
    }
    byId.set(entry.id, entry);
  }
  const results = [];
  for (const request of requests) {
    const entry = byId.get(request.id);
    if (!entry) return { error: { code: 'invalid_response', message: 'omitted a batch response' } };
    const decoded = decodeRpcBody(JSON.stringify(entry), request.id, request.method);
    if (decoded.error) return { error: { ...decoded.error, method: request.method } };
    results.push(decoded.result);
  }
  if (byId.size !== requests.length) {
    return { error: { code: 'invalid_response', message: 'returned unexpected batch IDs' } };
  }
  return { results };
}

function createEvmJsonRpcClient(options = {}) {
  const providers = normalizeProviders(options.providers);
  const fetchImpl = options.fetchImpl || global.fetch;
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required');
  const timeoutMs = clampInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1, 60000);
  const maxRetries = clampInteger(options.maxRetries, DEFAULT_MAX_RETRIES, 0, 5);
  const baseBackoffMs = clampInteger(options.baseBackoffMs, DEFAULT_BACKOFF_MS, 0, 60000);
  const maxBackoffMs = clampInteger(options.maxBackoffMs, DEFAULT_MAX_BACKOFF_MS, 1, 300000);
  const minRequestIntervalMs = clampInteger(options.minRequestIntervalMs, 0, 0, 60000);
  const sleep = options.sleep || ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  const random = options.random || Math.random;
  const now = options.now || Date.now;
  const metrics = new Map();
  const providerTails = new Map();
  const providerNextAllowedAt = new Map();
  let nextRequestId = 0;

  async function throttle(provider) {
    const intervalMs = provider.minRequestIntervalMs ?? minRequestIntervalMs;
    if (intervalMs <= 0) return;
    const providerName = provider.name;
    const previous = providerTails.get(providerName) || Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      const delayMs = Math.max(0, (providerNextAllowedAt.get(providerName) || 0) - now());
      if (delayMs > 0) await sleep(delayMs);
      providerNextAllowedAt.set(providerName, now() + intervalMs);
    });
    providerTails.set(providerName, task);
    try {
      await task;
    } finally {
      if (providerTails.get(providerName) === task) providerTails.delete(providerName);
    }
  }

  function metricFor(provider, method) {
    const key = `${provider}\u0000${method}`;
    if (!metrics.has(key)) metrics.set(key, createMetricEntry());
    return metrics.get(key);
  }

  function recordAttempt(provider, method, result) {
    const metric = metricFor(provider, method);
    metric.requests += 1;
    metric.requestBytes += result.requestBytes || 0;
    metric.responseBytes += result.responseBytes || 0;
    metric.batchItems += result.batchItems || 0;
    metric.statuses[statusBucket(result.httpStatus)] += 1;
    metric.latencySamples.push(result.elapsedMs);
    if (metric.latencySamples.length > MAX_LATENCY_SAMPLES) metric.latencySamples.shift();
    if (result.error) {
      metric.errors += 1;
      metric.errorCodes[result.error.code] = (metric.errorCodes[result.error.code] || 0) + 1;
    } else {
      metric.successes += 1;
    }
  }

  function makeError(message, details) {
    return new EvmRpcError(message, details);
  }

  async function fetchAttempt(provider, method, params, requestId, attempt, signal) {
    const payload = JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params });
    const requestBytes = Buffer.byteLength(payload);
    const abortContext = createAbortContext(signal, timeoutMs);
    const startedAt = now();
    let response;
    let rawBody = '';

    try {
      response = await fetchImpl(provider.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        signal: abortContext.signal,
      });
      rawBody = await response.text();
    } catch (_) {
      const aborted = signal?.aborted && !abortContext.wasTimedOut();
      const code = aborted ? 'aborted' : abortContext.wasTimedOut() ? 'timeout' : 'transport_error';
      const error = makeError(`${method} ${code.replace('_', ' ')}`, {
        code, provider: provider.name, method, attempt, retryable: !aborted,
      });
      recordAttempt(provider.name, method, {
        error, requestBytes, responseBytes: 0, httpStatus: null, elapsedMs: now() - startedAt,
      });
      throw error;
    } finally {
      abortContext.cleanup();
    }

    const common = {
      provider: provider.name,
      method,
      attempt,
      httpStatus: response.status,
      retryAfterMs: parseRetryAfterMs(response.headers?.get?.('retry-after'), now()),
    };
    const resultMetrics = {
      requestBytes,
      responseBytes: Buffer.byteLength(rawBody),
      httpStatus: response.status,
      elapsedMs: now() - startedAt,
    };
    if (!response.ok) {
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      const error = makeError(`${method} failed with HTTP ${response.status}`, {
        ...common, code: response.status === 429 ? 'rate_limited' : 'http_error', retryable,
      });
      recordAttempt(provider.name, method, { ...resultMetrics, error });
      throw error;
    }

    const decoded = decodeRpcBody(rawBody, requestId, method);
    if (decoded.error) {
      const error = makeError(`${method} ${decoded.error.message}`, { ...common, ...decoded.error });
      recordAttempt(provider.name, method, { ...resultMetrics, error });
      throw error;
    }
    recordAttempt(provider.name, method, resultMetrics);
    return decoded.result;
  }

  async function fetchBatchAttempt(provider, requests, metricMethod, attempt, signal) {
    const payload = JSON.stringify(requests.map(({ id, method, params }) => ({
      jsonrpc: '2.0', id, method, params,
    })));
    const requestBytes = Buffer.byteLength(payload);
    const abortContext = createAbortContext(signal, timeoutMs);
    const startedAt = now();
    let response;
    let rawBody = '';

    try {
      response = await fetchImpl(provider.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        signal: abortContext.signal,
      });
      rawBody = await response.text();
    } catch (_) {
      const aborted = signal?.aborted && !abortContext.wasTimedOut();
      const code = aborted ? 'aborted' : abortContext.wasTimedOut() ? 'timeout' : 'transport_error';
      const error = makeError(`${metricMethod} ${code.replace('_', ' ')}`, {
        code, provider: provider.name, method: metricMethod, attempt, retryable: !aborted,
      });
      recordAttempt(provider.name, metricMethod, {
        error, requestBytes, responseBytes: 0, httpStatus: null,
        elapsedMs: now() - startedAt, batchItems: requests.length,
      });
      throw error;
    } finally {
      abortContext.cleanup();
    }

    const common = {
      provider: provider.name,
      method: metricMethod,
      attempt,
      httpStatus: response.status,
      retryAfterMs: parseRetryAfterMs(response.headers?.get?.('retry-after'), now()),
    };
    const resultMetrics = {
      requestBytes,
      responseBytes: Buffer.byteLength(rawBody),
      httpStatus: response.status,
      elapsedMs: now() - startedAt,
      batchItems: requests.length,
    };
    if (!response.ok) {
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      const error = makeError(`${metricMethod} failed with HTTP ${response.status}`, {
        ...common, code: response.status === 429 ? 'rate_limited' : 'http_error', retryable,
      });
      recordAttempt(provider.name, metricMethod, { ...resultMetrics, error });
      throw error;
    }

    const decoded = decodeRpcBatchBody(rawBody, requests);
    if (decoded.error) {
      const error = makeError(`${metricMethod} ${decoded.error.message}`, { ...common, ...decoded.error });
      recordAttempt(provider.name, metricMethod, { ...resultMetrics, error });
      throw error;
    }
    recordAttempt(provider.name, metricMethod, resultMetrics);
    return decoded.results;
  }

  function backoffMs(error, retryIndex) {
    if (Number.isFinite(error.retryAfterMs)) return Math.min(maxBackoffMs, error.retryAfterMs);
    const jitter = 0.8 + (Math.max(0, Math.min(1, random())) * 0.4);
    return Math.min(maxBackoffMs, Math.round(baseBackoffMs * (2 ** retryIndex) * jitter));
  }

  async function requestAcross(providerList, method, params = [], requestOptions = {}) {
    const normalizedMethod = String(method || '').trim();
    if (!normalizedMethod) throw new TypeError('JSON-RPC method is required');
    if (!Array.isArray(params) && (params == null || typeof params !== 'object')) {
      throw new TypeError('JSON-RPC params must be an array or object');
    }
    const requestId = ++nextRequestId;
    let lastError;
    for (let providerIndex = 0; providerIndex < providerList.length; providerIndex += 1) {
      const provider = providerList[providerIndex];
      if (providerIndex > 0) metricFor(provider.name, normalizedMethod).fallbacks += 1;
      for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
        try {
          await throttle(provider);
          return await fetchAttempt(provider, normalizedMethod, params, requestId, attempt, requestOptions.signal);
        } catch (error) {
          lastError = error;
          if (!error.retryable) {
            const canFallback = requestOptions.fallbackOnRpcError === true
              && error.code === 'rpc_error'
              && providerIndex < providerList.length - 1;
            if (canFallback) break;
            throw error;
          }
          if (attempt <= maxRetries) {
            metricFor(provider.name, normalizedMethod).retries += 1;
            await sleep(backoffMs(error, attempt - 1));
          }
        }
      }
    }
    throw lastError;
  }

  async function requestBatchAcross(providerList, input, requestOptions = {}) {
    if (!Array.isArray(input) || input.length === 0 || input.length > 100) {
      throw new TypeError('JSON-RPC batch must contain between 1 and 100 requests');
    }
    const requests = input.map((entry) => {
      const method = String(entry?.method || '').trim();
      const params = entry?.params ?? [];
      if (!method) throw new TypeError('Every JSON-RPC batch item requires a method');
      if (!Array.isArray(params) && (params == null || typeof params !== 'object')) {
        throw new TypeError('JSON-RPC batch params must be an array or object');
      }
      return { id: ++nextRequestId, method, params };
    });
    const methods = new Set(requests.map(({ method }) => method));
    const metricMethod = methods.size === 1 ? `${requests[0].method}:batch` : 'batch';
    let lastError;
    for (let providerIndex = 0; providerIndex < providerList.length; providerIndex += 1) {
      const provider = providerList[providerIndex];
      if (providerIndex > 0) metricFor(provider.name, metricMethod).fallbacks += 1;
      for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
        try {
          await throttle(provider);
          return await fetchBatchAttempt(
            provider, requests, metricMethod, attempt, requestOptions.signal
          );
        } catch (error) {
          lastError = error;
          if (!error.retryable) {
            const canFallback = requestOptions.fallbackOnRpcError === true
              && error.code === 'rpc_error'
              && providerIndex < providerList.length - 1;
            if (canFallback) break;
            throw error;
          }
          if (attempt <= maxRetries) {
            metricFor(provider.name, metricMethod).retries += 1;
            await sleep(backoffMs(error, attempt - 1));
          }
        }
      }
    }
    throw lastError;
  }

  function request(method, params = [], requestOptions = {}) {
    return requestAcross(providers, method, params, requestOptions);
  }

  function requestProvider(providerName, method, params = [], requestOptions = {}) {
    return requestAcross(resolveProviders([providerName]), method, params, requestOptions);
  }

  function resolveProviders(providerNames) {
    if (!Array.isArray(providerNames) || providerNames.length === 0) {
      throw new TypeError('At least one EVM RPC provider name is required');
    }
    return providerNames.map((providerName) => {
      const normalizedName = String(providerName || '').trim();
      const provider = providers.find(({ name }) => name === normalizedName);
      if (!provider) {
        throw new TypeError(`Unknown EVM RPC provider: ${normalizedName || '(empty)'}`);
      }
      return provider;
    });
  }

  function requestProviders(providerNames, method, params = [], requestOptions = {}) {
    return requestAcross(resolveProviders(providerNames), method, params, requestOptions);
  }

  function requestBatch(requests, requestOptions = {}) {
    return requestBatchAcross(providers, requests, requestOptions);
  }

  function requestBatchProvider(providerName, requests, requestOptions = {}) {
    return requestBatchAcross(resolveProviders([providerName]), requests, requestOptions);
  }

  function requestBatchProviders(providerNames, requests, requestOptions = {}) {
    return requestBatchAcross(resolveProviders(providerNames), requests, requestOptions);
  }

  function getMetrics() {
    const output = {};
    for (const [key, entry] of metrics) {
      const [provider, method] = key.split('\u0000');
      output[provider] ||= {};
      output[provider][method] = snapshotMetric(entry);
    }
    return output;
  }

  return Object.freeze({
    request,
    requestBatch,
    requestBatchProvider,
    requestBatchProviders,
    requestProvider,
    requestProviders,
    getMetrics,
    providers: providers.map(({ name }) => name),
  });
}

module.exports = {
  EvmRpcError,
  createEvmJsonRpcClient,
  decodeRpcBatchBody,
  parseRetryAfterMs,
};
