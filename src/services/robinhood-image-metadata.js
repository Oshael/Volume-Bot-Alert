const dexscreener = require('./dexscreener');
const { createRobinhoodBlockscoutMetadataClient } = require('./robinhood-blockscout-metadata');
const { decodeTextResult } = require('./evm-erc20-metadata');
const { classifyRobinhoodLaunchpad } = require('./robinhood-launchpad-attribution');
const { normalizeTokenAddress } = require('../utils/token-identity');
const { sanitizeAssetUrl } = require('../utils/url-safety');

const PONS_LOGO_SELECTOR = '0xfb7f21eb';
const TOKEN_URI_SELECTOR = '0x3c130d90';
const ROBINHOOD_CHAIN_ID = 4663;
const STOCK_ASSETS_URL = 'https://api.robinhood.com/rhj/assets';
const BANKR_TOKEN_FEES_URL = 'https://api.bankr.bot/public/doppler/token-fees/';
const DEFAULT_TIMEOUT_MS = 5000;
const STOCK_CACHE_TTL_MS = 60 * 60 * 1000;
const STOCK_FAILURE_RETRY_MS = 30 * 1000;
const MAX_METADATA_BYTES = 256 * 1024;

function timeoutMs(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? Math.max(1000, Math.min(parsed, 15_000)) : DEFAULT_TIMEOUT_MS;
}

async function fetchJson(fetchImpl, url, requestTimeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const declaredLength = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_METADATA_BYTES) return null;
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_METADATA_BYTES) return null;
    return JSON.parse(text);
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function ipfsGatewayUrl(uri) {
  const raw = String(uri || '').trim();
  if (!raw.startsWith('ipfs://')) return null;
  const path = raw.slice('ipfs://'.length).replace(/^\/+/, '');
  return path ? `https://ipfs.io/ipfs/${path}` : null;
}

function metadataImage(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const value = payload.image || payload.image_url || payload.image_hash;
  if (!value) return null;
  const raw = String(value).trim();
  return sanitizeAssetUrl(/^[A-Za-z0-9]+$/.test(raw) ? `ipfs://${raw}` : raw);
}

function isBankrDopplerToken(payload, address) {
  if (String(payload?.chain || '').trim().toLowerCase() !== 'robinhood') return false;
  return Array.isArray(payload.tokens) && payload.tokens.some((token) => {
    try {
      return String(token?.source || '').trim().toLowerCase() === 'doppler'
        && normalizeTokenAddress('robinhood', token.tokenAddress) === address;
    } catch (_) {
      return false;
    }
  });
}

