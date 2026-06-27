const DEFAULT_BASE_URL = 'https://mainnet.helius-rpc.com/';
const DEFAULT_WEBHOOK_API_BASE_URL = 'https://mainnet.helius-rpc.com/';
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_RPC_MIN_INTERVAL_MS = 125;
const DEFAULT_DAS_MIN_INTERVAL_MS = 600;
const DAS_METHODS = new Set([
  'getAsset',
  'getAssetBatch',
  'searchAssets',
  'getAssetsByOwner',
  'getAssetsByCreator',
  'getAssetsByAuthority',
  'getAssetsByGroup',
  'getTokenAccounts',
]);

let requestIdCounter = 1;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function normalizeBaseUrl(value) {
  const raw = String(value || DEFAULT_BASE_URL).trim();
  if (!raw) {
    return DEFAULT_BASE_URL;
  }

  const parsed = new URL(raw);
  parsed.hash = '';
  parsed.search = '';

  return `${parsed.toString().replace(/\/+$/, '')}/`;
}

function buildRpcUrl({ apiKey, baseUrl = DEFAULT_BASE_URL } = {}) {
  const trimmedApiKey = String(apiKey || '').trim();
  if (!trimmedApiKey) {
    throw new Error('Helius API key is required');
  }

  const url = new URL(normalizeBaseUrl(baseUrl));
  url.searchParams.set('api-key', trimmedApiKey);
  return url.toString();
}

function buildWebhookApiUrl({ apiKey, apiBaseUrl = DEFAULT_WEBHOOK_API_BASE_URL, path = '' } = {}) {
  const trimmedApiKey = String(apiKey || '').trim();
  if (!trimmedApiKey) {
    throw new Error('Helius API key is required');
  }

  const url = new URL(String(path || '').replace(/^\/+/, ''), normalizeBaseUrl(apiBaseUrl));
  url.searchParams.set('api-key', trimmedApiKey);
  return url.toString();
}

function resolveMethodChannel(method) {
  return DAS_METHODS.has(String(method || '').trim()) ? 'das' : 'rpc';
}

function createHeliusError(message, details = {}) {
  const error = new Error(message);
  if (details.code != null) {
    error.code = details.code;
  }
  if (details.status != null) {
    error.status = details.status;
  }
  if (details.method != null) {
    error.method = details.method;
  }
  if (details.body !== undefined) {
    error.body = details.body;
  }
  return error;
}

function createChannelLimiter(now = () => Date.now()) {
  const stateByChannel = new Map();

  return async function throttle(channel, minIntervalMs) {
    const normalizedChannel = String(channel || 'rpc').trim() || 'rpc';
    const intervalMs = Math.max(0, Number(minIntervalMs) || 0);
    const currentState = stateByChannel.get(normalizedChannel) || {
      lastRunStartedAt: 0,
      tail: Promise.resolve(),
    };

    const tail = currentState.tail.then(async () => {
      const waitMs = Math.max(0, (currentState.lastRunStartedAt + intervalMs) - now());
      if (waitMs > 0) {
        await sleep(waitMs);
      }
      currentState.lastRunStartedAt = now();
    });

    currentState.tail = tail.catch(() => {});
    stateByChannel.set(normalizedChannel, currentState);
    await tail;
  };
}

function buildRpcParams(address, options = {}) {
  const commitment = String(options.commitment || '').trim();
  if (!commitment) {
    return [address];
  }
  return [address, { commitment }];
}

function buildMultipleAccountsParams(addresses, options = {}) {
  const params = [addresses];
  const config = {};

  if (options.commitment) {
    config.commitment = String(options.commitment).trim();
  }
  if (options.encoding) {
    config.encoding = String(options.encoding).trim();
  }
  if (options.dataSlice && typeof options.dataSlice === 'object') {
    config.dataSlice = options.dataSlice;
  }

  if (Object.keys(config).length > 0) {
    params.push(config);
  }

  return params;
}

function assignTrimmedString(target, key, value) {
  const trimmed = String(value || '').trim();
  if (trimmed) {
    target[key] = trimmed;
  }
}

function buildTokenAccountsParams(filters = {}) {
  const params = {};
  assignTrimmedString(params, 'owner', filters.owner);
  assignTrimmedString(params, 'mint', filters.mint);
  const page = toPositiveIntegerOrNull(filters.page);
  const limit = toPositiveIntegerOrNull(filters.limit);

  if (!params.owner && !params.mint) {
    throw new Error('getTokenAccounts requires owner or mint');
  }

  assignTrimmedString(params, 'cursor', filters.cursor);
  assignTrimmedString(params, 'before', filters.before);
  assignTrimmedString(params, 'after', filters.after);
  if (page != null) {
    params.page = page;
  }
  if (limit != null) {
    params.limit = limit;
  }

  if (filters.options && typeof filters.options === 'object' && !Array.isArray(filters.options)) {
    params.options = { ...filters.options };
  }

  return params;
}

