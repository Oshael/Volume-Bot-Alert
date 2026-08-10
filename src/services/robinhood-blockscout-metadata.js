const { normalizeTokenAddress } = require('../utils/token-identity');
const { normalizeText, sanitizeAssetUrl } = require('../utils/url-safety');

const DEFAULT_BASE_URL = 'https://robinhoodchain.blockscout.com/api/v2/tokens/';
const DEFAULT_ADDRESS_BASE_URL = 'https://robinhoodchain.blockscout.com/api/v2/addresses/';
const DEFAULT_API_URL = 'https://robinhoodchain.blockscout.com/api';
const DEFAULT_PRO_API_URL = 'https://api.blockscout.com/v2/api?chain_id=4663';
const DEFAULT_TIMEOUT_MS = 5000;

class RobinhoodBlockscoutMetadataError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'RobinhoodBlockscoutMetadataError';
    this.code = code;
    this.httpStatus = details.httpStatus ?? null;
    this.creditsRemaining = details.creditsRemaining ?? null;
    this.retryable = isRetryableProviderError(this);
  }
}

function boundedTimeout(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? Math.max(1000, Math.min(parsed, 15_000)) : DEFAULT_TIMEOUT_MS;
}

function isRetryableProviderError(error) {
  if (error?.code === 'timeout' || error?.code === 'transport_error') return true;
  return error?.code === 'http_error'
    && (error.httpStatus === 429 || Number(error.httpStatus) >= 500);
}

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

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
      await wait(Math.min(60_000, retryDelayMs * (2 ** retries)));
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

function createRobinhoodBlockscoutMetadataClient(options = {}) {
  const fetchImpl = options.fetchImpl || global.fetch;
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required');
  const baseUrl = new URL(String(options.baseUrl || DEFAULT_BASE_URL));
  const addressBaseUrl = new URL(String(options.addressBaseUrl || DEFAULT_ADDRESS_BASE_URL));
  const apiUrl = new URL(String(options.apiUrl || DEFAULT_API_URL));
  const apiKey = String(options.apiKey || '').trim();
  if (baseUrl.protocol !== 'https:') throw new TypeError('Blockscout metadata URL must use HTTPS');
  if (addressBaseUrl.protocol !== 'https:') throw new TypeError('Blockscout address URL must use HTTPS');
  if (apiUrl.protocol !== 'https:') throw new TypeError('Blockscout API URL must use HTTPS');
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
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      if (creditsRemaining === 0) {
        throw new RobinhoodBlockscoutMetadataError(
          'Blockscout daily API credits exhausted', 'credits_exhausted',
          { httpStatus: response.status, creditsRemaining }
        );
      }
      throw new RobinhoodBlockscoutMetadataError(
        `Blockscout ${resource} returned HTTP ${response.status}`,
        'http_error',
        { httpStatus: response.status, creditsRemaining }
      );
    }
    return response.json();
  }

  const request = (address, url, resource) => requestUrl(new URL(address, url), resource);

  async function getTokenMetadata(tokenAddress) {
    const address = normalizeTokenAddress('robinhood', tokenAddress);
    const payload = await request(address, baseUrl, 'metadata');
    if (!payload) {
      return Object.freeze({ address, available: false, symbol: null, name: null, imageUrl: null });
    }
    return normalizePayload(address, payload);
  }

  async function getContractCreator(tokenAddress) {
    const address = normalizeTokenAddress('robinhood', tokenAddress);
    const payload = await request(address, addressBaseUrl, 'address');
    if (!payload) return null;
    const responseAddress = normalizeTokenAddress('robinhood', payload.hash);
    if (responseAddress !== address) {
      throw new RobinhoodBlockscoutMetadataError(
        'Blockscout address response mismatch', 'address_mismatch'
      );
    }
    try {
      return normalizeTokenAddress('robinhood', payload.creator_address_hash);
    } catch (_) {
      return null;
    }
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
    getContractCreator, getContractCreators, getCreditsRemaining, getTokenMetadata,
  });
}

module.exports = {
  DEFAULT_BASE_URL,
  DEFAULT_ADDRESS_BASE_URL,
  DEFAULT_API_URL,
  DEFAULT_PRO_API_URL,
  DEFAULT_TIMEOUT_MS,
  RobinhoodBlockscoutMetadataError,
  createRobinhoodBlockscoutMetadataClient,
  requestWithRetry,
  __private: { boundedTimeout, isRetryableProviderError, normalizePayload },
};