function createRobinhoodImageMetadataResolver(options = {}) {
  if (typeof options.rpcClient?.request !== 'function') throw new Error('rpcClient.request is required');
  const rpcClient = options.rpcClient;
  const fetchImpl = options.fetchImpl || global.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required');
  const blockscout = options.blockscoutClient || createRobinhoodBlockscoutMetadataClient({ fetchImpl });
  const dex = options.dexClient || dexscreener;
  const now = options.now || Date.now;
  const requestTimeoutMs = timeoutMs(options.timeoutMs);
  let stockAssets = new Map();
  let stockExpiresAt = 0;
  let stockPending = null;

  async function readOnchainText(address, selector) {
    try {
      const encoded = await rpcClient.request(
        'eth_call', [{ to: address, data: selector }, 'latest'], { fallbackOnRpcError: true }
      );
      return decodeTextResult(encoded, selector);
    } catch (_) {
      return null;
    }
  }

  async function loadStockAssets() {
    if (stockExpiresAt > now()) return stockAssets;
    if (stockPending) return stockPending;
    stockPending = fetchJson(fetchImpl, STOCK_ASSETS_URL, requestTimeoutMs).then((payload) => {
      if (!Array.isArray(payload?.assets)) {
        stockExpiresAt = now() + STOCK_FAILURE_RETRY_MS;
        return stockAssets;
      }
      const next = new Map();
      for (const asset of payload.assets) {
        const imageUrl = sanitizeAssetUrl(asset.logoUrl);
        if (!imageUrl) continue;
        for (const deployment of asset.deployments || []) {
          if (Number(deployment.chainId) !== ROBINHOOD_CHAIN_ID) continue;
          try {
            next.set(normalizeTokenAddress('robinhood', deployment.contractAddress), imageUrl);
          } catch (_) {
            // Ignore malformed upstream deployments.
          }
        }
      }
      stockAssets = next;
      stockExpiresAt = now() + STOCK_CACHE_TTL_MS;
      return stockAssets;
    }).finally(() => { stockPending = null; });
    return stockPending;
  }

  async function resolveDexImage(address) {
    try {
      const data = await dex.getTokenPairs(address, { priority: 'dormant' });
      return sanitizeAssetUrl(dex.getBestPair(data, 'robinhood')?.info?.imageUrl);
    } catch (_) {
      return null;
    }
  }

  async function resolveLaunchpad(address, metadataSource) {
    if (metadataSource === 'pons-onchain' || metadataSource === 'robinhood-stock-api') {
      return classifyRobinhoodLaunchpad({ metadataSource }).id;
    }
    let bankrDopplerVerified = false;
    if (metadataSource === 'bankr-ipfs') {
      const payload = await fetchJson(
        fetchImpl, `${BANKR_TOKEN_FEES_URL}${address}?days=1`, requestTimeoutMs
      );
      bankrDopplerVerified = isBankrDopplerToken(payload, address);
      if (bankrDopplerVerified) {
        return classifyRobinhoodLaunchpad({ bankrDopplerVerified }).id;
      }
    }
    let creatorAddress = null;
    try {
      creatorAddress = await blockscout.getContractCreator?.(address) || null;
    } catch (_) {
      // Attribution failures must not block image enrichment.
    }
    return classifyRobinhoodLaunchpad({
      metadataSource, creatorAddress,
    }).id;
  }

  async function attributed(address, metadata) {
    return {
      ...metadata,
      launchpadId: await resolveLaunchpad(address, metadata.source),
    };
  }

  async function getTokenMetadata(tokenAddress) {
    const address = normalizeTokenAddress('robinhood', tokenAddress);
    const ponsImage = sanitizeAssetUrl(await readOnchainText(address, PONS_LOGO_SELECTOR));
    if (ponsImage) {
      return attributed(address, {
        address, available: true, imageUrl: ponsImage, source: 'pons-onchain',
      });
    }

    const stockImage = (await loadStockAssets()).get(address) || null;
    if (stockImage) {
      return attributed(address, {
        address, available: true, imageUrl: stockImage, source: 'robinhood-stock-api',
      });
    }

    const metadataUrl = ipfsGatewayUrl(await readOnchainText(address, TOKEN_URI_SELECTOR));
    const bankrImage = metadataImage(metadataUrl
      ? await fetchJson(fetchImpl, metadataUrl, requestTimeoutMs)
      : null);
    if (bankrImage) {
      return attributed(address, {
        address, available: true, imageUrl: bankrImage, source: 'bankr-ipfs',
      });
    }

    let blockscoutMetadata;
    let blockscoutError = null;
    try {
      blockscoutMetadata = await blockscout.getTokenMetadata(address);
    } catch (error) {
      blockscoutError = error;
      blockscoutMetadata = {
        address, available: false, symbol: null, name: null, imageUrl: null,
      };
    }
    if (blockscoutMetadata.imageUrl) {
      return attributed(address, { ...blockscoutMetadata, source: 'blockscout' });
    }

    const dexImage = await resolveDexImage(address);
    if (dexImage) {
      return attributed(address, {
        ...blockscoutMetadata, available: true, imageUrl: dexImage, source: 'dexscreener',
      });
    }
    if (blockscoutError) throw blockscoutError;
    return attributed(address, { ...blockscoutMetadata, imageUrl: null, source: null });
  }

  return Object.freeze({ getTokenMetadata });
}

module.exports = {
  PONS_LOGO_SELECTOR,
  BANKR_TOKEN_FEES_URL,
  ROBINHOOD_CHAIN_ID,
  STOCK_ASSETS_URL,
  TOKEN_URI_SELECTOR,
  createRobinhoodImageMetadataResolver,
  __private: { ipfsGatewayUrl, isBankrDopplerToken, metadataImage, timeoutMs },
};
