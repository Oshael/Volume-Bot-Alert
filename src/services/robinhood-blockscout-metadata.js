const { normalizeTokenAddress } = require('../utils/token-identity');
const { normalizeText, sanitizeAssetUrl } = require('../utils/url-safety');

const DEFAULT_BASE_URL = 'https://robinhoodchain.blockscout.com/api/v2/tokens/';
const DEFAULT_ADDRESS_BASE_URL = 'https://robinhoodchain.blockscout.com/api/v2/addresses/';
const DEFAULT_TRANSACTION_BASE_URL = 'https://robinhoodchain.blockscout.com/api/v2/transactions/';
const DEFAULT_API_URL = 'https://robinhoodchain.blockscout.com/api';
const DEFAULT_PRO_API_URL = 'https://api.blockscout.com/v2/api?chain_id=4663';
const DEFAULT_TIMEOUT_MS = 5000;
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;

class RobinhoodBlockscoutMetadataError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'RobinhoodBlockscoutMetadataError';
    this.code = code;
    this.httpStatus = details.httpStatus ?? null;
    this.creditsRemaining = details.creditsRemaining ?? null;
    this.retryAfterMs = details.retryAfterMs ?? null;
    this.retryable = isRetryableProviderError(this);
  }
}

function boundedTimeout(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? Math.max(1000, Math.min(parsed, 60_000)) : DEFAULT_TIMEOUT_MS;
}

function isRetryableProviderError(error) {
  if (error?.code === 'timeout' || error?.code === 'transport_error') return true;
  return error?.code === 'http_error'
    && (error.httpStatus === 429 || Number(error.httpStatus) >= 500);
}

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function parseRetryAfterMs(value, now = Date.now()) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

async function requestWithRetry(operation, options = {}, wait = delay) {
  const requestRetries = Number.isSafeInteger(options.requestRetries) ? options.requestRetries : 2;
  const retryDelayMs = Number.isSafeInteger(options.retryDelayMs) ? options.retryDelayMs : 500;
  let retries = 0;
  for (;;) {
    try {
      return { value: await operation(), retries };
    } catch (error) {
      if (!isRetryableProviderError(error) || retries >= requestRetries) {
        error.requestRetriesUsed = retries;
        throw error;
      }
      const backoffMs = retryDelayMs * (2 ** retries);
      const retryAfterMs = Number.isFinite(error.retryAfterMs) ? error.retryAfterMs : 0;
      await wait(Math.min(60_000, Math.max(backoffMs, retryAfterMs)));
      retries += 1;
    }
  }
}

function normalizePayload(address, payload) {
  if (!payload || typeof payload !== 'object') {
    throw new RobinhoodBlockscoutMetadataError('Blockscout token response is invalid', 'invalid_response');
  }
  const responseAddress = normalizeTokenAddress('robinhood', payload.address_hash);
  if (responseAddress !== address) {
    throw new RobinhoodBlockscoutMetadataError('Blockscout token address mismatch', 'address_mismatch');
  }
  return Object.freeze({
    address,
    available: true,
    symbol: normalizeText(payload.symbol, 64),
    name: normalizeText(payload.name, 128),
    imageUrl: sanitizeAssetUrl(payload.icon_url),
    decimals: /^\d+$/.test(String(payload.decimals ?? '')) ? Number(payload.decimals) : null,
    reputation: normalizeText(payload.reputation, 32),
  });
}

const INTERNAL_TRACE_ADAPTERS = Object.freeze({
  native: Object.freeze({
    failed: (item) => item?.success === false,
    created: (item) => item?.created_contract?.hash,
    hash: (item) => item?.transaction_hash,
    factory: (item) => item?.from?.hash || item?.from,
    hashRequired: false,
    label: '',
  }),
  legacy: Object.freeze({
    failed: (item) => String(item?.isError ?? '0') !== '0',
    created: (item) => item?.contractAddress,
    hash: (item) => item?.transactionHash || item?.hash,
    factory: (item) => item?.from,
    hashRequired: true,
    label: 'legacy ',
  }),
});

function normalizeCreatedAddress(value) {
  try { return normalizeTokenAddress('robinhood', value); }
  catch (_) { return null; }
}