function toPositiveIntegerOrNull(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function resolveClientOptions(options = {}) {
  return {
    apiKey: String(options.apiKey || process.env.HELIUS_API_KEY || '').trim(),
    baseUrl: normalizeBaseUrl(options.baseUrl || process.env.HELIUS_BASE_URL || DEFAULT_BASE_URL),
    timeoutMs: parsePositiveInteger(options.timeoutMs || process.env.HELIUS_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    rpcMinIntervalMs: parsePositiveInteger(
      options.rpcMinIntervalMs || process.env.HELIUS_RPC_MIN_INTERVAL_MS,
      DEFAULT_RPC_MIN_INTERVAL_MS
    ),
    dasMinIntervalMs: parsePositiveInteger(
      options.dasMinIntervalMs || process.env.HELIUS_DAS_MIN_INTERVAL_MS,
      DEFAULT_DAS_MIN_INTERVAL_MS
    ),
    requestImpl: options.requestImpl || fetch,
  };
}

function createHeliusClient(options = {}) {
  const resolved = resolveClientOptions(options);
  const throttle = createChannelLimiter();

  async function request(method, params, requestOptions = {}) {
    const channel = resolveMethodChannel(method);
    const minIntervalMs = channel === 'das'
      ? resolved.dasMinIntervalMs
      : resolved.rpcMinIntervalMs;

    await throttle(channel, minIntervalMs);

    const response = await resolved.requestImpl(buildRpcUrl(resolved), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(requestOptions.timeoutMs || resolved.timeoutMs),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: String(requestIdCounter++),
        method,
        params,
      }),
    });

    let body = null;
    try {
      body = await response.json();
    } catch (_) {
      body = null;
    }

    if (!response.ok) {
      throw createHeliusError(
        `Helius ${method} failed with status ${response.status}`,
        {
          status: response.status,
          method,
          body,
        }
      );
    }

    if (body?.error) {
      throw createHeliusError(
        body.error.message || `Helius ${method} returned an RPC error`,
        {
          code: body.error.code,
          method,
          body,
        }
      );
    }

    return body?.result ?? null;
  }

  async function requestWebhookApi(method, path, body, requestOptions = {}) {
    const response = await resolved.requestImpl(buildWebhookApiUrl({
      apiKey: resolved.apiKey,
      apiBaseUrl: requestOptions.apiBaseUrl || process.env.HELIUS_WEBHOOK_API_BASE_URL,
      path,
    }), {
      method,
      headers: {
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(requestOptions.timeoutMs || resolved.timeoutMs),
      body: body == null ? undefined : JSON.stringify(body),
    });

    let responseBody = null;
    try {
      responseBody = await response.json();
    } catch (_) {
      responseBody = null;
    }

    if (!response.ok) {
      throw createHeliusError(
        `Helius webhook API ${method} ${path} failed with status ${response.status}`,
        {
          status: response.status,
          method: `webhook:${method}`,
          body: responseBody,
        }
      );
    }

    return responseBody;
  }

  return {
    request,
    requestWebhookApi,
    getAsset(address, requestOptions = {}) {
      const assetId = String(address || '').trim();
      if (!assetId) {
        throw new Error('Asset address is required');
      }

      const params = {
        id: assetId,
        ...(requestOptions.displayOptions ? { displayOptions: requestOptions.displayOptions } : {}),
      };

      return request('getAsset', params, requestOptions);
    },
    getTokenLargestAccounts(address, requestOptions = {}) {
      const mintAddress = String(address || '').trim();
      if (!mintAddress) {
        throw new Error('Mint address is required');
      }
      return request('getTokenLargestAccounts', buildRpcParams(mintAddress, requestOptions), requestOptions);
    },
    getTokenSupply(address, requestOptions = {}) {
      const mintAddress = String(address || '').trim();
      if (!mintAddress) {
        throw new Error('Mint address is required');
      }
      return request('getTokenSupply', buildRpcParams(mintAddress, requestOptions), requestOptions);
    },
    getMultipleAccounts(addresses, requestOptions = {}) {
      const normalizedAddresses = Array.isArray(addresses)
        ? addresses.map((value) => String(value || '').trim()).filter(Boolean)
        : [];
      if (normalizedAddresses.length === 0) {
        throw new Error('At least one address is required');
      }
      return request(
        'getMultipleAccounts',
        buildMultipleAccountsParams(normalizedAddresses, requestOptions),
        requestOptions
      );
    },
    getTokenAccounts(filters, requestOptions = {}) {
      return request(
        'getTokenAccounts',
        buildTokenAccountsParams(filters),
        requestOptions
      );
    },
    updateWebhook(webhookId, payload, requestOptions = {}) {
      const id = String(webhookId || '').trim();
      if (!id) {
        throw new Error('Helius webhook ID is required');
      }
      return requestWebhookApi('PUT', `/v0/webhooks/${encodeURIComponent(id)}`, payload, requestOptions);
    },
  };
}

const defaultClient = createHeliusClient();

module.exports = {
  createHeliusClient,
  request: (...args) => defaultClient.request(...args),
  requestWebhookApi: (...args) => defaultClient.requestWebhookApi(...args),
  getAsset: (...args) => defaultClient.getAsset(...args),
  getTokenLargestAccounts: (...args) => defaultClient.getTokenLargestAccounts(...args),
  getTokenSupply: (...args) => defaultClient.getTokenSupply(...args),
  getMultipleAccounts: (...args) => defaultClient.getMultipleAccounts(...args),
  getTokenAccounts: (...args) => defaultClient.getTokenAccounts(...args),
  updateWebhook: (...args) => defaultClient.updateWebhook(...args),
  __private: {
    buildMultipleAccountsParams,
    buildTokenAccountsParams,
    buildRpcParams,
    buildRpcUrl,
    buildWebhookApiUrl,
    createChannelLimiter,
    createHeliusError,
    normalizeBaseUrl,
    parsePositiveInteger,
    resolveClientOptions,
    resolveMethodChannel,
    assignTrimmedString,
    sleep,
    toPositiveIntegerOrNull,
  },
};
