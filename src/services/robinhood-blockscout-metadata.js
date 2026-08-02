const { normalizeTokenAddress } = require('../utils/token-identity');
const { normalizeText, sanitizeAssetUrl } = require('../utils/url-safety');

const DEFAULT_BASE_URL = 'https://robinhoodchain.blockscout.com/api/v2/tokens/';
const DEFAULT_ADDRESS_BASE_URL = 'https://robinhoodchain.blockscout.com/api/v2/addresses/';
const DEFAULT_TIMEOUT_MS = 5000;

class RobinhoodBlockscoutMetadataError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'RobinhoodBlockscoutMetadataError';
    this.code = code;
    this.httpStatus = details.httpStatus ?? null;
  }
}

function boundedTimeout(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? Math.max(1000, Math.min(parsed, 15_000)) : DEFAULT_TIMEOUT_MS;
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
  if (baseUrl.protocol !== 'https:') throw new TypeError('Blockscout metadata URL must use HTTPS');
  if (addressBaseUrl.protocol !== 'https:') throw new TypeError('Blockscout address URL must use HTTPS');
  const timeoutMs = boundedTimeout(options.timeoutMs);

  async function request(address, url, resource) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(new URL(address, url), {
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
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new RobinhoodBlockscoutMetadataError(
        `Blockscout ${resource} returned HTTP ${response.status}`,
        'http_error',
        { httpStatus: response.status }
      );
    }
    return response.json();
  }

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

  return Object.freeze({ getContractCreator, getTokenMetadata });
}

module.exports = {
  DEFAULT_BASE_URL,
  DEFAULT_ADDRESS_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  RobinhoodBlockscoutMetadataError,
  createRobinhoodBlockscoutMetadataClient,
  __private: { boundedTimeout, normalizePayload },
};