function internalCreationFromItem(item, hint, adapter) {
  if (!['create', 'create2'].includes(String(item?.type || '').toLowerCase())) return null;
  if (adapter.failed(item)) return null;
  if (normalizeCreatedAddress(adapter.created(item)) !== hint.tokenAddress) return null;
  const itemHash = String(adapter.hash(item) ?? '').trim().toLowerCase();
  if ((adapter.hashRequired || itemHash) && itemHash !== hint.transactionHash) {
    throw new RobinhoodBlockscoutMetadataError(
      `Blockscout ${adapter.label}internal transaction hash mismatch`, 'transaction_mismatch'
    );
  }
  let factoryAddress;
  try { factoryAddress = normalizeTokenAddress('robinhood', adapter.factory(item)); }
  catch (_) { throw new RobinhoodBlockscoutMetadataError(
    'Blockscout internal creation factory is invalid', 'invalid_response'
  ); }
  return Object.freeze({ ...hint, factoryAddress });
}

function findInternalCreation(items, hint, legacy = false) {
  const adapter = legacy ? INTERNAL_TRACE_ADAPTERS.legacy : INTERNAL_TRACE_ADAPTERS.native;
  for (const item of items) {
    const creation = internalCreationFromItem(item, hint, adapter);
    if (creation) return creation;
  }
  return null;
}

function findMintCreation(items, tokenAddress) {
  for (const item of items) {
    if (normalizeCreatedAddress(item?.contractAddress) !== tokenAddress) continue;
    if (normalizeCreatedAddress(item?.from) !== ZERO_ADDRESS) continue;
    const transactionHash = String(item?.hash ?? '').trim().toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(transactionHash)) continue;
    const creatorAddress = normalizeCreatedAddress(item?.to);
    if (!creatorAddress || creatorAddress === ZERO_ADDRESS) continue;
    return Object.freeze({ tokenAddress, creatorAddress, transactionHash });
  }
  return null;
}

function findBlockCreation(items, tokenAddress) {
  for (const item of items) {
    if (!['create', 'create2'].includes(String(item?.type || '').toLowerCase())) continue;
    if (String(item?.isError ?? '0') !== '0') continue;
    if (normalizeCreatedAddress(item?.contractAddress) !== tokenAddress) continue;
    const transactionHash = String(item?.transactionHash || item?.hash || '').trim().toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(transactionHash)) continue;
    const creatorAddress = normalizeCreatedAddress(item?.from);
    if (!creatorAddress) continue;
    return Object.freeze({ tokenAddress, creatorAddress, transactionHash });
  }
  return null;
}

