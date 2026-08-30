const { RULE_VERSION } = require('./robinhood-fresh-wallet-rule');

const ROBINHOOD_CHAIN_ID = 4663n;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CACHE_BLOCKS = 4096;
const MAX_DATE_MS = 8_640_000_000_000_000n;

function invalid(message) {
  const error = new Error(message);
  error.code = 'fresh_evidence_invalid';
  return error;
}

function quantity(value, label) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(normalized)) throw invalid(`${label} is invalid`);
  return BigInt(normalized);
}

function fixedHex(value, bytes, label) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`).test(normalized)) {
    throw invalid(`${label} is invalid`);
  }
  return normalized;
}

function address(value, label) {
  return fixedHex(value, 20, label);
}

function decimalQuantity(value, label) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized)) throw invalid(`${label} is invalid`);
  return BigInt(normalized).toString();
}

function blockTag(value) {
  return `0x${BigInt(value).toString(16)}`;
}

function instant(value, label) {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value ?? ''));
  if (!Number.isFinite(parsed)) throw invalid(`${label} is invalid`);
  return new Date(parsed).toISOString();
}

function parseBlock(block, expectedNumber) {
  const number = quantity(block?.number, 'block.number');
  if (number !== BigInt(expectedNumber)) throw invalid('RPC returned the wrong block');
  const timestampMs = quantity(block.timestamp, 'block.timestamp') * 1000n;
  if (timestampMs > MAX_DATE_MS) throw invalid('block.timestamp is unsafe');
  return Object.freeze({
    number: number.toString(),
    hash: fixedHex(block.hash, 32, 'block.hash'),
    blockTime: new Date(Number(timestampMs)).toISOString(),
  });
}

function normalizeFirstBuy(input = {}) {
  return Object.freeze({
    walletAddress: address(input.walletAddress, 'walletAddress'),
    transactionHash: fixedHex(input.transactionHash, 32, 'transactionHash'),
    blockNumber: decimalQuantity(input.blockNumber, 'blockNumber'),
    blockHash: fixedHex(input.blockHash, 32, 'blockHash'),
    blockTime: instant(input.blockTime, 'blockTime'),
  });
}

function resolveRobinhoodFreshWalletRpcProvider(env = process.env, kind = 'archive') {
  const archive = kind === 'archive';
  if (!archive && kind !== 'live') throw new Error('FRESH RPC kind must be archive or live');
  const variable = archive ? 'RH_NODE_RPC_URL' : 'ROBINHOOD_RPC_URL';
  const url = String(env[variable] || '').trim();
  if (!url) throw Object.assign(new Error(`${variable} is required for FRESH`), {
    code: 'configuration_error', fatal: true,
  });
  return Object.freeze({ name: archive ? 'robinhood-pc-archive' : 'robinhood-live', url });
}

function createRobinhoodFreshWalletRpcSource(options = {}) {
  const rpcClient = options.rpcClient;
  if (typeof rpcClient?.request !== 'function') throw new TypeError('FRESH RPC client is required');
  const source = String(options.source || '').trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(source)) throw new TypeError('FRESH RPC source is invalid');
  const now = options.now || (() => new Date());
  const maxCacheBlocks = Number(options.maxCacheBlocks ?? DEFAULT_CACHE_BLOCKS);
  if (!Number.isSafeInteger(maxCacheBlocks) || maxCacheBlocks < 16 || maxCacheBlocks > 65536) {
    throw new TypeError('maxCacheBlocks must be between 16 and 65536');
  }
  const cache = new Map();
  let chainValidation = null;

  async function validateChain() {
    chainValidation ||= Promise.resolve(rpcClient.request('eth_chainId')).then((value) => {
      if (quantity(value, 'eth_chainId') !== ROBINHOOD_CHAIN_ID) {
        throw Object.assign(new Error('FRESH RPC is not Robinhood Chain'), {
          code: 'configuration_error', fatal: true,
        });
      }
    }).catch((error) => { chainValidation = null; throw error; });
    return chainValidation;
  }

  async function cachedBlock(number) {
    const key = BigInt(number).toString();
    if (cache.has(key)) return cache.get(key);
    const pending = rpcClient.request('eth_getBlockByNumber', [blockTag(key), false])
      .then((block) => parseBlock(block, key));
    cache.set(key, pending);
    try {
      const block = await pending;
      while (cache.size > maxCacheBlocks) cache.delete(cache.keys().next().value);
      return block;
    } catch (error) {
      cache.delete(key);
      throw error;
    }
  }

  async function resolveCutoff(targetAt, upperBlock) {
    const targetMs = Date.parse(targetAt);
    let low = 0n;
    let high = BigInt(upperBlock.number) - 1n;
    let cutoff = null;
    while (low <= high) {
      const middle = (low + high) / 2n;
      const block = await cachedBlock(middle);
      if (Date.parse(block.blockTime) < targetMs) {
        cutoff = block;
        low = middle + 1n;
      } else high = middle - 1n;
    }
    if (!cutoff) throw invalid('24-hour cutoff predates the canonical chain');
    const nextBlock = await cachedBlock(BigInt(cutoff.number) + 1n);
    if (Date.parse(nextBlock.blockTime) < targetMs) throw invalid('cutoff resolution is incomplete');
    return { cutoff, nextBlock };
  }

  async function readEvidence(input = {}) {
    const firstBuy = normalizeFirstBuy(input);
    await validateChain();
    const [transaction, firstBuyBlock] = await Promise.all([
      rpcClient.request('eth_getTransactionByHash', [firstBuy.transactionHash]),
      rpcClient.request('eth_getBlockByNumber', [blockTag(firstBuy.blockNumber), false])
        .then((block) => parseBlock(block, firstBuy.blockNumber)),
    ]);
    if (!transaction) throw invalid('first-buy transaction is unavailable');
    const transactionHash = fixedHex(transaction.hash, 32, 'transaction.hash');
    const transactionFrom = address(transaction.from, 'transaction.from');
    const transactionBlock = quantity(transaction.blockNumber, 'transaction.blockNumber');
    const transactionBlockHash = fixedHex(transaction.blockHash, 32, 'transaction.blockHash');
    if (transactionHash !== firstBuy.transactionHash || transactionFrom !== firstBuy.walletAddress
        || transactionBlock.toString() !== firstBuy.blockNumber
        || transactionBlockHash !== firstBuy.blockHash
        || firstBuyBlock.hash !== firstBuy.blockHash
        || firstBuyBlock.blockTime !== firstBuy.blockTime) {
      throw invalid('first-buy evidence is not canonical');
    }
    const cutoffAt = new Date(Date.parse(firstBuy.blockTime) - DAY_MS).toISOString();
    const { cutoff, nextBlock } = await resolveCutoff(cutoffAt, firstBuyBlock);
    const cutoffNonce = quantity(await rpcClient.request('eth_getTransactionCount', [
      firstBuy.walletAddress, { blockHash: cutoff.hash, requireCanonical: true },
    ]), 'cutoffNonce');
    const firstBuyNonce = quantity(transaction.nonce, 'transaction.nonce');
    if (cutoffNonce > firstBuyNonce) throw invalid('historical nonce exceeds first-buy nonce');
    return Object.freeze({
      ruleVersion: RULE_VERSION,
      source,
      observedAt: instant(now(), 'observedAt'),
      firstBuy: Object.freeze({ ...firstBuy, nonce: firstBuyNonce.toString() }),
      cutoff: Object.freeze({ targetAt: cutoffAt, ...cutoff, nonce: cutoffNonce.toString() }),
      nextBlock,
    });
  }

  return Object.freeze({ readEvidence });
}

module.exports = {
  createRobinhoodFreshWalletRpcSource,
  resolveRobinhoodFreshWalletRpcProvider,
  __private: { parseBlock },
};