function createRobinhoodBlockscoutMetadataClient(options = {}) {
  const fetchImpl = options.fetchImpl || global.fetch;
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required');
  const baseUrl = new URL(String(options.baseUrl || DEFAULT_BASE_URL));
  const addressBaseUrl = new URL(String(options.addressBaseUrl || DEFAULT_ADDRESS_BASE_URL));
  const transactionBaseUrl = new URL(String(
    options.transactionBaseUrl || DEFAULT_TRANSACTION_BASE_URL
  ));
  const apiUrl = new URL(String(options.apiUrl || DEFAULT_API_URL));
  const legacyApiUrl = new URL(String(options.legacyApiUrl || DEFAULT_API_URL));
  const apiKey = String(options.apiKey || '').trim();
  if (baseUrl.protocol !== 'https:') throw new TypeError('Blockscout metadata URL must use HTTPS');
  if (addressBaseUrl.protocol !== 'https:') throw new TypeError('Blockscout address URL must use HTTPS');
  if (transactionBaseUrl.protocol !== 'https:') {
    throw new TypeError('Blockscout transaction URL must use HTTPS');
  }
  if (apiUrl.protocol !== 'https:') throw new TypeError('Blockscout API URL must use HTTPS');
  if (legacyApiUrl.protocol !== 'https:') throw new TypeError('Blockscout legacy API URL must use HTTPS');
  const timeoutMs = boundedTimeout(options.timeoutMs);
  let minimumCreditsRemaining = null;

  function trackCredits(response) {
    const raw = response.headers?.get?.('x-credits-remaining');
    if (!/^\d+$/.test(String(raw ?? ''))) return null;
    const remaining = Number(raw);
    minimumCreditsRemaining = minimumCreditsRemaining == null
      ? remaining
      : Math.min(minimumCreditsRemaining, remaining);
    return remaining;
  }

  async function requestUrl(url, resource) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(url, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
    } catch (error) {
      const timedOut = error?.name === 'AbortError';
      throw new RobinhoodBlockscoutMetadataError(
        timedOut ? `Blockscout ${resource} request timed out` : `Blockscout ${resource} request failed`,
        timedOut ? 'timeout' : 'transport_error'
      );
    } finally {
      clearTimeout(timeout);
    }
    const creditsRemaining = trackCredits(response);
    const retryAfterMs = parseRetryAfterMs(response.headers?.get?.('retry-after'));
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      if (creditsRemaining === 0) {
        throw new RobinhoodBlockscoutMetadataError(
          'Blockscout daily API credits exhausted', 'credits_exhausted',
          { httpStatus: response.status, creditsRemaining, retryAfterMs }
        );
      }
      throw new RobinhoodBlockscoutMetadataError(
        `Blockscout ${resource} returned HTTP ${response.status}`,
        'http_error',
        { httpStatus: response.status, creditsRemaining, retryAfterMs }
      );
    }
    return response.json();
  }

  const request = (address, url, resource) => requestUrl(new URL(address, url), resource);
  const legacyUrl = () => {
    const url = new URL(legacyApiUrl);
    if (apiKey) url.searchParams.set('apikey', apiKey);
    return url;
  };

  async function getTokenMetadata(tokenAddress) {
    const address = normalizeTokenAddress('robinhood', tokenAddress);
    const payload = await request(address, baseUrl, 'metadata');
    if (!payload) {
      return Object.freeze({ address, available: false, symbol: null, name: null, imageUrl: null });
    }
    return normalizePayload(address, payload);
  }

  async function getContractCreation(tokenAddress) {
    const address = normalizeTokenAddress('robinhood', tokenAddress);
    let payload;
    try { payload = await request(address, addressBaseUrl, 'address'); }
    catch (error) {
      if (!isRetryableProviderError(error)) throw error;
      const url = legacyUrl();
      url.searchParams.set('module', 'account');
      url.searchParams.set('action', 'tokentx');
      url.searchParams.set('contractaddress', address);
      url.searchParams.set('page', '1');
      url.searchParams.set('offset', '10');
      url.searchParams.set('sort', 'asc');
      const fallback = await requestUrl(url, 'legacy creation mint');
      if (!fallback || !Array.isArray(fallback.result)) {
        throw new RobinhoodBlockscoutMetadataError(
          'Blockscout legacy creation mint response is invalid', 'invalid_response'
        );
      }
      return findMintCreation(fallback.result, address);
    }
    if (!payload) return null;
    const responseAddress = normalizeTokenAddress('robinhood', payload.hash);
    if (responseAddress !== address) {
      throw new RobinhoodBlockscoutMetadataError(
        'Blockscout address response mismatch', 'address_mismatch'
      );
    }
    let creatorAddress = null;
    try { creatorAddress = normalizeTokenAddress('robinhood', payload.creator_address_hash); }
    catch (_) {}
    const rawTransactionHash = String(payload.creation_transaction_hash ?? '').trim().toLowerCase();
    const transactionHash = /^0x[0-9a-f]{64}$/.test(rawTransactionHash)
      ? rawTransactionHash
      : null;
    return Object.freeze({ tokenAddress: address, creatorAddress, transactionHash });
  }

  async function getContractCreator(tokenAddress) {
    return (await getContractCreation(tokenAddress))?.creatorAddress || null;
  }

  async function getNativeInternalCreation(hint) {
    let url = new URL(`${hint.transactionHash}/internal-transactions`, transactionBaseUrl);
    for (let page = 0; page < 20; page += 1) {
      const payload = await requestUrl(url, 'transaction internal trace');
      if (payload == null) return null;
      if (!Array.isArray(payload.items)) throw new RobinhoodBlockscoutMetadataError(
        'Blockscout internal transaction response is invalid', 'invalid_response'
      );
      const creation = findInternalCreation(payload.items, hint);
      if (creation) return creation;
      const next = payload.next_page_params;
      if (!next || typeof next !== 'object') return null;
      url = new URL(url);
      for (const [key, value] of Object.entries(next)) url.searchParams.set(key, value);
    }
    throw new RobinhoodBlockscoutMetadataError(
      'Blockscout internal transaction pagination exceeded its bound', 'invalid_response'
    );
  }

  async function getLegacyInternalCreation(hint) {
    const url = legacyUrl();
    url.searchParams.set('module', 'account');
    url.searchParams.set('action', 'txlistinternal');
    url.searchParams.set('txhash', hint.transactionHash);
    const payload = await requestUrl(url, 'legacy transaction internal trace');
    if (!payload || !Array.isArray(payload.result)) throw new RobinhoodBlockscoutMetadataError(
      'Blockscout legacy internal transaction response is invalid', 'invalid_response'
    );
    return findInternalCreation(payload.result, hint, true);
  }

  async function getInternalContractCreation(transactionHash, tokenAddress) {
    const hash = String(transactionHash ?? '').trim().toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(hash)) throw new TypeError('transaction hash is invalid');
    const hint = Object.freeze({
      tokenAddress: normalizeTokenAddress('robinhood', tokenAddress), transactionHash: hash,
    });
    try { return await getNativeInternalCreation(hint); }
    catch (error) {
      if (!isRetryableProviderError(error)) throw error;
      return getLegacyInternalCreation(hint);
    }
  }

  async function getContractCreationAtBlock(tokenAddress, blockNumber) {
    const address = normalizeTokenAddress('robinhood', tokenAddress);
    const block = BigInt(String(blockNumber)).toString();
    const url = legacyUrl();
    url.searchParams.set('module', 'account');
    url.searchParams.set('action', 'txlistinternal');
    url.searchParams.set('address', address);
    url.searchParams.set('startblock', block);
    url.searchParams.set('endblock', block);
    url.searchParams.set('page', '1');
    url.searchParams.set('offset', '100');
    url.searchParams.set('sort', 'asc');
    url.searchParams.set('include_zero_value', 'true');
    const payload = await requestUrl(url, 'deployment block internal transactions');
    if (!payload || !Array.isArray(payload.result)) throw new RobinhoodBlockscoutMetadataError(
      'Blockscout deployment block internal transaction response is invalid', 'invalid_response'
    );
    return findBlockCreation(payload.result, address);
  }

  async function getContractCreators(tokenAddresses) {
    if (!Array.isArray(tokenAddresses) || tokenAddresses.length < 1 || tokenAddresses.length > 10) {
      throw new TypeError('Blockscout creator batch must contain 1..10 token addresses');
    }
    const addresses = [...new Set(tokenAddresses.map((value) => (
      normalizeTokenAddress('robinhood', value)
    )))];
    const url = new URL(apiUrl);
    url.searchParams.set('module', 'contract');
    url.searchParams.set('action', 'getcontractcreation');
    url.searchParams.set('contractaddresses', addresses.join(','));
    if (apiKey) url.searchParams.set('apikey', apiKey);
    const payload = await requestUrl(url, 'contract creation');
    if (!payload || payload.status !== '1' || !Array.isArray(payload.result)) {
      throw new RobinhoodBlockscoutMetadataError(
        'Blockscout contract creation response is invalid', 'invalid_response'
      );
    }
    const creators = new Map();
    for (const item of payload.result) {
      let tokenAddress;
      try { tokenAddress = normalizeTokenAddress('robinhood', item?.contractAddress); }
      catch (_) { continue; }
      if (!addresses.includes(tokenAddress)) continue;
      let creatorAddress = null;
      try { creatorAddress = normalizeTokenAddress('robinhood', item?.contractCreator); }
      catch (_) {}
      const rawTransactionHash = String(item?.txHash ?? '').trim().toLowerCase();
      const transactionHash = /^0x[0-9a-f]{64}$/.test(rawTransactionHash)
        ? rawTransactionHash
        : null;
      creators.set(tokenAddress, { creatorAddress, transactionHash });
    }
    const unresolved = Object.freeze({ creatorAddress: null, transactionHash: null });
    return Object.freeze(addresses.map((tokenAddress) => Object.freeze({
      tokenAddress, ...(creators.get(tokenAddress) || unresolved),
    })));
  }

  const getCreditsRemaining = () => minimumCreditsRemaining;
  return Object.freeze({
    getContractCreation, getContractCreationAtBlock, getContractCreator, getContractCreators,
    getCreditsRemaining, getInternalContractCreation, getTokenMetadata,
  });
}

module.exports = {
  DEFAULT_BASE_URL,
  DEFAULT_ADDRESS_BASE_URL,
  DEFAULT_TRANSACTION_BASE_URL,
  DEFAULT_API_URL,
  DEFAULT_PRO_API_URL,
  DEFAULT_TIMEOUT_MS,
  RobinhoodBlockscoutMetadataError,
  createRobinhoodBlockscoutMetadataClient,
  requestWithRetry,
  __private: {
    boundedTimeout, isRetryableProviderError, normalizePayload, parseRetryAfterMs,
  },
};
